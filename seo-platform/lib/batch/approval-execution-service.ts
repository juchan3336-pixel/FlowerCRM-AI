import "server-only"

// 승인 Batch 자동 실행 v1 — 오케스트레이션 (PR-B).
// activate/tick 모드를 처리하고 기존 generation-batch-service를 그대로 재사용한다.
// generation-runner를 복제하지 않는다 — item 처리·품질·retry·비용 상한·이벤트는 전부 기존 경로.
// HTTP 배선·환경 게이트·self-chain fetch는 app/api/batch/execute/route.ts가 담당한다.
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import { processNextGenerationItem, startGenerationBatch } from "./generation-batch-service"
import { computeApprovalSnapshotHash, hashActivationToken, isApprovalExpired } from "./approval-policy"
import { isTickWithinLimit, type ExecuteOutcome } from "./approval-execution-policy"
import { createSupabaseApprovalRepository } from "./supabase-approval-repository"
import { createSupabaseBatchRepository } from "./supabase-batch-repository"
import type { BatchApprovalRow, BatchRunItemRow, Json } from "@/types/database"

export type NextTick = { readonly approvalId: string; readonly tick: number }

export type ExecuteResult = {
  readonly outcome: ExecuteOutcome
  // 존재하면 route가 chain token을 만들어 after()로 self-fetch를 예약한다.
  readonly nextTick: NextTick | null
}

const CLAIMABLE: readonly string[] = ["queued", "interrupted"]

// ── activate ─────────────────────────────────────────────────────
export async function executeActivate(input: Readonly<{ activationToken: string; nowIso: string; previewDeploymentSha: string | null }>): Promise<ExecuteResult> {
  const approvals = createSupabaseApprovalRepository()
  const tokenHash = hashActivationToken(input.activationToken)
  const approval = await approvals.findApprovalByTokenHash(tokenHash)
  if (approval === null) {
    return noChain({ kind: "unauthorized", reason: "invalid-token" })
  }
  if (approval.status === "completed" || approval.status === "failed" || approval.status === "cancelled") {
    return noChain({ kind: "conflict", reason: "not-activatable" })
  }
  if (isApprovalExpired(approval.approval_expires_at, input.nowIso)) {
    await approvals.expireApproval(approval.id)
    return noChain({ kind: "expired" })
  }

  // kick 발사 표시 — 이후 pre-flight 실패를 queued→failed로 남길 수 있게 한다 (approved에서만 전이).
  await approvals.markQueued(approval.id)

  // pre-flight: 승인 스냅샷 전체 재검증 (승인 후 장소 변경 감지). 실패 시 토큰 미소진으로 queued→failed.
  const preflight = await verifyAllSnapshots(approval)
  if (preflight !== null) {
    await approvals.failApproval(approval.id, { code: "preflight", message: `preflight-${preflight}` })
    return noChain({ kind: "conflict", reason: `preflight-${preflight}` })
  }

  // 원자 소진 — approved|queued ∧ 미소진 ∧ 미연결 ∧ 미만료 → running + consumed_at.
  const activated = await approvals.activateApproval({ executionTokenHash: tokenHash, nowIso: input.nowIso })
  if (activated === null) {
    // 이미 소진·연결됐거나 동시 활성화 경합에서 패배 — 재사용 차단.
    return noChain({ kind: "conflict", reason: "already-consumed" })
  }

  // 기존 생성 배치 시작 — 스냅샷 placeIds만 사용한다 (요청 본문 신뢰 안 함).
  // 승인 시 확정된 approved_max_cost_usd를 실행 비용 상한으로 넘긴다 (계획: 추정 초과 시 cost-limit 거부, 실행: 누적 도달 시 잔여 skip).
  const started = await startGenerationBatch({
    placeIds: approval.approved_place_ids,
    createdBy: approval.approved_by,
    officialCheckApproved: true,
    maxCostUsd: approval.approved_max_cost_usd,
  })
  if (started.kind !== "started") {
    // 보상 전이: running→failed. 토큰은 소진 유지 → 자동 재활성화 금지, 새 승인 필요.
    const reason = started.kind === "already-running" ? "already-running" : `invalid-${started.plan.reason}`
    await approvals.failApproval(activated.id, { code: "start-failed", message: `start-failed:${reason}` })
    return noChain({ kind: "conflict", reason: `start-failed:${reason}` })
  }

  const linked = await approvals.linkBatchRun(activated.id, started.batchId)
  if (linked === null) {
    // running이 아니거나(그 사이 취소) 이미 연결 — 취소면 run도 정리한다.
    const current = await approvals.findApprovalById(activated.id)
    if (current?.status === "cancelled") {
      const { cancelGenerationBatch } = await import("./generation-batch-service")
      await cancelGenerationBatch(started.batchId, approval.approved_by)
      return noChain({ kind: "conflict", reason: "cancelled" })
    }
    return noChain({ kind: "conflict", reason: "link-failed" })
  }

  // PR-D — activate는 여기서 끝난다: 접수(batch 생성·연결)까지만 하고 즉시 202를 돌려준다.
  // item 처리를 이 요청 안에서 끝내면 생성 시간(수십 초)이 호출자 timeout을 넘겨 성공한 실행이
  // "연결 실패"로 오분류되고 승인이 잘못 취소된다. 첫 item은 아래 tick=0 self-chain이 처리한다.
  // execution_tick CAS(0→1)도 그 tick 요청에서 수행하므로 여기서는 전진시키지 않는다.
  return { outcome: { kind: "accepted", approvalStatus: "running" }, nextTick: { approvalId: activated.id, tick: 0 } }
}

