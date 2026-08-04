import "server-only"

// 승인 Batch 자동 실행 v1 — 오케스트레이션 (PR-B).
// activate/tick 모드를 처리하고 기존 generation-batch-service를 그대로 재사용한다.
// generation-runner를 복제하지 않는다 — item 처리·품질·retry·비용 상한·이벤트는 전부 기존 경로.
// HTTP 배선·환경 게이트는 route가 담당한다: activate는 app/api/batch/execute, item 처리는 app/api/batch/pump.
//
// item을 자기 자신에게 HTTP로 넘기는 코드는 이 모듈에 없다 — Vercel이 같은 함수의 재귀 호출을 4회 초과에서
// 508로 차단하기 때문이다. 승인 상한이 5곳이라 예전 self-chain 구조는 최대 규모에서 반드시 터졌다.
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import { processNextGenerationItem, startGenerationBatch } from "./generation-batch-service"
import { computeApprovalSnapshotHash, hashActivationToken, isApprovalExpired, mintLeaseToken } from "./approval-policy"
import { BATCH_PUMP_LEASE_SECONDS, isTickWithinLimit, type ExecuteOutcome } from "./approval-execution-policy"
import { createSupabaseApprovalRepository } from "./supabase-approval-repository"
import { createSupabaseBatchRepository } from "./supabase-batch-repository"
import type { BatchApprovalRow, BatchRunItemRow, Json } from "@/types/database"

// activate 결과. 다음 단계를 어떻게 이어갈지에 대한 정보는 담지 않는다 —
// 이어가는 주체는 이 요청도, 이 함수도 아니라 다음 Cron 호출(pump)이다.
export type ExecuteResult = {
  readonly outcome: ExecuteOutcome
}

const CLAIMABLE: readonly string[] = ["queued", "interrupted"]

// ── activate ─────────────────────────────────────────────────────
export async function executeActivate(input: Readonly<{ activationToken: string; nowIso: string; previewDeploymentSha: string | null }>): Promise<ExecuteResult> {
  const approvals = createSupabaseApprovalRepository()
  const tokenHash = hashActivationToken(input.activationToken)
  const approval = await approvals.findApprovalByTokenHash(tokenHash)
  if (approval === null) {
    return noResult({ kind: "unauthorized", reason: "invalid-token" })
  }
  if (approval.status === "completed" || approval.status === "failed" || approval.status === "cancelled") {
    return noResult({ kind: "conflict", reason: "not-activatable" })
  }
  if (isApprovalExpired(approval.approval_expires_at, input.nowIso)) {
    await approvals.expireApproval(approval.id)
    return noResult({ kind: "expired" })
  }

  // kick 발사 표시 — 이후 pre-flight 실패를 queued→failed로 남길 수 있게 한다 (approved에서만 전이).
  await approvals.markQueued(approval.id)

  // pre-flight: 승인 스냅샷 전체 재검증 (승인 후 장소 변경 감지). 실패 시 토큰 미소진으로 queued→failed.
  const preflight = await verifyAllSnapshots(approval)
  if (preflight !== null) {
    await approvals.failApproval(approval.id, { code: "preflight", message: `preflight-${preflight}` })
    return noResult({ kind: "conflict", reason: `preflight-${preflight}` })
  }

  // 원자 소진 — approved|queued ∧ 미소진 ∧ 미연결 ∧ 미만료 → running + consumed_at.
  const activated = await approvals.activateApproval({ executionTokenHash: tokenHash, nowIso: input.nowIso })
  if (activated === null) {
    // 이미 소진·연결됐거나 동시 활성화 경합에서 패배 — 재사용 차단.
    return noResult({ kind: "conflict", reason: "already-consumed" })
  }

  // 기존 생성 배치 시작 — 스냅샷 placeIds만 사용한다 (요청 본문 신뢰 안 함).
  // 승인 시 확정된 approved_max_cost_usd를 실행 비용 상한으로 넘긴다 (계획: 추정 초과 시 cost-limit 거부, 실행: 누적 도달 시 잔여 skip).
  const started = await startGenerationBatch({
    placeIds: approval.approved_place_ids,
    createdBy: approval.approved_by,
    officialCheckApproved: true,
    maxCostUsd: approval.approved_max_cost_usd,
    // 이 시점 승인은 이미 running이다 — 자기 자신을 active-approval로 세지 않도록 제외한다.
    // 다른 approved/queued/running 승인이 같은 장소를 물고 있으면 여전히 차단된다.
    excludeApprovalId: activated.id,
  })
  if (started.kind !== "started") {
    // 보상 전이: running→failed. 토큰은 소진 유지 → 자동 재활성화 금지, 새 승인 필요.
    const reason = started.kind === "already-running" ? "already-running" : `invalid-${started.plan.reason}`
    await approvals.failApproval(activated.id, { code: "start-failed", message: `start-failed:${reason}` })
    return noResult({ kind: "conflict", reason: `start-failed:${reason}` })
  }

  const linked = await approvals.linkBatchRun(activated.id, started.batchId)
  if (linked === null) {
    // running이 아니거나(그 사이 취소) 이미 연결 — 취소면 run도 정리한다.
    const current = await approvals.findApprovalById(activated.id)
    if (current?.status === "cancelled") {
      const { cancelGenerationBatch } = await import("./generation-batch-service")
      await cancelGenerationBatch(started.batchId, approval.approved_by)
      return noResult({ kind: "conflict", reason: "cancelled" })
    }
    return noResult({ kind: "conflict", reason: "link-failed" })
  }

  // activate는 여기서 끝난다: 접수(batch 생성·연결)까지만 하고 즉시 202를 돌려준다.
  // item 처리를 이 요청 안에서 끝내면 생성 시간(수십 초)이 호출자 timeout을 넘겨 성공한 실행이
  // "연결 실패"로 오분류되고 승인이 잘못 취소된다.
  // 첫 item은 다음 Cron 호출이 이 승인을 claim해서 처리한다 — 여기서 아무것도 발사하지 않는다.
  return { outcome: { kind: "accepted", approvalStatus: "running" } }
}

