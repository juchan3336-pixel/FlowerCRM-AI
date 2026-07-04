import type { AiGenerationStatus } from "@/lib/domain/constants"
import type { SyncedPlace } from "@/lib/sync/types"

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

export type NewAiGeneration = {
  readonly placeId: string
  readonly input: AiGenerationInput
  readonly output: AiGeneratedSeoContent
}

export type ApplyAiGenerationInput = {
  readonly generationId: string
  readonly before: AiAppliedSeoSnapshot
  readonly after: AiGeneratedSeoContent
}
