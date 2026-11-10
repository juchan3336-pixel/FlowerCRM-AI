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

// 작업이 step의 실패가 아닌 이유로 멈춘 경우 — 실행하지 않은 step을 성공·실패 결과로 꾸미지 않고 따로 적는다.
//   time-budget         남은 시간이 다음 step을 시작하기에 모자랐다 (그 step의 대상은 건드리지 않았다)
//   result-save-failed  진행 기록(다음 step 표시 또는 직전 결과)을 저장하지 못했다 — 기록 없이 더 나아가지 않는다
export type OpsTaskStopReason = "time-budget" | "result-save-failed"

export type OpsTaskOutcome =
  | { readonly kind: "clear"; readonly reason: "no-task" | "already-done" }
  | { readonly kind: "blocked"; readonly reason: OpsTaskBlockReason }
  | { readonly kind: "finished"; readonly taskId: string; readonly status: "done" | "stopped"; readonly results: readonly OpsTaskStepResult[]; readonly stopReason?: OpsTaskStopReason; readonly nextStepIndex?: number }

const UNIQUE_VIOLATION = "23505"
// lock 수명 — 함수 제한 시간(60초)보다 길게. 정상 종료하면 즉시 놓는다.
const LOCK_TTL_MS = 3 * 60_000

// 시간 예산 — 요청이 들어온 시점부터 잰다 (pump가 넘겨주는 경과 시간). 함수 제한은 60초다.
// 다음 step을 시작하려면 "step 한 개에 쓸 여유 + 결과 저장·정리에 쓸 여유"가 남아 있어야 한다.
// 이것은 '다음 step을 시작하지 않는' 장치일 뿐이다 — 이미 시작한 step 하나가 여유보다 오래 걸리는 것까지 막지는 못한다.
export const OPS_TASK_TOTAL_BUDGET_MS = 60_000
export const OPS_TASK_STEP_RESERVE_MS = 15_000
export const OPS_TASK_CLEANUP_RESERVE_MS = 10_000

export function hasBudgetForNextStep(elapsedMs: number): boolean {
  return elapsedMs + OPS_TASK_STEP_RESERVE_MS + OPS_TASK_CLEANUP_RESERVE_MS <= OPS_TASK_TOTAL_BUDGET_MS
}

function stepTarget(step: OpsTaskStep): string {
  return step.kind === "resolve-needs-review" ? step.itemId : step.placeId
}

export function opsTaskOwner(taskId: string): string {
  return `ops-task:${taskId}`
}

