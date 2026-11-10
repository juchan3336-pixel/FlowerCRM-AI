import "server-only"

// 운영 작업 실행 — batch pump의 idle 분기에서만 부른다 (Preview 전용·bypass·pump 시크릿 게이트 통과 후).
// 대상·필드·예상 해시는 settings.ops_task에 고정돼 있고, 여기서는 기존 서버 코어를 순서대로 호출만 한다.
//
// 결과 행(settings.ops_task_result:<id>) INSERT가 claim이다. 이것은 "정확히 한 번 완료"가 아니라
// "최대 한 번 시작"을 보장한다 — 함수가 중간에 죽으면 결과는 running으로 남는다.
// 그래서 호출자(pump)에게 돌려주는 상태가 중요하다:
//   clear    설정된 작업이 없거나, 이미 정상 완료(done)됐다 → 캠페인이 진행해도 된다
//   blocked  실행 중·중단·상태 미상 등 → 사람이 확인하기 전에는 캠페인도 진행하지 않는다
//   finished 이번 호출이 작업을 실행했다 → 이번 주기에는 캠페인을 진행하지 않는다
//
// 게시와의 상호 배제 (lib/seo-pages/publish-hold.ts의 순서 규칙):
//   게시 금지(freeze)를 세운다 → 게시 lock을 얻는다 → step 실행 → 전부 성공하면 freeze를 내린다 → lock 해제
// freeze에는 만료가 없다. 작업이 중단되거나 함수가 죽으면 freeze는 그대로 남아, 콘텐츠가 중간 상태인 동안
// 어떤 경로의 게시도 열리지 않는다. 시간이 지났다고 풀리지 않는다.
//
// 중단(stopped)·잔류(running)된 작업은 자동으로 다시 실행하지 않는다. 복구 절차:
//   1) 결과 행의 step별 결과와 대상의 실제 상태를 확인한다
//   2) 남은 step만 담은 새 작업을 만든다 (correct-ready는 같은 edits를 현재 해시로 — 장소까지 쓰고 멈춘 보정은 이어서 끝난다)
//   3) 새 작업의 inheritFreezeFrom에 옛 작업 ID를 적는다 — 서 있는 freeze를 넘겨받아 실행하고, 성공하면 내린다
// 같은 ID의 결과 행을 지우고 전체를 다시 돌리지 않는다.
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import { ACTIVE_APPROVAL_STATUSES } from "./candidate-policy"
import { isOpsTaskExpired, OPS_TASK_SETTING_KEY, opsTaskResultKey, parseOpsTask, type OpsTask, type OpsTaskStep } from "./ops-task"
import type { Json } from "@/types/database"

export type OpsTaskStepResult = { readonly index: number; readonly kind: OpsTaskStep["kind"]; readonly ok: boolean; readonly outcome: string; readonly detail?: string }

export type OpsTaskBlockReason =
  | "expired"
  // 같은 작업 ID가 이미 시작됐고 정상 완료가 아니다.
  | "previous-running"
  | "previous-stopped"
  | "previous-unknown"
  // 생성 승인·배치가 진행 중이다 — 콘텐츠 보정과 겹치지 않게 기다린다 (claim하지 않았으므로 다음 주기에 다시 본다).
  | "active-run"
  // 다른 작업이 세운 게시 금지가 남아 있다 (넘겨받도록 지정되지 않았다).
  | "publish-frozen"
  // 게시가 진행 중이다 — 아무것도 쓰지 않았고 claim도 하지 않았다. 다음 주기에 다시 본다.
  | "publish-lock-busy"

export type OpsTaskOutcome =
  | { readonly kind: "clear"; readonly reason: "no-task" | "already-done" }
  | { readonly kind: "blocked"; readonly reason: OpsTaskBlockReason }
  | { readonly kind: "finished"; readonly taskId: string; readonly status: "done" | "stopped"; readonly results: readonly OpsTaskStepResult[] }

const UNIQUE_VIOLATION = "23505"
// lock 수명 — 함수 제한 시간(60초)보다 길게. 정상 종료하면 즉시 놓는다.
const LOCK_TTL_MS = 3 * 60_000

export function opsTaskOwner(taskId: string): string {
  return `ops-task:${taskId}`
}