// ── pump claim (실행 소유권 확보) ────────────────────────────────
// 실행 중(running) 승인 1개를 골라 lease를 건다. 후보 선택과 lease 기록이 한 원자 연산이라
// 같은 순간에 두 pump가 들어와도 승자는 하나뿐이다 (나머지는 idle을 받는다).
//
// approved·queued는 RPC 조건에서 제외된다 — 승인을 실행 상태로 올리는 일은 사용자 activate 경로만 한다.
export type ClaimBatchPumpLeaseResult =
  | { readonly kind: "claimed"; readonly approval: BatchApprovalRow; readonly leaseTokenHash: string }
  | { readonly kind: "idle" }

export async function claimBatchPumpLease(input: Readonly<{ nowIso: string }>): Promise<ClaimBatchPumpLeaseResult> {
  const approvals = createSupabaseApprovalRepository()
  const minted = mintLeaseToken()
  const approval = await approvals.claimPumpLease({
    leaseTokenHash: minted.tokenHash,
    leaseSeconds: BATCH_PUMP_LEASE_SECONDS,
    nowIso: input.nowIso,
  })
  return approval === null ? { kind: "idle" } : { kind: "claimed", approval, leaseTokenHash: minted.tokenHash }
}

// ── 배치 1건 실행 ────────────────────────────────────────────────
// lease를 쥔 pump가 item 정확히 1건만 처리한다. 끝나면 lease를 놓고 함수는 종료된다 —
// 다음 item은 다음 Cron 호출이 가져간다. 여기서 자기 자신을 다시 부르는 경로는 없다.
export async function runLeasedApprovalStep(
  input: Readonly<{ approval: BatchApprovalRow; leaseTokenHash: string; nowIso: string; previewDeploymentSha: string | null }>,
): Promise<ExecuteOutcome> {
  const { approval, leaseTokenHash, nowIso } = input
  const approvals = createSupabaseApprovalRepository()

  try {
    // 종료 상태·연결 해제는 claim 이후 그 사이에 바뀐 경우다 (RPC 조건을 통과했더라도 다시 본다).
    const current = await approvals.findApprovalById(approval.id)
    if (current === null) {
      return { kind: "unauthorized", reason: "unknown-approval" }
    }
    if (current.status !== "running" || current.batch_run_id === null) {
      return { kind: "noop", reason: `not-running-${current.status}` }
    }
    // 폭주 방어 — Cron이 같은 승인을 끝없이 집어가는 것을 막는 안전핀 (self-chain 시절 상한을 그대로 쓴다).
    if (!isTickWithinLimit(current.execution_tick, current.approved_place_ids.length)) {
      await failWithLease(approvals, current.id, leaseTokenHash, { code: "tick-limit", message: "tick-limit" })
      return { kind: "conflict", reason: "tick-limit" }
    }

    // batch_run이 이미 끝났으면 approval을 그 결과에 맞춰 수렴시킨다 (무조건 completed로 닫지 않는다).
    const batchRepo = createSupabaseBatchRepository()
    const run = await batchRepo.getRun(current.batch_run_id)
    if (run !== null && run.status !== "running") {
      return await convergeApprovalToRun(approvals, current.id, leaseTokenHash, run.status)
    }

    // 진행 표시 CAS — lease를 들고 있어도 execution_tick 기대값이 어긋나면 손을 뗀다 (이중 방어).
    const advanced = await approvals.advanceExecutionTick({
      approvalId: current.id,
      expectedTick: current.execution_tick,
      nowIso,
      previewDeploymentSha: input.previewDeploymentSha,
    })
    if (!advanced) {
      return { kind: "noop", reason: "duplicate-step" }
    }

    return await runOneItem({
      approvalId: current.id,
      batchId: current.batch_run_id,
      leaseTokenHash,
      snapshotMap: parseSnapshotHashMap(current.approval_snapshot),
      nowIso,
    })
  } finally {
    // 성공·실패·예외 어디로 빠지든 lease는 놓는다 — 만료를 기다리지 않고 다음 Cron이 이어갈 수 있게.
    // 이미 종료 전이(complete/fail)에서 비워졌다면 이 UPDATE는 0행이라 무해하다.
    try {
      await approvals.releasePumpLease({ approvalId: approval.id, leaseTokenHash })
    } catch {
      // 해제 실패는 치명적이지 않다 — lease 만료 후 다음 Cron이 같은 승인을 다시 가져간다.
    }
  }
}

