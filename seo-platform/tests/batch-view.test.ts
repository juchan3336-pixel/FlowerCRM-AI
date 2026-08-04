import { describe, expect, it } from "vitest"

import { actualCostSoFar, planBatchStart, summarizeBatchTotals } from "@/lib/batch/batch-view"
import type { BatchCandidateDecision } from "@/lib/batch/candidate-policy"

const eligible: BatchCandidateDecision = { eligible: true, mode: "condolence" }
const decisions = (entries: readonly (readonly [string, BatchCandidateDecision])[]) => new Map(entries)

describe("Batch 시작 계획 검증", () => {
  const base = { officialCheckApproved: true, maxCostUsd: 0.05, usdKrwRate: 1400 }

  it("accepts up to five unique eligible places and returns the estimate", () => {
    const plan = planBatchStart({ ...base, placeIds: ["a", "b", "c"], decisions: decisions([["a", eligible], ["b", eligible], ["c", eligible]]) })
    expect(plan.kind).toBe("ok")
    if (plan.kind === "ok") {
      expect(plan.placeIds).toEqual(["a", "b", "c"])
      expect(plan.estimate.items).toBe(3)
    }
  })

  it("rejects empty, duplicate, over-five, unapproved, ineligible and over-budget starts", () => {
    expect(planBatchStart({ ...base, placeIds: [], decisions: decisions([]) })).toEqual({ kind: "invalid", reason: "empty" })
    expect(planBatchStart({ ...base, placeIds: ["a", "a"], decisions: decisions([["a", eligible]]) })).toEqual({ kind: "invalid", reason: "duplicate" })
    expect(
      planBatchStart({ ...base, placeIds: ["a", "b", "c", "d", "e", "f"], decisions: decisions([["a", eligible], ["b", eligible], ["c", eligible], ["d", eligible], ["e", eligible], ["f", eligible]]) }),
    ).toEqual({ kind: "invalid", reason: "too-many" })
    expect(planBatchStart({ ...base, officialCheckApproved: false, placeIds: ["a"], decisions: decisions([["a", eligible]]) })).toEqual({
      kind: "invalid",
      reason: "official-check-required",
    })
    const ineligiblePlan = planBatchStart({ ...base, placeIds: ["a"], decisions: decisions([["a", { eligible: false, reason: "not-verified", mode: "condolence" }]]) })
    expect(ineligiblePlan).toEqual({ kind: "invalid", reason: "ineligible", detail: "a:not-verified" })
    // 미지의 placeId(판정 없음)도 차단
    expect(planBatchStart({ ...base, placeIds: ["ghost"], decisions: decisions([]) })).toEqual({ kind: "invalid", reason: "ineligible", detail: "ghost" })
    expect(planBatchStart({ ...base, maxCostUsd: 0.0005, placeIds: ["a"], decisions: decisions([["a", eligible]]) })).toEqual({ kind: "invalid", reason: "cost-limit" })
  })
})

describe("Batch 집계", () => {
  const item = (status: string, tokens: [number, number] | null, cost: number | null) => ({
    status: status as never,
    tokens_input: tokens?.[0] ?? null,
    tokens_output: tokens?.[1] ?? null,
    cost_usd: cost,
  })

  it("counts statuses and sums tokens/actual cost including failed and retried items", () => {
    const totals = summarizeBatchTotals([
      item("ready", [900, 300], 0.0008),
      item("warn_ready", [950, 280], 0.0008),
      // 실패 건 비용도 실제 합계에 포함 (재시도 비용은 item cost에 합산 기록됨)
      item("failed", [1800, 600], 0.0017),
      item("skipped", null, null),
      item("queued", null, null),
    ])
    expect(totals.items).toBe(5)
    expect(totals.ready).toBe(1)
    expect(totals.warn_ready).toBe(1)
    expect(totals.failed).toBe(1)
    expect(totals.skipped).toBe(1)
    expect(totals.tokens_input).toBe(3650)
    expect(totals.tokens_output).toBe(1180)
    expect(totals.actual_cost_usd).toBeCloseTo(0.0033, 10)
    expect(actualCostSoFar([item("ready", null, 0.001), item("failed", null, 0.002)])).toBeCloseTo(0.003, 10)
  })
})
