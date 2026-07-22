// Batch 비용 정책 — 예상(시작 전 차단 판정)과 실제(누적, 실패·재시도 포함)를 분리해 계산한다.
// 상한 도달 시 현재 item은 완료하고 나머지는 skipped_cost_limit 사유로 건너뛴다.

// 13~16호점 실측 평균 (총 6 generation: 1,201±25 tokens, $0.00083±0.00004) — 예측 전용 상수.
export const ESTIMATED_TOKENS_PER_PLACE = 1250
export const ESTIMATED_COST_USD_PER_PLACE = 0.001

export const DEFAULT_MAX_COST_USD = 0.05

export const SKIP_REASON_COST_LIMIT = "skipped_cost_limit"

export type BatchCostEstimate = {
  readonly items: number
  readonly estimatedTokens: number
  readonly estimatedCostUsd: number
  readonly estimatedCostKrw: number
  readonly usdKrwRate: number
}

export function estimateBatchCost(items: number, usdKrwRate: number): BatchCostEstimate {
  const estimatedCostUsd = items * ESTIMATED_COST_USD_PER_PLACE
  return {
    items,
    estimatedTokens: items * ESTIMATED_TOKENS_PER_PLACE,
    estimatedCostUsd,
    estimatedCostKrw: Math.round(estimatedCostUsd * usdKrwRate),
    usdKrwRate,
  }
}

export function isEstimateOverLimit(estimate: BatchCostEstimate, maxCostUsd: number): boolean {
  return estimate.estimatedCostUsd > maxCostUsd
}

// 다음 item 시작 전 판정 — 실제 누적(실패·재시도 포함)이 상한 이상이면 잔여를 건너뛴다.
export function shouldSkipRemainingForCost(actualCostUsdSoFar: number, maxCostUsd: number): boolean {
  return actualCostUsdSoFar >= maxCostUsd
}