// ── tick ─────────────────────────────────────────────────────────
// Chain token 검증은 route에서 수행하고, 여기서는 상태·CAS·스냅샷·처리를 담당한다.
export async function executeTick(input: Readonly<{ approvalId: string; tick: number; nowIso: string; previewDeploymentSha: string | null }>): Promise<ExecuteResult> {
  const approvals = createSupabaseApprovalRepository()
  const approval = await approvals.findApprovalById(input.approvalId)
  if (approval === null) {
    return noChain({ kind: "unauthorized", reason: "unknown-approval" })
  }
  // 종료 상태 승인은 다음 tick no-op (완료·실패·취소 후 재호출 무해 처리).
  if (approval.status === "completed" || approval.status === "failed" || approval.status === "cancelled" || approval.status === "expired") {
    return noChain({ kind: "noop", reason: `terminal-${approval.status}` })
  }
  if (approval.status !== "running" || approval.batch_run_id === null) {
    return noChain({ kind: "conflict", reason: "not-running" })
  }
  if (!isTickWithinLimit(input.tick, approval.approved_place_ids.length)) {
    return noChain({ kind: "conflict", reason: "tick-limit" })
  }

  // batch_run이 이미 끝났으면 approval을 그 결과에 맞춰 수렴시킨다 (PR-D: 무조건 completed로 닫지 않는다).
  const batchRepo = createSupabaseBatchRepository()
  const run = await batchRepo.getRun(approval.batch_run_id)
  if (run !== null && run.status !== "running") {
    return noChain(await convergeApprovalToRun(approvals, approval.id, run.status))
  }

  // expected tick CAS — 중복·지연 tick은 여기서 no-op으로 흡수된다.
  const advanced = await approvals.advanceExecutionTick({ approvalId: approval.id, expectedTick: input.tick, nowIso: input.nowIso, previewDeploymentSha: input.previewDeploymentSha })
  if (!advanced) {
    return noChain({ kind: "noop", reason: "duplicate-tick" })
  }

  return runOneStep({
    approvalId: approval.id,
    batchId: approval.batch_run_id,
    currentTick: input.tick + 1,
    snapshotMap: parseSnapshotHashMap(approval.approval_snapshot),
    nowIso: input.nowIso,
  })
}

// ── 공통: 스냅샷 가드 + 1건 처리 + 완료/체인 판정 ─────────────────
// 한 호출당 정확히 item 1건만 처리하고, 처리 후 잔여 claimable이 없으면 즉시 완료로 수렴한다
// (1건 Batch는 추가 tick 없이 이 호출에서 completed). 잔여가 있으면 다음 tick을 예약한다.
async function runOneStep(
  input: Readonly<{ approvalId: string; batchId: string; currentTick: number; snapshotMap: Map<string, string>; nowIso: string }>,
): Promise<ExecuteResult> {
  const approvals = createSupabaseApprovalRepository()
  const batchRepo = createSupabaseBatchRepository()

  // 장시간 멈춘 processing은 interrupted로 표시 (기존 stale 처리 재사용) — 재개 정합.
  await batchRepo.markStaleItemsInterrupted(input.batchId, input.nowIso)

  const items = await batchRepo.listItems(input.batchId)
  const next = nextClaimable(items)

  if (next === undefined) {
    // 남은 claimable 없음 — processNextGenerationItem이 run을 completed로 닫고 done=true.
    const result = await processNextGenerationItem(input.batchId, { trigger: "auto" })
    return result.done ? await completeAndReturn(approvals, input.approvalId) : chainTo(input)
  }

  // 다음 item의 스냅샷 재검증 — 불일치면 그 item만 failed(snapshot-mismatch)로 건너뛴다.
  if (await isSnapshotMismatch(next, input.snapshotMap)) {
    const claimed = await batchRepo.claimNextItem(input.batchId, "generate", "checking", { trigger: "auto" })
    if (claimed !== null) {
      await batchRepo.recordItemResult(claimed.id, {
        status: "failed",
        currentStep: null,
        lastErrorCode: "snapshot-mismatch",
        lastErrorMessage: "승인 스냅샷과 장소 정보가 달라 자동 생성을 건너뜀",
        finished: true,
      })
    }
  } else {
    // 정상 — 기존 경로로 1건 처리 (비용 상한·retry·품질·이벤트 전부 재사용).
    await processNextGenerationItem(input.batchId, { trigger: "auto" })
  }

  // 처리 직후 잔여 claimable 확인 — 없으면 run 마감 + 승인 완료를 이 호출에서 끝낸다.
  const remaining = nextClaimable(await batchRepo.listItems(input.batchId))
  if (remaining === undefined) {
    const finalize = await processNextGenerationItem(input.batchId, { trigger: "auto" })
    if (finalize.done) {
      return completeAndReturn(approvals, input.approvalId)
    }
  }
  return chainTo(input)
}

