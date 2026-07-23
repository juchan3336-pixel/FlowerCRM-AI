import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { BatchMetricsBoard } from "@/app/admin/batch/page"
import { EMPTY_DURATION_METRICS, EMPTY_EVENT_METRICS, type BatchCoreMetrics, type BatchDurationMetrics } from "@/lib/batch/metrics"

const CORE: BatchCoreMetrics = {
  generateRuns: 3,
  publishRuns: 3,
  runSuccessRate: 1,
  avgCostUsd: 0.0008,
  estimatedVsActualRatio: 0.82,
  readyRate: 0.9,
  warnRate: 0,
  failRate: 0,
  publishItemSuccessRate: 1,
  avgVerifySeconds: 3.7,
}

const DURATIONS: BatchDurationMetrics = {
  avgAutoProcessingSeconds: 5.9,
  autoProcessingSamples: 17,
  autoProcessingApproximateSamples: 10,
  avgReviewWaitSeconds: 85762,
  reviewWaitSamples: 1,
  pendingReviewItems: 2,
  avgTotalElapsedSeconds: 5052.2,
  totalElapsedSamples: 17,
}

describe("운영 지표 보드 — 처리시간 3분할 표시", () => {
  it("shows the three separated duration metrics with sample composition", () => {
    const html = renderToStaticMarkup(<BatchMetricsBoard core={CORE} durations={DURATIONS} eventMetrics={{ ...EMPTY_EVENT_METRICS, eventCount: 29 }} />)

    expect(html).toContain("평균 자동 처리시간")
    expect(html).toContain("5.9초")
    // 근사·정밀 표본을 UI에서 구분한다.
    expect(html).toContain("정밀 7건 · 근사 10건")
    expect(html).toContain("평균 검토 대기시간")
    expect(html).toContain("85762.0초")
    expect(html).toContain("대기 중 2건")
    expect(html).toContain("평균 총 경과시간")
    expect(html).toContain("5052.2초")
    expect(html).toContain("검토 대기 포함")
    // 왜곡되던 단일 지표 명칭은 더 이상 쓰지 않는다.
    expect(html).not.toContain("평균 처리 시간(장소)")
  })

  it("degrades safely when there is no data at all", () => {
    const html = renderToStaticMarkup(
      <BatchMetricsBoard
        core={{ ...CORE, runSuccessRate: null, avgCostUsd: null, estimatedVsActualRatio: null, readyRate: null, warnRate: null, failRate: null, publishItemSuccessRate: null, avgVerifySeconds: null }}
        durations={EMPTY_DURATION_METRICS}
        eventMetrics={EMPTY_EVENT_METRICS}
      />,
    )

    expect(html).toContain("표본 없음")
    expect(html).toContain("검토 대기로 처리된 장소 없음")
    expect(html).toContain("이벤트 기반 지표")
    expect(html).not.toContain("NaN")
    expect(html).not.toContain("Infinity")
  })

  it("hides the pending note when nothing is waiting for review", () => {
    const html = renderToStaticMarkup(
      <BatchMetricsBoard core={CORE} durations={{ ...DURATIONS, pendingReviewItems: 0 }} eventMetrics={{ ...EMPTY_EVENT_METRICS, eventCount: 1 }} />,
    )
    expect(html).not.toContain("대기 중")
  })
})
