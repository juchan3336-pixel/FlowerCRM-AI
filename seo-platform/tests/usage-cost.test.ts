import { describe, expect, it } from "vitest"

import { estimateUsageCostUsd } from "@/lib/ai/usage-cost"

describe("ai usage cost helper", () => {
  it("estimates cost for a known model from real token usage", () => {
    // Given / When: gpt-4o-mini with measured tokens.
    const cost = estimateUsageCostUsd("gpt-4o-mini", { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 })

    // Then: the estimate follows the single pricing table (0.15/0.6 per 1M).
    expect(cost).toBeCloseTo(0.00045, 6)
  })

  it("refuses to guess for unknown models", () => {
    // Given / When / Then: unknown models return null instead of a made-up price.
    expect(estimateUsageCostUsd("future-model-x", { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 })).toBeNull()
  })

  it("returns null when usage is incomplete", () => {
    // Given / When / Then: missing usage keeps the cost unknown.
    expect(estimateUsageCostUsd("gpt-4o-mini", null)).toBeNull()
    expect(estimateUsageCostUsd(null, { input_tokens: 1, output_tokens: 1, total_tokens: 2 })).toBeNull()
    expect(estimateUsageCostUsd("gpt-4o-mini", { input_tokens: null, output_tokens: 500, total_tokens: null })).toBeNull()
  })
})
