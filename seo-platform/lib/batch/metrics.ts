// Batch 운영 지표 (PR-S4) — 순수 계산만 담는다.
// 핵심 지표는 기존 batch_runs/items(+seo_pages)만으로 계산되고, 이벤트 지표는 batch_run_events가 있어야 채워진다.
// 이벤트가 없으면(도입 이전 배치·기록 유실) 0/null로 강등되어 화면 오류 없이 표시된다.
import type { BatchRunEventRow, BatchRunItemRow, BatchRunRow } from "@/types/database"

export type BatchCoreMetrics = {
  readonly generateRuns: number
  readonly publishRuns: number
  readonly runSuccessRate: number | null
  readonly avgItemSeconds: number | null
  readonly avgCostUsd: number | null
  readonly estimatedVsActualRatio: number | null
  readonly readyRate: number | null
  readonly warnRate: number | null
  readonly failRate: number | null
  readonly publishItemSuccessRate: number | null
  readonly avgVerifySeconds: number | null
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length
}

function secondsBetween(start: string | null, finish: string | null): number | null {
  if (start === null || finish === null) {
    return null
  }
  const startMs = Date.parse(start)
  const finishMs = Date.parse(finish)
  return Number.isNaN(startMs) || Number.isNaN(finishMs) || finishMs < startMs ? null : (finishMs - startMs) / 1000
}

export function computeCoreMetrics(
  runs: readonly BatchRunRow[],
  items: readonly Pick<BatchRunItemRow, "status" | "quality_status" | "cost_usd" | "started_at" | "finished_at">[],
  verifySeconds: readonly number[],
): BatchCoreMetrics {
  const finishedRuns = runs.filter((run) => run.status !== "running")
  const generationItems = items.filter((item) => ["ready", "warn_ready", "needs_review", "failed"].includes(item.status) || item.quality_status !== null)
  const qualityItems = items.filter((item) => item.quality_status !== null)
  const publishItems = items.filter((item) => item.status === "published" || item.status === "publish_failed")
  const durations = items.map((item) => secondsBetween(item.started_at, item.finished_at)).filter((value): value is number => value !== null)
  const costs = items.map((item) => item.cost_usd).filter((value): value is number => value !== null && value > 0)

  // 예상 대비 실제: settings.estimated_cost_usd(생성 배치)와 totals.actual_cost_usd 비교
  const estimatePairs = runs
    .map((run) => {
      const settings = run.settings as Record<string, unknown> | null
      const totals = run.totals as Record<string, unknown> | null
      const estimated = typeof settings?.["estimated_cost_usd"] === "number" ? settings["estimated_cost_usd"] : null
      const actual = typeof totals?.["actual_cost_usd"] === "number" ? totals["actual_cost_usd"] : null
      return estimated !== null && estimated > 0 && actual !== null ? actual / estimated : null
    })
    .filter((value): value is number => value !== null)

  return {
    generateRuns: runs.filter((run) => run.kind === "generate").length,
    publishRuns: runs.filter((run) => run.kind === "publish").length,
    runSuccessRate: ratio(finishedRuns.filter((run) => run.status === "completed").length, finishedRuns.length),
    avgItemSeconds: average(durations),
    avgCostUsd: average(costs),
    estimatedVsActualRatio: average(estimatePairs),
    readyRate: ratio(generationItems.filter((item) => item.status === "ready" || item.status === "warn_ready").length, generationItems.length),
    warnRate: ratio(qualityItems.filter((item) => item.quality_status === "warn").length, qualityItems.length),
    failRate: ratio(qualityItems.filter((item) => item.quality_status === "fail").length, qualityItems.length),
    publishItemSuccessRate: ratio(publishItems.filter((item) => item.status === "published").length, publishItems.length),
    avgVerifySeconds: average([...verifySeconds]),
  }
}

export type BatchEventMetrics = {
  readonly eventCount: number
  readonly interruptedCount: number
  readonly resumeCount: number
  readonly cancelRequests: number
  readonly avgStepSeconds: Readonly<Record<string, number>>
  readonly verificationTransitions: Readonly<Record<string, number>>
}

export const EMPTY_EVENT_METRICS: BatchEventMetrics = {
  eventCount: 0,
  interruptedCount: 0,
  resumeCount: 0,
  cancelRequests: 0,
  avgStepSeconds: {},
  verificationTransitions: {},
}

// 이벤트 기반 지표 — 재개는 '이어서 진행' 기원(trigger=resume) 또는 interrupted→processing 재claim으로 집계한다.
export function computeEventMetrics(events: readonly BatchRunEventRow[]): BatchEventMetrics {
  if (events.length === 0) {
    return EMPTY_EVENT_METRICS
  }
  const interruptedCount = events.filter((event) => event.event_type === "item_interrupted_marked").length
  const resumeCount = events.filter((event) => {
    if (event.event_type !== "item_claimed") {
      return false
    }
    const trigger = typeof event.detail === "object" && event.detail !== null && !Array.isArray(event.detail) ? (event.detail as Record<string, unknown>)["trigger"] : null
    return event.from_status === "interrupted" || trigger === "resume"
  }).length
  const cancelRequests = events.filter((event) => event.event_type === "run_cancel_requested").length

  // 단계별 소요: item별 시간순 이벤트에서 단계 시작(claim/step_changed) → 다음 이벤트까지의 간격을 해당 단계 소요로 본다.
  const byItem = new Map<string, BatchRunEventRow[]>()
  for (const event of events) {
    if (event.item_id !== null) {
      const list = byItem.get(event.item_id) ?? []
      list.push(event)
      byItem.set(event.item_id, list)
    }
  }
  const stepDurations = new Map<string, number[]>()
  for (const list of byItem.values()) {
    const ordered = [...list].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const current = ordered[index]
      const next = ordered[index + 1]
      if (current === undefined || next === undefined || current.step === null) {
        continue
      }
      if (current.event_type !== "item_claimed" && current.event_type !== "item_step_changed") {
        continue
      }
      const seconds = (Date.parse(next.created_at) - Date.parse(current.created_at)) / 1000
      if (Number.isFinite(seconds) && seconds >= 0) {
        const list2 = stepDurations.get(current.step) ?? []
        list2.push(seconds)
        stepDurations.set(current.step, list2)
      }
    }
  }
  const avgStepSeconds: Record<string, number> = {}
  for (const [step, values] of stepDurations) {
    const avg = average(values)
    if (avg !== null) {
      avgStepSeconds[step] = avg
    }
  }

  const verificationTransitions: Record<string, number> = {}
  for (const event of events) {
    if (event.event_type === "verification_updated" && event.to_status !== null) {
      verificationTransitions[event.to_status] = (verificationTransitions[event.to_status] ?? 0) + 1
    }
  }

  return { eventCount: events.length, interruptedCount, resumeCount, cancelRequests, avgStepSeconds, verificationTransitions }
}
