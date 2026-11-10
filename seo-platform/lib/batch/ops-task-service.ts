import "server-only"

// 운영 작업 실행 — batch pump의 idle 분기에서만 부른다 (Preview 전용·bypass·pump 시크릿 게이트 통과 후).
// 대상·필드·예상 해시는 settings.ops_task에 고정돼 있고, 여기서는 기존 서버 코어를 순서대로 호출만 한다.
//
// 결과 행(settings.ops_task_result:<id>) INSERT가 claim이다. 이것은 "정확히 한 번 완료"가 아니라
// "최대 한 번 시작"을 보장한다 — 함수가 중간에 죽으면 결과는 running으로 남는다.
// 그래서 호출자(pump)에게 돌려주는 상태가 중요하다:
//   clear   설정된 작업이 없거나, 이미 정상 완료(done)됐다 → 캠페인이 진행해도 된다
//   blocked 실행 중·중단·상태 미상 등 → 사람이 확인하기 전에는 캠페인도 진행하지 않는다
//   finished 이번 호출이 작업을 실행했다 → 이번 주기에는 캠페인을 진행하지 않는다
// 중단(stopped)·잔류(running)된 작업은 자동으로 다시 실행하지 않는다. 완료된 step과 남은 step을 확인한 뒤
// 남은 것만 새 작업 ID로 만든다 (같은 ID의 결과 행을 지우고 전체를 다시 돌리지 않는다).
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
  // 다른 주체가 게시 보류를 쥐고 있다.
  | "publish-hold-busy"

export type OpsTaskOutcome =
  | { readonly kind: "clear"; readonly reason: "no-task" | "already-done" }
  | { readonly kind: "blocked"; readonly reason: OpsTaskBlockReason }
  | { readonly kind: "finished"; readonly taskId: string; readonly status: "done" | "stopped"; readonly results: readonly OpsTaskStepResult[] }

const UNIQUE_VIOLATION = "23505"
// 게시 보류를 건 뒤 첫 쓰기까지 두는 간격 — 보류를 보기 전에 이미 진입한 게시(1~2초)가 끝나도록.
export const OPS_TASK_HOLD_SETTLE_MS = 5_000
// 보류 유효 시간. 정상 완료하면 즉시 풀고, 중단되면 이 시각까지 게시가 막힌 채로 남는다.
const HOLD_MINUTES = 30

type Sleep = (ms: number) => Promise<void>
const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function runOpsTask(input: Readonly<{ nowIso: string; sleep?: Sleep }>): Promise<OpsTaskOutcome> {
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

  // claim — key가 PK라 같은 작업 ID는 한 번만 들어간다 (upsert 아님).
  const claim = await client.from("settings").insert({ key: resultKey, value: { status: "running", started_at: input.nowIso, results: [] } as Json })
  if (claim.error !== null) {
    if (claim.error.code === UNIQUE_VIOLATION) {
      return { kind: "blocked", reason: "previous-running" }
    }
    throw new Error(`Failed to claim ops task: ${claim.error.message}`)
  }

  const saveResult = async (status: "running" | "done" | "stopped", results: readonly OpsTaskStepResult[], note?: string): Promise<void> => {
    const saved = await client
      .from("settings")
      .update({ value: { status, started_at: input.nowIso, updated_at: new Date().toISOString(), results, ...(note === undefined ? {} : { note }) } })
      .eq("key", resultKey)
    if (saved.error !== null) {
      // 결과 행이 running으로 남는다 — 다음 호출은 previous-running으로 막힌다. 로그로만 알린다.
      console.error("[ops-task] result save failed", task.id, saved.error.message)
    }
  }

  // 게시 보류 — 보정이 세 곳을 쓰는 동안 게시가 끼어들지 않게 한다.
  const { acquirePublishHold, releasePublishHold } = await import("@/lib/seo-pages/publish-hold")
  const holdBy = `ops-task:${task.id}`
  let held = false
  try {
    held = await acquirePublishHold({ by: holdBy, until: new Date(Date.parse(input.nowIso) + HOLD_MINUTES * 60_000).toISOString(), nowIso: input.nowIso })
  } catch {
    held = false
  }
  if (!held) {
    await saveResult("stopped", [], "publish-hold-busy")
    return { kind: "blocked", reason: "publish-hold-busy" }
  }
  await (input.sleep ?? defaultSleep)(OPS_TASK_HOLD_SETTLE_MS)

  // step은 순서대로, 하나라도 성공하지 못하면 거기서 멈춘다. step마다 결과를 저장한다 —
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

  // 전부 성공했을 때만 보류를 푼다. 중단됐으면 콘텐츠가 중간 상태일 수 있으므로 보류를 남긴다
  // (만료 시각까지 게시 차단 — 그 전에 사람이 상태를 확인하고 정리한다).
  if (status === "done") {
    try {
      await releasePublishHold(holdBy)
    } catch (releaseError) {
      console.error("[ops-task] hold release failed", task.id, releaseError instanceof Error ? releaseError.message : "unknown")
    }
  }
  return { kind: "finished", taskId: task.id, status, results }
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
        return { index, kind: step.kind, ok: true, outcome: "corrected", detail: `${result.changedFields.join(",")} → ${result.contentHash}` }
      case "synced":
        return { index, kind: step.kind, ok: true, outcome: "synced", detail: result.contentHash }
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
