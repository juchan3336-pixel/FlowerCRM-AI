import "server-only"

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { SyncedPlace } from "@/lib/sync/types"
import type { Json, PlaceRow } from "@/types/database"
import type { QualityReport, RecentContentSnapshot } from "./content-quality"
import { aiGenerationRowToRecord, mergeGenerationOutputWrapper, parseGenerationRetry, parseGenerationStoredQuality, parseGenerationVariationAudit, wrapFailedGenerationOutput, wrapGenerationInput, wrapGenerationOutput, type StoredQualityReport } from "./generation-mapping"
import { countConsumedQualityFailRetries, type BatchRetryConsumptionRow } from "./retry-policy"
import type { AiGenerationRecord, AiGenerationRetryAudit, AiRepository, ApplyAiGenerationInput, GenerationVariationAudit, NewAiGeneration } from "./types"

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
          output: wrapGenerationOutput(input.output, null, input.metadata ?? null, input.titleNormalization ?? null, input.retry ?? null, input.audit ?? null),
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
export async function recordFailedAiGeneration(
  input: Readonly<{ placeId: string; provider: string; model: string | null; errorCode: string; retry?: AiGenerationRetryAudit | null }>,
): Promise<void> {
  const client = createSupabaseServiceRoleClient()
  const { error } = await client.from("ai_generations").insert({
    place_id: input.placeId,
    generation_type: AI_GENERATION_TYPE,
    model: input.model ?? "unknown",
    status: "failed",
    input: null,
    output: wrapFailedGenerationOutput({ provider: input.provider, model: input.model }, input.errorCode, input.retry ?? null),
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

// 품질 FAIL 복구 재시도 판정용 컨텍스트 — 원본 generation의 품질 성적표·FAQ 계획·재시도 여부를 raw output에서 읽는다.
export type AiGenerationRetryLookup = {
  readonly id: string
  readonly placeId: string
  readonly quality: StoredQualityReport | null
  readonly contentPlanFaqKeys: readonly string[] | null
  readonly faqQuestions: readonly string[]
  readonly isRetryGeneration: boolean
}

export async function getAiGenerationRetryLookup(generationId: string): Promise<AiGenerationRetryLookup | null> {
  const client = createSupabaseServiceRoleClient()
  const { data, error } = await client.from("ai_generations").select("id, place_id, input, output").eq("id", generationId).maybeSingle()
  if (error !== null) {
    throw new SupabaseAiRepositoryError("read generation for retry", error.message)
  }
  if (data === null) {
    return null
  }
  const inputWrapper = asJsonRecord(data.input)
  const generationInput = asJsonRecord(inputWrapper?.["generation_input"] ?? null)
  const contentPlan = asJsonRecord(generationInput?.["content_plan"] ?? null)
  const rawFaqKeys = contentPlan?.["faq_topic_keys"]
  const contentPlanFaqKeys = Array.isArray(rawFaqKeys) ? rawFaqKeys.filter((key): key is string => typeof key === "string") : null
  const outputWrapper = asJsonRecord(data.output)
  const generated = asJsonRecord(outputWrapper?.["generated"] ?? null)
  const rawFaq = generated?.["faq"]
  const faqEntries: readonly Json[] = Array.isArray(rawFaq) ? (rawFaq as readonly Json[]) : []
  const faqQuestions = faqEntries
    .map((entry) => asJsonRecord(entry)?.["question"])
    .filter((question): question is string => typeof question === "string" && question.length > 0)
  return {
    id: data.id,
    placeId: data.place_id,
    quality: parseGenerationStoredQuality(data.output),
    contentPlanFaqKeys,
    faqQuestions,
    isRetryGeneration: parseGenerationRetry(data.output) !== null,
  }
}

// 원본 generation을 참조하는 재시도 수 — status 무관(preview/applied/failed)으로 세어,
// 재시도가 생성 도중 실패해 failed로 기록된 경우도 소진으로 잡는다.
export async function countRetryGenerationsOf(generationId: string): Promise<number> {
  const client = createSupabaseServiceRoleClient()
  const { count, error } = await client
    .from("ai_generations")
    .select("id", { count: "exact", head: true })
    .eq("output->retry->>of", generationId)
  if (error !== null) {
    throw new SupabaseAiRepositoryError("count retry generations", error.message)
  }
  return count ?? 0
}

// 이 원본을 처리한 Batch item의 재시도 소진 흔적 — 재시도 generation이 남지 않은 실행까지 판정에 넣는다.
export async function listBatchRetryConsumptionOf(generationId: string): Promise<readonly BatchRetryConsumptionRow[]> {
  const client = createSupabaseServiceRoleClient()
  const { data, error } = await client
    .from("batch_run_items")
    .select("generation_id, retry_generation_id, last_error_code, last_error_message")
    .eq("generation_id", generationId)
  if (error !== null) {
    throw new SupabaseAiRepositoryError("list batch retry consumption", error.message)
  }
  return data.map(toBatchRetryConsumptionRow)
}

export function toBatchRetryConsumptionRow(
  row: Readonly<{ generation_id: string | null; retry_generation_id: string | null; last_error_code: string | null; last_error_message: string | null }>,
): BatchRetryConsumptionRow {
  return {
    generationId: row.generation_id,
    retryGenerationId: row.retry_generation_id,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
  }
}

// 복구 재시도 1회 정책의 내구적 판정값 — UI와 서버 액션이 같은 수치를 쓴다.
export async function countConsumedQualityFailRetriesOf(generationId: string): Promise<number> {
  const [retryGenerationCount, batchItems] = await Promise.all([countRetryGenerationsOf(generationId), listBatchRetryConsumptionOf(generationId)])
  return countConsumedQualityFailRetries({ generationId, retryGenerationCount, batchItems })
}

function asJsonRecord(value: Json | null | undefined): Record<string, Json | undefined> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json | undefined>) : null
}

// 품질 검사용: 최근 공개(published) 페이지들의 콘텐츠 스냅샷 (반복도 비교 기준)
export async function listRecentPublishedContentSnapshots(limit = 8): Promise<readonly RecentContentSnapshot[]> {
  const client = createSupabaseServiceRoleClient()
  const { data, error } = await client
    .from("published_place_pages")
    .select("name, region, title, place_description, faq, keywords")
    .eq("page_type", "place")
    .order("last_modified_at", { ascending: false })
    .limit(limit)
  if (error !== null) {
    throw new SupabaseAiRepositoryError("read recent published contents", error.message)
  }
  return data.map((row) => ({
    placeName: row.name ?? "",
    region: row.region,
    title: row.title,
    description: typeof row.place_description === "string" ? row.place_description : null,
    faqQuestions: Array.isArray(row.faq) ? row.faq.map((entry) => (typeof entry === "object" && entry !== null && "question" in entry ? String((entry as { question: unknown }).question) : "")).filter((question) => question.length > 0) : [],
    keywords: Array.isArray(row.keywords) ? row.keywords.filter((keyword): keyword is string => typeof keyword === "string") : [],
  }))
}

// 품질 검사용: 실존 검증된 내부 링크 경로 집합 (published seo_pages 경로만 인정)
export async function listVerifiedInternalPaths(): Promise<ReadonlySet<string>> {
  const client = createSupabaseServiceRoleClient()
  const { data, error } = await client.from("seo_pages").select("path").eq("status", "published")
  if (error !== null) {
    throw new SupabaseAiRepositoryError("read verified paths", error.message)
  }
  return new Set(data.map((row) => row.path))
}

// 생성 직후 품질 성적표를 output 래퍼에 병합 저장한다 (관리자 미리보기 표시용).
export async function attachGenerationQuality(generationId: string, quality: QualityReport): Promise<void> {
  const client = createSupabaseServiceRoleClient()
  const { data, error } = await client.from("ai_generations").select("output").eq("id", generationId).maybeSingle()
  if (error !== null || data === null) {
    throw new SupabaseAiRepositoryError("read generation for quality", error?.message ?? "not found")
  }
  const wrapper = typeof data.output === "object" && data.output !== null && !Array.isArray(data.output) ? { ...(data.output as Record<string, unknown>) } : {}
  wrapper["quality"] = quality
  const { error: updateError } = await client.from("ai_generations").update({ output: wrapper as Json }).eq("id", generationId)
  if (updateError !== null) {
    throw new SupabaseAiRepositoryError("attach generation quality", updateError.message)
  }
}

// Batch 상세 표시용 — generation output.audit 다양화 감사 조회 (읽기 전용, audit 없는 구 레코드는 제외).
export async function listGenerationVariationAudits(generationIds: readonly string[]): Promise<ReadonlyMap<string, GenerationVariationAudit>> {
  const unique = [...new Set(generationIds.filter((id) => id.length > 0))]
  if (unique.length === 0) {
    return new Map()
  }
  const client = createSupabaseServiceRoleClient()
  const { data, error } = await client.from("ai_generations").select("id, output").in("id", unique)
  if (error !== null) {
    throw new SupabaseAiRepositoryError("list generation audits", error.message)
  }
  const map = new Map<string, GenerationVariationAudit>()
  for (const row of data) {
    const audit = parseGenerationVariationAudit(row.output)
    if (audit !== null) {
      map.set(row.id, audit)
    }
  }
  return map
}

// 배치 내 다양성 회피 소스 조회 (PR-S3, 읽기 전용) — audit(없으면 null)과 생성 키워드를 함께 돌려준다.
export type GenerationAvoidanceSourceRow = {
  readonly audit: GenerationVariationAudit | null
  readonly keywords: readonly string[]
}

export async function listGenerationAvoidanceSources(generationIds: readonly string[]): Promise<ReadonlyMap<string, GenerationAvoidanceSourceRow>> {
  const unique = [...new Set(generationIds.filter((id) => id.length > 0))]
  if (unique.length === 0) {
    return new Map()
  }
  const client = createSupabaseServiceRoleClient()
  const { data, error } = await client.from("ai_generations").select("id, output").in("id", unique)
  if (error !== null) {
    throw new SupabaseAiRepositoryError("list generation avoidance sources", error.message)
  }
  const map = new Map<string, GenerationAvoidanceSourceRow>()
  for (const row of data) {
    const wrapper = typeof row.output === "object" && row.output !== null && !Array.isArray(row.output) ? (row.output as Record<string, unknown>) : null
    const generated = wrapper !== null && typeof wrapper["generated"] === "object" && wrapper["generated"] !== null ? (wrapper["generated"] as Record<string, unknown>) : null
    const rawKeywords = generated?.["keywords"]
    const keywords = Array.isArray(rawKeywords) ? rawKeywords.filter((keyword): keyword is string => typeof keyword === "string") : []
    map.set(row.id, { audit: parseGenerationVariationAudit(row.output), keywords })
  }
  return map
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