function nextClaimable(items: readonly BatchRunItemRow[]): BatchRunItemRow | undefined {
  return [...items].filter((item) => CLAIMABLE.includes(item.status)).sort((a, b) => a.sequence - b.sequence)[0]
}

async function completeAndReturn(approvals: ReturnType<typeof createSupabaseApprovalRepository>, approvalId: string): Promise<ExecuteResult> {
  await approvals.completeApproval(approvalId)
  return noChain({ kind: "completed", approvalStatus: "completed" })
}

// PR-D — approval은 연결된 batch_run의 최종 상태를 그대로 따라간다.
// (예전에는 run이 failed/cancelled여도 approval을 completed로 닫아 기록이 사실과 어긋났다.)
async function convergeApprovalToRun(
  approvals: ReturnType<typeof createSupabaseApprovalRepository>,
  approvalId: string,
  runStatus: string,
): Promise<ExecuteOutcome> {
  if (runStatus === "failed") {
    await approvals.failApproval(approvalId, { code: "run-failed", message: "run-failed" })
    return { kind: "conflict", reason: "run-failed" }
  }
  if (runStatus === "cancelled") {
    await approvals.cancelApproval(approvalId)
    return { kind: "conflict", reason: "run-cancelled" }
  }
  await approvals.completeApproval(approvalId)
  return { kind: "completed", approvalStatus: "completed" }
}

function chainTo(input: Readonly<{ approvalId: string; currentTick: number }>): ExecuteResult {
  return { outcome: { kind: "processed", done: false, approvalStatus: "running" }, nextTick: { approvalId: input.approvalId, tick: input.currentTick } }
}

// 승인 스냅샷 전체 재검증 — 불일치 사유 문자열 또는 null(전부 일치).
async function verifyAllSnapshots(approval: BatchApprovalRow): Promise<string | null> {
  const snapshotMap = parseSnapshotHashMap(approval.approval_snapshot)
  const client = createSupabaseServiceRoleClient()
  for (const placeId of approval.approved_place_ids) {
    const expected = snapshotMap.get(placeId)
    if (expected === undefined) {
      return "snapshot-missing"
    }
    const { data: place } = await client.from("places").select("id, name, address, phone, slug, status, official_verification_status").eq("id", placeId).maybeSingle()
    if (place === null) {
      return "place-missing"
    }
    if (place.status !== "draft") {
      return "not-draft"
    }
    if (place.official_verification_status !== "verified") {
      return "not-verified"
    }
    const { count: genCount } = await client.from("ai_generations").select("id", { count: "exact", head: true }).eq("place_id", placeId)
    if ((genCount ?? 0) > 0) {
      return "has-generation"
    }
    const { data: seo } = await client.from("seo_pages").select("id").eq("page_type", "place").eq("place_id", placeId).maybeSingle()
    if (seo !== null) {
      return "has-seo-page"
    }
    if (currentSnapshotHash(place) !== expected) {
      return "hash-mismatch"
    }
  }
  return null
}

async function isSnapshotMismatch(item: BatchRunItemRow, snapshotMap: Map<string, string>): Promise<boolean> {
  const expected = snapshotMap.get(item.place_id)
  if (expected === undefined) {
    return true
  }
  const client = createSupabaseServiceRoleClient()
  const { data: place } = await client.from("places").select("id, name, address, phone, slug, official_verification_status").eq("id", item.place_id).maybeSingle()
  if (place === null) {
    return true
  }
  return currentSnapshotHash(place) !== expected
}

function currentSnapshotHash(place: Readonly<{ id: string; name: string; address: string | null; phone: string | null; slug: string | null; official_verification_status: string | null | undefined }>): string {
  return computeApprovalSnapshotHash({
    place_id: place.id,
    name: place.name,
    address: place.address,
    phone: place.phone,
    slug: place.slug,
    official_verification_status: place.official_verification_status ?? "",
  })
}

function parseSnapshotHashMap(snapshot: Json): Map<string, string> {
  const map = new Map<string, string>()
  if (!Array.isArray(snapshot)) {
    return map
  }
  for (const entry of snapshot) {
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const record = entry as Record<string, Json | undefined>
      const placeId = record["place_id"]
      const hash = record["snapshot_hash"]
      if (typeof placeId === "string" && typeof hash === "string") {
        map.set(placeId, hash)
      }
    }
  }
  return map
}

function noChain(outcome: ExecuteOutcome): ExecuteResult {
  return { outcome, nextTick: null }
}