export async function runOpsTask(input: Readonly<{ nowIso: string }>): Promise<OpsTaskOutcome> {
  const client = createSupabaseServiceRoleClient()
  const { data, error } = await client.from("settings").select("value").eq("key", OPS_TASK_SETTING_KEY).maybeSingle()
  if (error !== null) {
    throw new Error(`Failed to read ops task: ${error.message}`)
  }
  if (data?.value == null) {
    return { kind: "clear", reason: "no-task" }
  }
  const task = parseOpsTask(data.value)
  if (task === null) {
    // 행은 있는데 해석되지 않는다 — 무엇을 하려던 것인지 모르므로 캠페인도 멈춘다.
    return { kind: "blocked", reason: "previous-unknown" }
  }

  // 이미 시작된 작업인지 먼저 본다 — done만 통과시킨다.
  const resultKey = opsTaskResultKey(task.id)
  const previous = await client.from("settings").select("value").eq("key", resultKey).maybeSingle()
  if (previous.error !== null) {
    throw new Error(`Failed to read ops task result: ${previous.error.message}`)
  }
  if (previous.data !== null) {
    return classifyPrevious(previous.data.value)
  }
  if (isOpsTaskExpired(task, input.nowIso)) {
    return { kind: "blocked", reason: "expired" }
  }

  // pump의 idle은 "승인 없음"뿐 아니라 "다른 pump가 lease를 쥐고 item을 처리 중"도 포함한다.
  // 진행 중 승인·배치가 실제로 없음을 직접 확인한다.
  const [approvals, runs] = await Promise.all([
    client.from("batch_approvals").select("id", { count: "exact", head: true }).in("status", [...ACTIVE_APPROVAL_STATUSES] as never[]),
    client.from("batch_runs").select("id", { count: "exact", head: true }).eq("status", "running"),
  ])
  if (approvals.error !== null || runs.error !== null || approvals.count === null || runs.count === null) {
    throw new Error("Failed to read active runs for ops task")
  }
  if (approvals.count > 0 || runs.count > 0) {
    return { kind: "blocked", reason: "active-run" }
  }

  const { acquirePublishLock, clearPublishFreeze, releasePublishLock, setPublishFreeze } = await import("@/lib/seo-pages/publish-hold")
  const owner = opsTaskOwner(task.id)

  // 1) 게시 금지 — 이 뒤로 새로 시작하는 게시는 전부 물러난다.
  const freeze = await setPublishFreeze({
    by: owner,
    reason: `ops task ${task.id}`,
    nowIso: input.nowIso,
    inheritFrom: task.inheritFreezeFrom === null ? null : opsTaskOwner(task.inheritFreezeFrom),
  })
  if (freeze === "held-by-other") {
    return { kind: "blocked", reason: "publish-frozen" }
  }
  // 아직 아무것도 쓰지 않은 채 물러날 때: 방금 세운 freeze만 내린다. 넘겨받은 freeze는 원래 서 있던 이유가 있으므로 둔다.
  const backOut = async (): Promise<void> => {
    if (freeze === "set") {
      await clearPublishFreeze(owner).catch(() => false)
    }
  }

  // 2) 게시 lock — 이미 진행 중인 게시가 있으면 얻지 못한다. 그 게시가 끝난 다음 주기에 다시 본다.
  let locked: boolean
  try {
    locked = await acquirePublishLock({ by: owner, ttlMs: LOCK_TTL_MS, nowIso: input.nowIso })
  } catch (lockError) {
    await backOut()
    throw lockError
  }
  if (!locked) {
    await backOut()
    return { kind: "blocked", reason: "publish-lock-busy" }
  }

  try {
    // 3) claim — key가 PK라 같은 작업 ID는 한 번만 들어간다 (upsert 아님).
    const claim = await client.from("settings").insert({ key: resultKey, value: { status: "running", started_at: input.nowIso, results: [] } as Json })
    if (claim.error !== null) {
      await backOut()
      if (claim.error.code === UNIQUE_VIOLATION) {
        return { kind: "blocked", reason: "previous-running" }
      }
      throw new Error(`Failed to claim ops task: ${claim.error.message}`)
    }

    const saveResult = async (status: "running" | "done" | "stopped", results: readonly OpsTaskStepResult[]): Promise<void> => {
      const saved = await client
        .from("settings")
        .update({ value: { status, started_at: input.nowIso, updated_at: new Date().toISOString(), results } })
        .eq("key", resultKey)
      if (saved.error !== null) {
        // 결과 행이 running으로 남는다 — 다음 호출은 previous-running으로 막힌다. 로그로만 알린다.
        console.error("[ops-task] result save failed", task.id, saved.error.message)
      }
    }

    // 4) step은 순서대로, 하나라도 성공하지 못하면 거기서 멈춘다. step마다 결과를 저장한다 —
    // 함수가 중간에 죽어도 어디까지 끝났는지 남는다.
    const results: OpsTaskStepResult[] = []
    let status: "done" | "stopped" = "done"
    for (const [index, step] of task.steps.entries()) {
      const result = await runStep(task, step, index)
      results.push(result)
      if (!result.ok) {
        status = "stopped"
        break
      }
      await saveResult("running", results)
    }
    await saveResult(status, results)

    // 5) 전부 성공했을 때만 게시 금지를 내린다. 중단됐으면 콘텐츠가 중간 상태일 수 있으므로 남긴다.
    if (status === "done") {
      try {
        await clearPublishFreeze(owner)
      } catch (freezeError) {
        console.error("[ops-task] freeze clear failed", task.id, freezeError instanceof Error ? freezeError.message : "unknown")
      }
    }
    return { kind: "finished", taskId: task.id, status, results }
  } finally {
    // lock은 실행 소유권일 뿐이다 — 결과와 무관하게 놓는다. 게시를 막는 것은 freeze다.
    try {
      await releasePublishLock(owner)
    } catch {
      // 놓지 못해도 만료 시각에 무효가 된다.
    }
  }
}

