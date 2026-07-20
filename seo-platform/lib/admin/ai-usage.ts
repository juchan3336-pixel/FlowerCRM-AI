// 관리자 Dashboard AI 사용량 집계 — ai_generations를 읽기 전용으로 합산한다.
// fake provider는 실제 OpenAI 비용이 아니므로 비용·토큰 KPI에서 제외하고 건수만 구분 표기한다.
import { parseGenerationStoredMetadata, parseGenerationStoredQuality } from "@/lib/ai/generation-mapping"
import type { Json } from "@/types/database"

export const DEFAULT_USD_KRW_RATE = 1400

export type AiUsageGenerationRow = {
  readonly id: string
  readonly place_id: string
  readonly status: string
  readonly model: string | null
  readonly created_at: string
  readonly output: Json | null
}

export type AiUsageRecentItem = {
  readonly id: string
  readonly placeName: string
  readonly provider: string
  readonly model: string
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly totalTokens: number | null
  readonly estimatedCostUsd: number | null
  readonly estimatedCostKrw: number | null
  readonly createdAt: string
  readonly status: string
  readonly quality: "pass" | "warn" | "fail" | null
}

export type AiUsageSummary = {
  readonly totalGenerations: number
  readonly openAiGenerations: number
  readonly fakeGenerations: number
  readonly totalInputTokens: number
  readonly totalOutputTokens: number
  readonly totalTokens: number
  readonly totalCostUsd: number
  readonly totalCostKrw: number
  readonly averageCostUsd: number | null
  readonly qualityPassCount: number
  readonly qualityEvaluatedCount: number
  readonly usdKrwRate: number
  readonly recent: readonly AiUsageRecentItem[]
}

export function readUsdKrwRate(rawValue: string | undefined): number {
  const parsed = Number.parseFloat(rawValue ?? "")
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_USD_KRW_RATE
}

export function aggregateAiUsage(rows: readonly AiUsageGenerationRow[], placeNames: ReadonlyMap<string, string>, usdKrwRate: number): AiUsageSummary {
  // 동일 generation 중복 합산 방지
  const uniqueRows = [...new Map(rows.map((row) => [row.id, row])).values()]

  let openAiGenerations = 0
  let fakeGenerations = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalTokens = 0
  let totalCostUsd = 0
  let costedGenerations = 0
  let qualityPassCount = 0
  let qualityEvaluatedCount = 0

  for (const row of uniqueRows) {
    const metadata = parseGenerationStoredMetadata(row.output)
    const provider = metadata.provider ?? "unknown"
    const isOpenAi = provider === "openai"
    if (isOpenAi) {
      openAiGenerations += 1
    } else if (provider === "fake") {
      fakeGenerations += 1
    }

    // 토큰·비용 KPI는 실제 OpenAI 호출만 합산 (fake·구 레코드의 null은 0 처리 대신 제외)
    if (isOpenAi) {
      totalInputTokens += metadata.usage?.input_tokens ?? 0
      totalOutputTokens += metadata.usage?.output_tokens ?? 0
      totalTokens += metadata.usage?.total_tokens ?? 0
      if (metadata.estimatedCost !== null) {
        totalCostUsd += metadata.estimatedCost
        costedGenerations += 1
      }
    }

    const quality = parseGenerationStoredQuality(row.output)
    if (quality !== null) {
      qualityEvaluatedCount += 1
      if (quality.status === "pass") {
        qualityPassCount += 1
      }
    }
  }

  const recent = [...uniqueRows]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 5)
    .map((row) => {
      const metadata = parseGenerationStoredMetadata(row.output)
      const quality = parseGenerationStoredQuality(row.output)
      return {
        id: row.id,
        placeName: placeNames.get(row.place_id) ?? "알 수 없는 장소",
        provider: metadata.provider ?? "-",
        model: metadata.model ?? row.model ?? "-",
        inputTokens: metadata.usage?.input_tokens ?? null,
        outputTokens: metadata.usage?.output_tokens ?? null,
        totalTokens: metadata.usage?.total_tokens ?? null,
        estimatedCostUsd: metadata.estimatedCost,
        estimatedCostKrw: metadata.estimatedCost === null ? null : convertUsdToKrw(metadata.estimatedCost, usdKrwRate),
        createdAt: row.created_at,
        status: row.status,
        quality: quality?.status ?? null,
      }
    })

  return {
    totalGenerations: uniqueRows.length,
    openAiGenerations,
    fakeGenerations,
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    totalCostUsd,
    totalCostKrw: convertUsdToKrw(totalCostUsd, usdKrwRate),
    averageCostUsd: costedGenerations > 0 ? totalCostUsd / costedGenerations : null,
    qualityPassCount,
    qualityEvaluatedCount,
    usdKrwRate,
    recent,
  }
}

export function convertUsdToKrw(usd: number, rate: number): number {
  return Math.round(usd * rate)
}

// USD는 $0.000001 단위까지 식별 가능하게, 불필요한 0은 제거해 표시한다.
export function formatUsd(value: number | null): string {
  if (value === null) {
    return "—"
  }
  const fixed = value.toFixed(6)
  const trimmed = fixed.replace(/0+$/, "").replace(/\.$/, "")
  return `$${trimmed.length > 0 ? trimmed : "0"}`
}

export function formatKrw(value: number | null): string {
  return value === null ? "—" : `₩${value.toLocaleString("ko-KR")}`
}

export function formatTokens(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("ko-KR")
}
