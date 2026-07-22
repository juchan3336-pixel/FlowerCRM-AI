// Batch 시작 계획·집계 순수 로직 — 서버 액션과 진행 화면이 공유하고 테스트로 고정한다.
import type { BatchRunItemRow, Json } from "@/types/database"
import type { BatchCandidateDecision } from "./candidate-policy"
import { estimateBatchCost, isEstimateOverLimit, type BatchCostEstimate } from "./cost-policy"
import { BATCH_MAX_ITEMS } from "./types"

export type BatchStartPlan =
  | { readonly kind: "ok"; readonly placeIds: readonly string[]; readonly estimate: BatchCostEstimate }
  | { readonly kind: "invalid"; readonly reason: "empty" | "too-many" | "duplicate" | "official-check-required" | "ineligible" | "cost-limit"; readonly detail?: string }

export function planBatchStart(input: Readonly<{
  placeIds: readonly string[]
  decisions: ReadonlyMap<string, BatchCandidateDecision>
  officialCheckApproved: boolean
  maxCostUsd: number
  usdKrwRate: number
}>): BatchStartPlan {
  const unique = [...new Set(input.placeIds)]
  if (unique.length !== input.placeIds.length) {
    return { kind: "invalid", reason: "duplicate" }
  }
  if (unique.length === 0) {
    return { kind: "invalid", reason: "empty" }
  }
  if (unique.length > BATCH_MAX_ITEMS) {
    return { kind: "invalid", reason: "too-many" }
  }
  if (!input.officialCheckApproved) {
    return { kind: "invalid", reason: "official-check-required" }
  }
  for (const placeId of unique) {
    const decision = input.decisions.get(placeId)
    if (!decision?.eligible) {
      return { kind: "invalid", reason: "ineligible", detail: decision === undefined ? placeId : `${placeId}:${decision.reason}` }
    }
  }
  const estimate = estimateBatchCost(unique.length, input.usdKrwRate)
  if (isEstimateOverLimit(estimate, input.maxCostUsd)) {
    return { kind: "invalid", reason: "cost-limit" }
  }
  return { kind: "ok", placeIds: unique, estimate }
}

export type BatchTotals = {
  readonly items: number
  readonly ready: number
  readonly warn_ready: number
  readonly needs_review: number
  readonly failed: number
  readonly skipped: number
  readonly interrupted: number
  readonly published: number
  readonly publish_failed: number
  readonly tokens_input: number
  readonly tokens_output: number
  readonly actual_cost_usd: number
}

export function summarizeBatchTotals(items: readonly Pick<BatchRunItemRow, "status" | "tokens_input" | "tokens_output" | "cost_usd">[]): BatchTotals {
  const totals = {
    items: items.length,
    ready: 0,
    warn_ready: 0,
    needs_review: 0,
    failed: 0,
    skipped: 0,
    interrupted: 0,
    published: 0,
    publish_failed: 0,
    tokens_input: 0,
    tokens_output: 0,
    actual_cost_usd: 0,
  }
  for (const item of items) {
    switch (item.status) {
      case "ready":
        totals.ready += 1
        break
      case "warn_ready":
        totals.warn_ready += 1
        break
      case "needs_review":
        totals.needs_review += 1
        break
      case "failed":
        totals.failed += 1
        break
      case "skipped":
        totals.skipped += 1
        break
      case "interrupted":
        totals.interrupted += 1
        break
      case "published":
        totals.published += 1
        break
      case "publish_failed":
        totals.publish_failed += 1
        break
      default:
        break
    }
    totals.tokens_input += item.tokens_input ?? 0
    totals.tokens_output += item.tokens_output ?? 0
    totals.actual_cost_usd += item.cost_usd ?? 0
  }
  // 부동소수 잔여 정리 (표시용 6자리)
  totals.actual_cost_usd = Math.round(totals.actual_cost_usd * 1e6) / 1e6
  return totals
}

export function totalsToJson(totals: BatchTotals): Json {
  return totals
}

// 실제 누적 비용 — 실패·재시도 비용 포함(item.cost_usd에 합산 기록됨).
export function actualCostSoFar(items: readonly Pick<BatchRunItemRow, "cost_usd">[]): number {
  return items.reduce((total, item) => total + (item.cost_usd ?? 0), 0)
}