// ── item 1건 처리 ────────────────────────────────────────────────
// 기존 generation-batch-service를 그대로 재사용한다 — 품질·retry·비용 상한·이벤트가 갈라지지 않게.
async function runOneItem(
  input: Readonly<{ approvalId: string; batchId: string; leaseTokenHash: string; snapshotMap: Map<string, string>; nowIso: string }>,
): Promise<ExecuteOutcome> {
  const approvals = createSupabaseApprovalRepository()
  const batchRepo = createSupabaseBatchRepository()

  // 장시간 멈춘 processing은 interrupted로 표시 (기존 stale 처리 재사용) — 재개 정합.
  await batchRepo.markStaleItemsInterrupted(input.batchId, input.nowIso)

  const items = await batchRepo.listItems(input.batchId)
  const next = nextClaimable(items)

  if (next === undefined) {
    // 남은 claimable 없음 — processNextGenerationItem이 run을 completed로 닫고 done=true.
    const result = await processNextGenerationItem(input.batchId, { trigger: "auto" })
    return result.done
      ? await completeWithLease(approvals, input.approvalId, input.leaseTokenHash)
      : { kind: "processed", done: false, approvalStatus: "running" }
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
      return completeWithLease(approvals, input.approvalId, input.leaseTokenHash)
    }
  }
  // 잔여가 있어도 여기서 다음 실행을 부르지 않는다 — 다음 Cron 호출이 이어간다.
  return { kind: "processed", done: false, approvalStatus: "running" }
}

function nextClaimable(items: readonly BatchRunItemRow[]): BatchRunItemRow | undefined {
  return [...items].filter((item) => CLAIMABLE.includes(item.status)).sort((a, b) => a.sequence - b.sequence)[0]
}

// 승인 상태를 바꾸는 쓰기는 전부 lease 조건부다 — lease를 잃은 워커가 남의 진행을 덮지 못한다.
async function completeWithLease(
  approvals: ReturnType<typeof createSupabaseApprovalRepository>,
  approvalId: string,
  leaseTokenHash: string,
): Promise<ExecuteOutcome> {
  const completed = await approvals.completeApproval(approvalId, leaseTokenHash)
  return completed === null ? { kind: "noop", reason: "lease-lost" } : { kind: "completed", approvalStatus: "completed" }
}

async function failWithLease(
  approvals: ReturnType<typeof createSupabaseApprovalRepository>,
  approvalId: string,
  leaseTokenHash: string,
  failure: Readonly<{ code: string; message: string }>,
): Promise<void> {
  if (await approvals.holdsPumpLease({ approvalId, leaseTokenHash })) {
    await approvals.failApproval(approvalId, failure)
  }
}

// approval은 연결된 batch_run의 최종 상태를 그대로 따라간다.
// (예전에는 run이 failed/cancelled여도 approval을 completed로 닫아 기록이 사실과 어긋났다.)
async function convergeApprovalToRun(
  approvals: ReturnType<typeof createSupabaseApprovalRepository>,
  approvalId: string,
  leaseTokenHash: string,
  runStatus: string,
): Promise<ExecuteOutcome> {
  if (!(await approvals.holdsPumpLease({ approvalId, leaseTokenHash }))) {
    return { kind: "noop", reason: "lease-lost" }
  }
  if (runStatus === "failed") {
    await approvals.failApproval(approvalId, { code: "run-failed", message: "run-failed" })
    return { kind: "conflict", reason: "run-failed" }
  }
  if (runStatus === "cancelled") {
    await approvals.cancelApproval(approvalId)
    return { kind: "conflict", reason: "run-cancelled" }
  }
  return completeWithLease(approvals, approvalId, leaseTokenHash)
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

function noResult(outcome: ExecuteOutcome): ExecuteResult {
  return { outcome }
}
