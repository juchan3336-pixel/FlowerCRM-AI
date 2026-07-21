import type { AiGenerationStatus } from "@/lib/domain/constants"
import type { SyncedPlace } from "@/lib/sync/types"
import type { TitleNormalization } from "./title-normalization"

export type AiFaqItem = {
  readonly question: string
  readonly answer: string
}

export type AiInternalLink = {
  readonly href: string
  readonly label: string
}

export type AiGeneratedSeoContent = {
  readonly description: string
  readonly meta_title: string
  readonly meta_description: string
  readonly faq: readonly AiFaqItem[]
  readonly keywords: readonly string[]
  readonly internal_links: readonly AiInternalLink[]
}

export type AiGenerationRecord = {
  readonly id: string
  readonly place_id: string
  readonly status: AiGenerationStatus
  readonly input: AiGenerationInput
  readonly output: AiGeneratedSeoContent
  readonly before: AiAppliedSeoSnapshot | null
  readonly after: AiGeneratedSeoContent | null
  readonly created_at: string
  readonly applied_at: string | null
}

export type AiGenerationInput = {
  readonly place: {
    readonly id: string
    readonly name: string
    readonly category: string
    readonly city: string | null
    readonly district: string | null
    readonly address: string | null
    readonly homepage: string | null
  }
  readonly guardrails: readonly string[]
  // 제목·키워드 다양화 v1 계획 — 코드가 확정한 제목·키워드를 모델이 그대로 사용하게 한다 (input jsonb에 저장되어 감사 가능).
  readonly content_plan?: {
    readonly title: string
    readonly title_pattern_id: string
    readonly keywords: readonly string[]
    readonly keyword_roles: readonly string[]
  }
}

export type AiAppliedSeoSnapshot = Pick<
  SyncedPlace,
  "description" | "meta_title" | "meta_description" | "faq" | "keywords" | "internal_links"
>

export type AiProvider = {
  readonly generateSeoContent: (input: AiGenerationInput) => Promise<unknown>
}

export type AiRepository = {
  readonly findPlaceById: (placeId: string) => Promise<SyncedPlace | undefined>
  readonly createAiGeneration: (input: NewAiGeneration) => Promise<AiGenerationRecord>
  readonly findAiGenerationById: (generationId: string) => Promise<AiGenerationRecord | undefined>
  readonly applyAiGeneration: (input: ApplyAiGenerationInput) => Promise<AiGenerationRecord>
}

export type AiGenerationUsage = {
  readonly input_tokens: number | null
  readonly output_tokens: number | null
  readonly total_tokens: number | null
}

export type AiGenerationMetadata = {
  readonly provider: string
  readonly model: string
  readonly usage: AiGenerationUsage | null
  readonly estimated_cost: number | null
}

export type NewAiGeneration = {
  readonly placeId: string
  readonly input: AiGenerationInput
  readonly output: AiGeneratedSeoContent
  readonly metadata?: AiGenerationMetadata
  // 제목 후처리 정규화 감사 기록 — 모델 원본 제목과 최종 제목을 output jsonb에 보존한다.
  readonly titleNormalization?: TitleNormalization
}

export type ApplyAiGenerationInput = {
  readonly generationId: string
  readonly before: AiAppliedSeoSnapshot
  readonly after: AiGeneratedSeoContent
}
