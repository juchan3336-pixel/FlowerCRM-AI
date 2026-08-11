import { describe, expect, it } from "vitest"

import { actualCostSoFar, decidePublishLinkBanner, planBatchStart, summarizeBatchTotals } from "@/lib/batch/batch-view"
import type { BatchCandidateDecision } from "@/lib/batch/candidate-policy"
import { BATCH_MAX_ITEMS } from "@/lib/batch/types"

const eligible: BatchCandidateDecision = { eligible: true, mode: "condolence" }
const decisions = (entries: readonly (readonly [string, BatchCandidateDecision])[]) => new Map(entries)
// 상한 초과 케이스는 상수에서 만든다 — 상한이 바뀌어도 테스트가 계약을 계속 검증한다.
const overCapIds = Array.from({ length: BATCH_MAX_ITEMS + 1 }, (_, index) => `p${String(index)}`)

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

  it("rejects empty, duplicate, over-cap, unapproved, ineligible and over-budget starts", () => {
    expect(planBatchStart({ ...base, placeIds: [], decisions: decisions([]) })).toEqual({ kind: "invalid", reason: "empty" })
    expect(planBatchStart({ ...base, placeIds: ["a", "a"], decisions: decisions([["a", eligible]]) })).toEqual({ kind: "invalid", reason: "duplicate" })
    expect(
      planBatchStart({ ...base, placeIds: overCapIds, decisions: decisions(overCapIds.map((id) => [id, eligible])) }),
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

describe("게시 연결 배너 판정", () => {
  const base = { isPublishRun: false, isRunning: false, publishableStatusCount: 4, draftPlaceCount: 4 }

  it("shows the publish CTA only for still-draft places", () => {
    expect(decidePublishLinkBanner(base)).toEqual({ kind: "publishable", draftCount: 4 })
    // pump가 일부만 게시한 경우 — 남은 draft 수만 센다
    expect(decidePublishLinkBanner({ ...base, draftPlaceCount: 1 })).toEqual({ kind: "publishable", draftCount: 1 })
  })

  it("replaces the CTA with an auto-published notice when every eligible place left draft", () => {
    // 2026-08-10 사례: item은 ready·warn_ready 그대로인데 4곳 전부 published — CTA를 내리고 완료 안내
    expect(decidePublishLinkBanner({ ...base, draftPlaceCount: 0 })).toEqual({ kind: "auto-published", publishableCount: 4 })
  })

  it("stays hidden while running, on publish runs, and with no eligible items", () => {
    expect(decidePublishLinkBanner({ ...base, isRunning: true })).toEqual({ kind: "none" })
    expect(decidePublishLinkBanner({ ...base, isPublishRun: true })).toEqual({ kind: "none" })
    expect(decidePublishLinkBanner({ ...base, publishableStatusCount: 0, draftPlaceCount: 0 })).toEqual({ kind: "none" })
  })
})
