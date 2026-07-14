import type { AiGenerationUsage } from "./types"

// 모델 단가는 이 테이블 한 곳에서만 관리한다 (USD, 1M 토큰당 · 참고용 추정치).
// 목록에 없는 모델은 임의 가격을 적용하지 않고 "계산 불가"(null)로 처리한다.
const OPENAI_PRICING_PER_MILLION_TOKENS_USD: Record<string, Readonly<{ input: number; output: number }>> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
}

export function estimateUsageCostUsd(model: string | null, usage: AiGenerationUsage | null): number | null {
  if (model === null || usage === null) {
    return null
  }

  const pricing = OPENAI_PRICING_PER_MILLION_TOKENS_USD[model]
  if (pricing === undefined || usage.input_tokens === null || usage.output_tokens === null) {
    return null
  }

  const cost = (usage.input_tokens * pricing.input + usage.output_tokens * pricing.output) / 1_000_000
  return Math.round(cost * 1_000_000) / 1_000_000
}
