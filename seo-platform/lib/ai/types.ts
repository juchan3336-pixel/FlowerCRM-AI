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
    // FAQ 조합 다양화 v1 — 코드가 확정한 FAQ topic pair와 선택 경로(hash/fallback/exhausted-min-overlap).
    readonly faq_topic_keys?: readonly string[]
    readonly faq_selection?: string
  }
}

// 품질 FAIL 복구 재시도 감사 기록 — 일반 재클릭과 구분해 output jsonb에 저장된다.
export type AiGenerationRetryAudit = {
  readonly of: string
  readonly reason: string
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

// 다양화 선택 감사 기록 — 어떤 제목 패턴·FAQ pair·키워드 역할이 어떤 경로(기본/회피 순환)로 결정됐는지.
// 신규 generation의 output.audit에 저장된다 (기존 generation 역보정 없음, 구 레코드는 null 파싱).
export type GenerationVariationAudit = {
  readonly title_pattern_id: string
  readonly title_suffix_key: string
  readonly title_fallback: boolean
  readonly keyword_roles: readonly string[]
  readonly keywords_rebuilt: boolean
  readonly faq_topic_keys: readonly string[]
  readonly faq_selection: "hash" | "fallback" | "exhausted-min-overlap"
  // 요약: 제목·키워드·FAQ 중 하나라도 기본(hash) 경로가 아니면 true
  readonly fallback: boolean
}

export type NewAiGeneration = {
  readonly placeId: string
  readonly input: AiGenerationInput
  readonly output: AiGeneratedSeoContent
  readonly metadata?: AiGenerationMetadata
  // 제목 후처리 정규화 감사 기록 — 모델 원본 제목과 최종 제목을 output jsonb에 보존한다.
  readonly titleNormalization?: TitleNormalization
  // 다양화 선택 감사 기록 — output.audit로 저장 (PR-S2)
  readonly audit?: GenerationVariationAudit
  // 품질 FAIL 복구 재시도일 때만 존재 — 원본 generation id와 사유를 보존한다.
  readonly retry?: AiGenerationRetryAudit
}

export type ApplyAiGenerationInput = {
  readonly generationId: string
  readonly before: AiAppliedSeoSnapshot
  readonly after: AiGeneratedSeoContent
}
