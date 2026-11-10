import "server-only"

// 운영 작업 실행 — batch pump의 idle 분기에서만 부른다 (Preview 전용·bypass·pump 시크릿 게이트 통과 후).
// 대상·필드·예상 해시는 settings.ops_task에 고정돼 있고, 여기서는 기존 서버 코어를 순서대로 호출만 한다.
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import { isOpsTaskExpired, OPS_TASK_SETTING_KEY, opsTaskResultKey, parseOpsTask, type OpsTask, type OpsTaskStep } from "./ops-task"
import type { Json } from "@/types/database"

export type OpsTaskStepResult = { readonly index: number; readonly kind: OpsTaskStep["kind"]; readonly ok: boolean; readonly outcome: string; readonly detail?: string }

export type OpsTaskOutcome =
  | { readonly kind: "skipped"; readonly reason: "no-task" | "expired" | "already-claimed" }
  | { readonly kind: "finished"; readonly taskId: string; readonly status: "done" | "stopped"; readonly results: readonly OpsTaskStepResult[] }

const UNIQUE_VIOLATION = "23505"

export async function runOpsTask(input: Readonly<{ nowIso: string }>): Promise<OpsTaskOutcome> {
  const client = createSupabaseServiceRoleClient()
  const { data, error } = await client.from("settings").select("value").eq("key", OPS_TASK_SETTING_KEY).maybeSingle()
  if (error !== null) {
    throw new Error(`Failed to read ops task: ${error.message}`)
  }
  const task = parseOpsTask(data?.value)
  if (task === null) {
    return { kind: "skipped", reason: "no-task" }
  }
  if (isOpsTaskExpired(task, input.nowIso)) {
    return { kind: "skipped", reason: "expired" }
  }

  // claim — 결과 행을 먼저 INSERT한다. key가 PK라 같은 작업 ID는 한 번만 들어간다.
  // (upsert가 아니다: 이미 있으면 다른 실행이 가져갔거나 끝난 작업이다.)
  const resultKey = opsTaskResultKey(task.id)
  const claim = await client.from("settings").insert({ key: resultKey, value: { status: "running", started_at: input.nowIso } as Json })
  if (claim.error !== null) {
    if (claim.error.code === UNIQUE_VIOLATION) {
      return { kind: "skipped", reason: "already-claimed" }
    }
    throw new Error(`Failed to claim ops task: ${claim.error.message}`)
  }

  // step은 순서대로, 하나라도 성공하지 못하면 거기서 멈춘다 (뒤 step이 앞 step의 결과에 기대는 경우가 있다).
  const results: OpsTaskStepResult[] = []
  let status: "done" | "stopped" = "done"
  for (const [index, step] of task.steps.entries()) {
    const result = await runStep(task, step, index)
    results.push(result)
    if (!result.ok) {
      status = "stopped"
      break
    }
  }

  const finishedAt = new Date().toISOString()
  const saved = await client.from("settings").update({ value: { status, started_at: input.nowIso, finished_at: finishedAt, results } }).eq("key", resultKey)
  if (saved.error !== null) {
    // 작업 자체는 끝났다 — 결과 행은 running으로 남고 재실행은 claim에서 막힌다. 로그로만 알린다.
    console.error("[ops-task] result save failed", task.id, saved.error.message)
  }
  return { kind: "finished", taskId: task.id, status, results }
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