function classifyPrevious(value: unknown): OpsTaskOutcome {
  const status = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)["status"] : null
  if (status === "done") {
    return { kind: "clear", reason: "already-done" }
  }
  if (status === "running") {
    return { kind: "blocked", reason: "previous-running" }
  }
  if (status === "stopped") {
    return { kind: "blocked", reason: "previous-stopped" }
  }
  return { kind: "blocked", reason: "previous-unknown" }
}

async function runStep(task: OpsTask, step: OpsTaskStep, index: number): Promise<OpsTaskStepResult> {
  try {
    if (step.kind === "resolve-needs-review") {
      const { resolveNeedsReviewItem } = await import("./needs-review-service")
      const result = await resolveNeedsReviewItem({ itemId: step.itemId, generationId: step.generationId, edits: {}, confirmed: true, actor: task.actor })
      if (result.kind === "resolved") {
        return { index, kind: step.kind, ok: true, outcome: result.itemStatus }
      }
      const detail = result.kind === "invalid-field" ? result.field : result.kind === "quality-not-pass" ? result.status : result.reason
      return { index, kind: step.kind, ok: false, outcome: result.kind, detail }
    }
    const { correctReadyContent } = await import("./ready-correction-service")
    const result = await correctReadyContent({
      placeId: step.placeId,
      generationId: step.generationId,
      expectedContentHash: step.expectedContentHash,
      edits: step.edits,
      actor: task.actor,
      reason: step.reason,
    })
    switch (result.kind) {
      case "corrected":
        return { index, kind: step.kind, ok: true, outcome: result.resumed ? "resumed" : "corrected", detail: `${result.changedFields.join(",")} → ${result.contentHash}` }
      case "blocked":
        return { index, kind: step.kind, ok: false, outcome: "blocked", detail: result.reason }
      case "invalid-field":
        return { index, kind: step.kind, ok: false, outcome: "invalid-field", detail: result.field }
      case "quality-not-pass":
        return { index, kind: step.kind, ok: false, outcome: "quality-not-pass", detail: `${result.status}: ${result.issueCodes.join(",")}`.slice(0, 300) }
      case "failed":
        return { index, kind: step.kind, ok: false, outcome: "failed", detail: result.step }
    }
  } catch (error) {
    return { index, kind: step.kind, ok: false, outcome: "threw", detail: error instanceof Error ? error.message.slice(0, 200) : "unknown" }
  }
}
