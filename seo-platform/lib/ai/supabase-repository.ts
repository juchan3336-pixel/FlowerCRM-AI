import "server-only"

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { SyncedPlace } from "@/lib/sync/types"
import type { PlaceRow } from "@/types/database"
import { aiGenerationRowToRecord, mergeGenerationOutputWrapper, wrapFailedGenerationOutput, wrapGenerationInput, wrapGenerationOutput } from "./generation-mapping"
import type { AiGenerationRecord, AiRepository, ApplyAiGenerationInput, NewAiGeneration } from "./types"

export const AI_GENERATION_TYPE = "seo_content"
export const AI_GENERATION_MODEL = "FakeDeterministicAiProvider"

const AI_GENERATION_SELECT = "id, place_id, status, input, output, model, created_at, applied_at"

export function createSupabaseAiRepository(): AiRepository {
  const client = createSupabaseServiceRoleClient()

  return {
    async findPlaceById(placeId: string): Promise<SyncedPlace | undefined> {
      const { data, error } = await client.from("places").select("*").eq("id", placeId).maybeSingle()
      if (error !== null) {
        throw new SupabaseAiRepositoryError("read place", error.message)
      }
      return data === null ? undefined : placeRowToSyncedPlace(data)
    },
    async createAiGeneration(input: NewAiGeneration): Promise<AiGenerationRecord> {
      const { data, error } = await client
        .from("ai_generations")
        .insert({
          place_id: input.placeId,
          generation_type: AI_GENERATION_TYPE,
          model: input.metadata?.model ?? AI_GENERATION_MODEL,
          status: "preview",
          input: wrapGenerationInput(input.input, null),
          output: wrapGenerationOutput(input.output, null, input.metadata ?? null),
        })
        .select(AI_GENERATION_SELECT)
        .single()
      if (error !== null) {
        throw new SupabaseAiRepositoryError("create generation", error.message)
      }
      return aiGenerationRowToRecord(data)
    },
    async findAiGenerationById(generationId: string): Promise<AiGenerationRecord | undefined> {
      const { data, error } = await client.from("ai_generations").select(AI_GENERATION_SELECT).eq("id", generationId).maybeSingle()
      if (error !== null) {
        throw new SupabaseAiRepositoryError("read generation", error.message)
      }
      return data === null ? undefined : aiGenerationRowToRecord(data)
    },
    async applyAiGeneration(input: ApplyAiGenerationInput): Promise<AiGenerationRecord> {
      const { data: current, error: readError } = await client
        .from("ai_generations")
        .select(AI_GENERATION_SELECT)
        .eq("id", input.generationId)
        .maybeSingle()
      if (readError !== null) {
        throw new SupabaseAiRepositoryError("read generation", readError.message)
      }
      if (current === null) {
        throw new SupabaseAiRepositoryError("read generation", `generation not found: ${input.generationId}`)
      }
      const generation = aiGenerationRowToRecord(current)

      const appliedAt = new Date().toISOString()
      const { error: placeError } = await client
        .from("places")
        .update({
          description: input.after.description,
          meta_title: input.after.meta_title,
          meta_description: input.after.meta_description,
          faq: input.after.faq,
          keywords: input.after.keywords,
          internal_links: input.after.internal_links,
        })
        .eq("id", generation.place_id)
      if (placeError !== null) {
        throw new SupabaseAiRepositoryError("apply content to place", placeError.message)
      }

      const { data: updated, error: updateError } = await client
        .from("ai_generations")
        .update({
          status: "applied",
          applied_at: appliedAt,
          input: wrapGenerationInput(generation.input, input.before),
          output: mergeGenerationOutputWrapper(current.output, generation.output, input.after),
        })
        .eq("id", input.generationId)
        .select(AI_GENERATION_SELECT)
        .single()
      if (updateError !== null) {
        throw new SupabaseAiRepositoryError("mark generation applied", updateError.message)
      }
      return aiGenerationRowToRecord(updated)
    },
  }
}

// 실패 이력 기록 — AiRepository 계약 밖의 별도 함수. 안전한 오류 코드만 저장하고 raw 응답·secret은 저장하지 않는다.
export async function recordFailedAiGeneration(input: Readonly<{ placeId: string; provider: string; model: string | null; errorCode: string }>): Promise<void> {
  const client = createSupabaseServiceRoleClient()
  const { error } = await client.from("ai_generations").insert({
    place_id: input.placeId,
    generation_type: AI_GENERATION_TYPE,
    model: input.model ?? "unknown",
    status: "failed",
    input: null,
    output: wrapFailedGenerationOutput({ provider: input.provider, model: input.model }, input.errorCode),
  })
  if (error !== null) {
    throw new SupabaseAiRepositoryError("record failed generation", error.message)
  }
}

// DB 기준 중복 차단(최종 안전장치): 최근 N초 내 생성된 preview가 있으면 새 생성을 막는다.
export async function hasRecentPreviewAiGeneration(placeId: string, withinSeconds: number): Promise<boolean> {
  const client = createSupabaseServiceRoleClient()
  const cutoff = new Date(Date.now() - withinSeconds * 1000).toISOString()
  const { data, error } = await client
    .from("ai_generations")
    .select("id")
    .eq("place_id", placeId)
    .eq("status", "preview")
    .gte("created_at", cutoff)
    .limit(1)
    .maybeSingle()
  if (error !== null) {
    throw new SupabaseAiRepositoryError("check recent preview", error.message)
  }
  return data !== null
}

export async function findLatestPreviewAiGenerationId(placeId: string): Promise<string | null> {
  const client = createSupabaseServiceRoleClient()
  const { data, error } = await client
    .from("ai_generations")
    .select("id")
    .eq("place_id", placeId)
    .eq("status", "preview")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error !== null) {
    throw new SupabaseAiRepositoryError("read latest preview", error.message)
  }
  return data === null ? null : data.id
}

function placeRowToSyncedPlace(row: PlaceRow): SyncedPlace {
  return { ...row, slug: row.slug ?? row.id } as unknown as SyncedPlace
}

export class SupabaseAiRepositoryError extends Error {
  readonly name = "SupabaseAiRepositoryError"

  constructor(step: string, readonly detail: string) {
    super(`Failed to ${step}: ${detail}`)
  }
}
