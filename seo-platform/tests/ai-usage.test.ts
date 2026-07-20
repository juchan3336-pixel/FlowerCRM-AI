import { describe, expect, it } from "vitest"

import { aggregateAiUsage, convertUsdToKrw, DEFAULT_USD_KRW_RATE, formatKrw, formatUsd, readUsdKrwRate, type AiUsageGenerationRow } from "@/lib/admin/ai-usage"

function makeRow(overrides: Partial<AiUsageGenerationRow> & Pick<AiUsageGenerationRow, "id">): AiUsageGenerationRow {
  return {
    place_id: "place-1",
    status: "applied",
    model: "gpt-4.1-mini",
    created_at: "2026-07-20T09:00:00.000Z",
    output: {
      generated: { meta_title: "t" },
      provider: "openai",
      model: "gpt-4.1-mini",
      usage: { input_tokens: 700, output_tokens: 300, total_tokens: 1000 },
      estimated_cost: 0.0007,
      error_code: null,
      quality: { status: "pass", issues: [] },
    },
    ...overrides,
  }
}

const PLACE_NAMES = new Map([
  ["place-1", "남해병원 장례식장"],
  ["place-2", "대구보훈병원 장례식장"],
])

describe("ai usage aggregation", () => {
  it("sums openai tokens and costs and computes averages", () => {
    // Given: OpenAI 생성 2건.
    const rows = [
      makeRow({ id: "g1" }),
      makeRow({ id: "g2", place_id: "place-2", created_at: "2026-07-20T10:00:00.000Z", output: { provider: "openai", model: "gpt-4.1-mini", usage: { input_tokens: 800, output_tokens: 200, total_tokens: 1000 }, estimated_cost: 0.0009, error_code: null, quality: { status: "warn", issues: [] } } }),
    ]

    // When: 집계.
    const summary = aggregateAiUsage(rows, PLACE_NAMES, 1400)

    // Then: 토큰·비용 합산과 평균, 환산이 정확하다.
    expect(summary.totalGenerations).toBe(2)
    expect(summary.openAiGenerations).toBe(2)
    expect(summary.totalInputTokens).toBe(1500)
    expect(summary.totalOutputTokens).toBe(500)
    expect(summary.totalTokens).toBe(2000)
    expect(summary.totalCostUsd).toBeCloseTo(0.0016, 10)
    expect(summary.totalCostKrw).toBe(Math.round(0.0016 * 1400))
    expect(summary.averageCostUsd).toBeCloseTo(0.0008, 10)
    expect(summary.qualityPassCount).toBe(1)
    expect(summary.qualityEvaluatedCount).toBe(2)
  })

  it("separates fake provider generations from real cost totals", () => {
    // Given: fake 1건 + openai 1건.
    const rows = [
      makeRow({ id: "g1" }),
      makeRow({ id: "fake1", output: { provider: "fake", model: "fake-deterministic", usage: { input_tokens: 999, output_tokens: 999, total_tokens: 1998 }, estimated_cost: 0.5, error_code: null } }),
    ]

    // When / Then: fake 비용·토큰은 합계에서 제외되고 건수만 구분된다.
    const summary = aggregateAiUsage(rows, PLACE_NAMES, 1400)
    expect(summary.totalGenerations).toBe(2)
    expect(summary.fakeGenerations).toBe(1)
    expect(summary.totalCostUsd).toBeCloseTo(0.0007, 10)
    expect(summary.totalTokens).toBe(1000)
  })

  it("handles null usage and null cost safely", () => {
    // Given: 토큰·비용이 없는 구 레코드와 실패 레코드.
    const rows = [
      makeRow({ id: "g1", output: { generated: { meta_title: "t" }, provider: "openai", model: "gpt-4.1-mini", usage: null, estimated_cost: null, error_code: null } }),
      makeRow({ id: "g2" }),
    ]

    // When / Then: null은 0·제외 처리되고 평균 분모에는 비용 있는 건만 들어간다.
    const summary = aggregateAiUsage(rows, PLACE_NAMES, 1400)
    expect(summary.totalTokens).toBe(1000)
    expect(summary.totalCostUsd).toBeCloseTo(0.0007, 10)
    expect(summary.averageCostUsd).toBeCloseTo(0.0007, 10)
  })

  it("does not double-count duplicated generation rows", () => {
    // Given: 동일 id가 두 번 들어온 입력.
    const summary = aggregateAiUsage([makeRow({ id: "g1" }), makeRow({ id: "g1" })], PLACE_NAMES, 1400)

    // Then: 1건으로만 합산된다.
    expect(summary.totalGenerations).toBe(1)
    expect(summary.totalCostUsd).toBeCloseTo(0.0007, 10)
  })

  it("returns the five most recent generations sorted by created_at desc with place names", () => {
    // Given: 시각이 다른 6건.
    const rows = Array.from({ length: 6 }, (_, index) =>
      makeRow({ id: `g${String(index)}`, created_at: `2026-07-20T0${String(index)}:00:00.000Z`, place_id: index % 2 === 0 ? "place-1" : "place-2" }),
    )

    // When: 집계.
    const summary = aggregateAiUsage(rows, PLACE_NAMES, 1400)

    // Then: 최근 5건이 내림차순으로 반환되고 장소명이 매핑된다.
    expect(summary.recent).toHaveLength(5)
    expect(summary.recent.map((item) => item.id)).toEqual(["g5", "g4", "g3", "g2", "g1"])
    expect(summary.recent[0]?.placeName).toBe("대구보훈병원 장례식장")
    expect(summary.recent[0]?.estimatedCostKrw).toBe(Math.round(0.0007 * 1400))
    expect(summary.recent[0]?.quality).toBe("pass")
  })

  it("reads the USD→KRW rate from env with a safe default", () => {
    // Given / When / Then: 유효값은 사용, 없거나 잘못된 값은 기본 환율.
    expect(readUsdKrwRate("1350.5")).toBe(1350.5)
    expect(readUsdKrwRate(undefined)).toBe(DEFAULT_USD_KRW_RATE)
    expect(readUsdKrwRate("abc")).toBe(DEFAULT_USD_KRW_RATE)
    expect(readUsdKrwRate("-1")).toBe(DEFAULT_USD_KRW_RATE)
  })

  it("formats USD to micro precision and KRW to whole won", () => {
    // Given / When / Then: 표시 형식 규칙.
    expect(formatUsd(0.000741)).toBe("$0.000741")
    expect(formatUsd(0.0016)).toBe("$0.0016")
    expect(formatUsd(null)).toBe("—")
    expect(convertUsdToKrw(0.000741, 1400)).toBe(1)
    expect(formatKrw(1)).toBe("₩1")
    expect(formatKrw(null)).toBe("—")
  })
})