// elapsedMs: 요청 진입부터 지금까지의 경과(단조 시계). 주지 않으면 이 함수에 들어온 시점부터 잰다.
export async function runOpsTask(input: Readonly<{ nowIso: string; elapsedMs?: () => number }>): Promise<OpsTaskOutcome> {
  const enteredAt = performance.now()
  const elapsedMs = input.elapsedMs ?? ((): number => performance.now() - enteredAt)
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
  // 아직 아무것도 쓰지 않은 채 물러날 때: 방금 새로 세운 freeze만 내린다.
  // 넘겨받았거나(inherited) 이전 시도부터 쥐고 있던(owned) freeze는 원래 서 있던 이유가 있으므로 둔다.
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
    // 실행한 배포의 커밋(앞 7자리)을 결과에 남긴다 — 어떤 코드가 이 작업을 실행했는지의 증거. 시크릿이 아니다.
    const runtimeSha = process.env["VERCEL_GIT_COMMIT_SHA"]?.slice(0, 7) ?? null
    const claim = await client.from("settings").insert({ key: resultKey, value: { status: "running", started_at: input.nowIso, runtime_sha: runtimeSha, results: [] } as Json })
    if (claim.error !== null) {
      await backOut()
      if (claim.error.code === UNIQUE_VIOLATION) {
        return { kind: "blocked", reason: "previous-running" }
      }
      throw new Error(`Failed to claim ops task: ${claim.error.message}`)
    }

    // 저장됐는지(정확히 1행)를 돌려준다. 저장되지 않으면 결과 행은 running으로 남고 다음 호출은 previous-running으로 막힌다.
    type ResultMeta = { readonly active_step?: { readonly index: number; readonly kind: OpsTaskStep["kind"]; readonly target: string }; readonly stop_reason?: OpsTaskStopReason; readonly next_step_index?: number }
    const saveResult = async (status: "running" | "done" | "stopped", results: readonly OpsTaskStepResult[], meta: ResultMeta = {}): Promise<boolean> => {
      const saved = await client
        .from("settings")
        .update({ value: { status, started_at: input.nowIso, updated_at: new Date().toISOString(), runtime_sha: runtimeSha, results, ...meta } })
        .eq("key", resultKey)
        .select("key")
      if (saved.error !== null || saved.data.length !== 1) {
        console.error("[ops-task] result save failed", task.id, saved.error?.message ?? "no row")
        return false
      }
      return true
    }

    // 4) step은 순서대로, 하나라도 성공하지 못하면 거기서 멈춘다. step마다 결과를 저장한다 —
    // 함수가 중간에 죽어도 어디까지 끝났는지 남는다.
    const results: OpsTaskStepResult[] = []
    let status: "done" | "stopped" = "done"
    let stopMeta: { stop_reason: OpsTaskStopReason; next_step_index: number } | null = null
    for (const [index, step] of task.steps.entries()) {
      // 남은 시간이 모자라면 이 step을 시작하지 않는다 — 대상은 claim하지 않은 채 그대로 둔다.
      if (!hasBudgetForNextStep(elapsedMs())) {
        status = "stopped"
        stopMeta = { stop_reason: "time-budget", next_step_index: index }
        break
      }
      // 시작하려는 step을 먼저 남긴다 — 함수가 이 step 도중에 끝나도 어느 대상을 건드리던 중이었는지 기록에 있다.
      // 이 기록을 남기지 못하면 시작하지 않는다.
      if (!(await saveResult("running", results, { active_step: { index, kind: step.kind, target: stepTarget(step) } }))) {
        status = "stopped"
        stopMeta = { stop_reason: "result-save-failed", next_step_index: index }
        break
      }
      // 시작 표시를 저장하는 데도 시간이 든다 (DB가 느리면 수십 초일 수 있다). 저장이 끝난 지금 다시 본다 —
      // 저장 전에만 보면, 저장하는 사이 여유가 사라졌는데도 step을 시작해 함수 제한을 넘긴다.
      if (!hasBudgetForNextStep(elapsedMs())) {
        status = "stopped"
        stopMeta = { stop_reason: "time-budget", next_step_index: index }
        break
      }
      const result = await runStep(task, step, index)
      results.push(result)
      if (!result.ok) {
        status = "stopped"
        break
      }
      // 방금 끝난 step의 결과를 저장하지 못하면 다음 step으로 가지 않는다.
      if (!(await saveResult("running", results))) {
        status = "stopped"
        stopMeta = { stop_reason: "result-save-failed", next_step_index: index + 1 }
        break
      }
    }
    const resultSaved = await saveResult(status, results, stopMeta ?? {})
    if (status === "done" && !resultSaved) {
      // 완료를 기록하지 못했다 — 결과 행은 running이라 사람이 확인해야 한다. 완료가 기록되지 않은 작업의 freeze는 내리지 않는다.
      status = "stopped"
      stopMeta = { stop_reason: "result-save-failed", next_step_index: task.steps.length }
    }

    // 5) 전부 성공하고 그 결과가 저장됐을 때만 게시 금지를 내린다. 중단됐으면 콘텐츠가 중간 상태일 수 있으므로 남긴다.
    if (status === "done") {
      try {
        await clearPublishFreeze(owner)
      } catch (freezeError) {
        console.error("[ops-task] freeze clear failed", task.id, freezeError instanceof Error ? freezeError.message : "unknown")
      }
    }
    return stopMeta === null ? { kind: "finished", taskId: task.id, status, results } : { kind: "finished", taskId: task.id, status, results, stopReason: stopMeta.stop_reason, nextStepIndex: stopMeta.next_step_index }
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
    if (step.kind === "correct-published-faq") {
      const { correctPublishedFaq } = await import("./published-faq-correction-service")
      const result = await correctPublishedFaq({
        taskId: task.id,
        stepIndex: index,
        placeId: step.placeId,
        generationId: step.generationId,
        expectedContentHash: step.expectedContentHash,
        faqIndex: step.faqIndex,
        expectedQuestion: step.expectedQuestion,
        answer: step.answer,
        actor: task.actor,
        reason: step.reason,
      })
      switch (result.kind) {
        case "corrected": {
          // 공개 캐시는 여기서 직접 갱신할 수 없다 — 이 작업은 Preview 배포의 pump에서 돌고, 캐시는 배포별로 격리돼 있다.
          // Production의 publish pump가 처리하도록 요청을 남긴다. DB 보정은 이미 끝났으므로 요청 저장 실패는 step 실패가 아니다 —
          // 결과에 구분해 적고, 공개 반영은 실제 URL의 화면·JSON-LD로 확인한다.
          let cache = "no-path"
          if (result.path !== null) {
            const { requestPublicRevalidation } = await import("@/lib/seo-pages/revalidate-requests")
            const requested = await requestPublicRevalidation({ id: `${task.id}-${String(index)}`, path: result.path, by: task.actor, nowIso: new Date().toISOString() }).catch(() => false)
            cache = requested ? "revalidate-requested" : "revalidate-request-failed"
          }
          return { index, kind: step.kind, ok: true, outcome: result.resumed ? "resumed" : "corrected", detail: [`faq[${String(step.faqIndex)}] → ${result.contentHash}`, result.path, cache].filter((part) => part !== null).join(" ") }
        }
        case "blocked":
          return { index, kind: step.kind, ok: false, outcome: "blocked", detail: result.reason }
        case "rejected":
          return { index, kind: step.kind, ok: false, outcome: "rejected", detail: `${result.check}: ${result.codes.join(",")}`.slice(0, 300) }
        case "failed":
          return { index, kind: step.kind, ok: false, outcome: "failed", detail: result.step }
      }
    }
    // 여기까지 온 step은 correct-ready뿐이다 (종류마다 위에서 명시적으로 분기하고 끝낸다 — 타입이 강제한다).
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
