import { describe, expect, it } from "vitest"

import { computeDurationMetrics, EMPTY_DURATION_METRICS } from "@/lib/batch/metrics"
import type { BatchRunEventRow, BatchRunItemRow } from "@/types/database"

type DurationItem = Pick<BatchRunItemRow, "id" | "status" | "started_at" | "finished_at">

function item(overrides: Partial<DurationItem>): DurationItem {
  return { id: "i1", status: "ready", started_at: "2026-07-22T00:00:00Z", finished_at: "2026-07-22T00:00:10Z", ...overrides }
}

let sequence = 0
function event(overrides: Partial<BatchRunEventRow>): BatchRunEventRow {
  sequence += 1
  return {
    id: `e${String(sequence)}`,
    batch_id: "b1",
    item_id: "i1",
    event_type: "item_claimed",
    from_status: null,
    to_status: null,
    step: null,
    actor: null,
    detail: {},
    idempotency_key: `k${String(sequence)}`,
    created_at: "2026-07-22T00:00:00Z",
    ...overrides,
  }
}

describe("처리시간 3분할 — 자동 처리 / 검토 대기 / 총 경과", () => {
  it("measures only the claim → result span as automatic processing", () => {
    // 08:00:00 claim → 08:00:12 결과 기록. 그 뒤 검증 이벤트는 구간 밖이다.
    const events = [
      event({ event_type: "item_claimed", created_at: "2026-07-22T08:00:00Z", detail: { trigger: "auto" } }),
      event({ event_type: "item_step_changed", step: "applying", created_at: "2026-07-22T08:00:05Z" }),
      event({ event_type: "item_result_recorded", to_status: "ready", created_at: "2026-07-22T08:00:12Z" }),
    ]
    const metrics = computeDurationMetrics([item({ started_at: "2026-07-22T08:00:00Z", finished_at: "2026-07-22T08:00:12Z" })], events)

    expect(metrics.avgAutoProcessingSeconds).toBe(12)
    expect(metrics.autoProcessingSamples).toBe(1)
    expect(metrics.autoProcessingApproximateSamples).toBe(0)
    // needs_review를 거치지 않았으므로 검토 대기 표본은 없다.
    expect(metrics.avgReviewWaitSeconds).toBeNull()
    expect(metrics.reviewWaitSamples).toBe(0)
    expect(metrics.pendingReviewItems).toBe(0)
    expect(metrics.avgTotalElapsedSeconds).toBe(12)
  })

  it("excludes the overnight review wait from automatic processing but keeps it in total elapsed", () => {
    // 삼천포서울병원 실측 형태: 07-22 생성(12초) → needs_review → 하루 대기 → 07-23 검토 재개(10초) → ready.
    const events = [
      event({ event_type: "item_claimed", created_at: "2026-07-22T08:08:33Z", detail: { trigger: "auto" } }),
      event({ event_type: "item_result_recorded", to_status: "needs_review", created_at: "2026-07-22T08:08:45Z" }),
      event({ event_type: "item_claimed", from_status: "needs_review", step: "checking", created_at: "2026-07-23T07:58:07Z", detail: { trigger: "review" } }),
      event({ event_type: "item_step_changed", step: "applying", created_at: "2026-07-23T07:58:12Z" }),
      event({ event_type: "item_result_recorded", to_status: "ready", created_at: "2026-07-23T07:58:17Z" }),
    ]
    const metrics = computeDurationMetrics([item({ started_at: "2026-07-22T08:08:33Z", finished_at: "2026-07-23T07:58:17Z" })], events)

    // 자동 처리 = 12초(생성) + 10초(검토 해소) = 22초. 하루치 대기는 제외된다.
    expect(metrics.avgAutoProcessingSeconds).toBe(22)
    expect(metrics.autoProcessingApproximateSamples).toBe(0)
    // 검토 대기 = 08:08:45 → 07:58:07 (85,762초)
    expect(metrics.avgReviewWaitSeconds).toBe(85762)
    expect(metrics.reviewWaitSamples).toBe(1)
    expect(metrics.pendingReviewItems).toBe(0)
    // 총 경과에는 대기가 포함된다 (85,784초) — 왜곡이 아니라 명시된 지표다.
    expect(metrics.avgTotalElapsedSeconds).toBe(85784)
  })

  it("counts an unresolved needs_review item as pending instead of averaging it", () => {
    const events = [
      event({ event_type: "item_claimed", created_at: "2026-07-22T08:00:00Z", detail: { trigger: "auto" } }),
      event({ event_type: "item_result_recorded", to_status: "needs_review", created_at: "2026-07-22T08:00:09Z" }),
    ]
    const metrics = computeDurationMetrics([item({ status: "needs_review", started_at: "2026-07-22T08:00:00Z", finished_at: "2026-07-22T08:00:09Z" })], events)

    expect(metrics.avgAutoProcessingSeconds).toBe(9)
    expect(metrics.avgReviewWaitSeconds).toBeNull()
    expect(metrics.reviewWaitSamples).toBe(0)
    expect(metrics.pendingReviewItems).toBe(1)
  })

  it("falls back to total elapsed for batches recorded before the event log, marking them approximate", () => {
    const metrics = computeDurationMetrics(
      [
        item({ id: "old", started_at: "2026-07-20T00:00:00Z", finished_at: "2026-07-20T00:00:30Z" }),
        item({ id: "i1", started_at: "2026-07-22T08:00:00Z", finished_at: "2026-07-22T08:00:10Z" }),
      ],
      [
        event({ item_id: "i1", event_type: "item_claimed", created_at: "2026-07-22T08:00:00Z" }),
        event({ item_id: "i1", event_type: "item_result_recorded", to_status: "ready", created_at: "2026-07-22T08:00:10Z" }),
      ],
    )
    // 이벤트 없는 old는 총 경과(30초)로 근사, 이벤트 있는 i1은 정밀(10초).
    expect(metrics.autoProcessingSamples).toBe(2)
    expect(metrics.autoProcessingApproximateSamples).toBe(1)
    expect(metrics.avgAutoProcessingSeconds).toBe(20)
    expect(metrics.avgTotalElapsedSeconds).toBe(20)
  })

  it("treats an event-less needs_review item as pending review", () => {
    const metrics = computeDurationMetrics([item({ id: "old", status: "needs_review", started_at: "2026-07-20T00:00:00Z", finished_at: "2026-07-20T00:00:30Z" })], [])
    expect(metrics.pendingReviewItems).toBe(1)
    expect(metrics.autoProcessingApproximateSamples).toBe(1)
  })

  it("excludes the interrupted wait between resume claims from automatic processing", () => {
    const events = [
      event({ event_type: "item_claimed", created_at: "2026-07-22T08:00:00Z", detail: { trigger: "auto" } }),
      event({ event_type: "item_result_recorded", to_status: "interrupted", created_at: "2026-07-22T08:00:06Z" }),
      event({ event_type: "item_claimed", from_status: "interrupted", created_at: "2026-07-22T09:00:00Z", detail: { trigger: "resume" } }),
      event({ event_type: "item_result_recorded", to_status: "ready", created_at: "2026-07-22T09:00:04Z" }),
    ]
    const metrics = computeDurationMetrics([item({ started_at: "2026-07-22T08:00:00Z", finished_at: "2026-07-22T09:00:04Z" })], events)

    // 자동 처리 = 6 + 4 = 10초. 1시간 중단 대기는 제외되고, 총 경과에만 남는다.
    expect(metrics.avgAutoProcessingSeconds).toBe(10)
    expect(metrics.avgTotalElapsedSeconds).toBe(3604)
    // interrupted는 needs_review가 아니므로 검토 대기 표본이 아니다.
    expect(metrics.reviewWaitSamples).toBe(0)
    expect(metrics.pendingReviewItems).toBe(0)
  })

  it("never folds publish verification time into automatic processing", () => {
    const events = [
      event({ event_type: "item_claimed", step: "publishing", created_at: "2026-07-23T08:15:42Z", detail: { trigger: "auto" } }),
      event({ event_type: "item_result_recorded", to_status: "published", created_at: "2026-07-23T08:15:45Z" }),
      // 공개 검증은 결과 기록 이후에 도착한다 — avgVerifySeconds 전용 지표이며 여기서는 합산되지 않는다.
      event({ event_type: "verification_updated", to_status: "verified", created_at: "2026-07-23T08:15:48Z" }),
    ]
    const metrics = computeDurationMetrics([item({ status: "published", started_at: "2026-07-23T08:15:42Z", finished_at: "2026-07-23T08:15:45Z" })], events)

    expect(metrics.avgAutoProcessingSeconds).toBe(3)
    expect(metrics.avgTotalElapsedSeconds).toBe(3)
  })

  it("degrades safely with no items or no events", () => {
    expect(computeDurationMetrics([], [])).toEqual(EMPTY_DURATION_METRICS)
    const noEvents = computeDurationMetrics([item({ started_at: null, finished_at: null })], [])
    expect(noEvents.avgAutoProcessingSeconds).toBeNull()
    expect(noEvents.avgTotalElapsedSeconds).toBeNull()
    expect(noEvents.avgReviewWaitSeconds).toBeNull()
    expect(noEvents.autoProcessingSamples).toBe(0)
    expect(noEvents.totalElapsedSamples).toBe(0)
  })
})
