import type { Json } from "@/types/database"
import type { TitleNormalization } from "./title-normalization"
import type {
  AiGeneratedSeoContent,
  AiGenerationInput,
  AiGenerationMetadata,
  AiGenerationRecord,
  AiGenerationRetryAudit,
  AiGenerationUsage,
  ApplyAiGenerationInput,
  GenerationVariationAudit,
} from "./types"

export type AiGenerationTableRow = {
  readonly id: string
  readonly place_id: string
  readonly status: AiGenerationRecord["status"]
  readonly input: Json | null
  readonly output: Json | null
  readonly model: string | null
  readonly created_at: string
  readonly applied_at: string | null
}

// 승인된 output jsonb 고정 구조:
// { generated, after, provider, model, usage: {input_tokens, output_tokens, total_tokens} | null, estimated_cost, error_code,
//   title_normalization?: {...}, audit?: {...다양화 감사}, retry?: { of, reason } }
// 모든 키는 optional 파싱 — 구 레코드({generated, after}만 존재)와 호환되어야 한다.

export function wrapGenerationInput(input: AiGenerationInput, before: ApplyAiGenerationInput["before"] | null): Json {
  return { generation_input: input, before }
}

export function wrapGenerationOutput(
  output: AiGeneratedSeoContent,
  after: AiGeneratedSeoContent | null,
  metadata?: AiGenerationMetadata | null,
  titleNormalization?: TitleNormalization | null,
  retry?: AiGenerationRetryAudit | null,
  audit?: GenerationVariationAudit | null,
): Json {
  return {
    generated: output,
    after,
    provider: metadata?.provider ?? null,
    model: metadata?.model ?? null,
    usage: metadata?.usage ?? null,
    estimated_cost: metadata?.estimated_cost ?? null,
    error_code: null,
    ...(titleNormalization == null ? {} : { title_normalization: titleNormalization }),
    ...(audit == null ? {} : { audit }),
    ...(retry == null ? {} : { retry }),
  }
}

// output 래퍼의 다양화 감사 기록을 안전 파싱한다 (audit 없는 구 레코드는 null — 역보정하지 않는다).
export function parseGenerationVariationAudit(output: Json | null): GenerationVariationAudit | null {
  const record = asRecord(output)
  const stored = asRecord(record?.["audit"] ?? null)
  if (stored === null) {
    return null
  }
  const titlePatternId = stored["title_pattern_id"]
  const titleSuffixKey = stored["title_suffix_key"]
  const titleFallback = stored["title_fallback"]
  const keywordsRebuilt = stored["keywords_rebuilt"]
  const faqSelection = stored["faq_selection"]
  const fallback = stored["fallback"]
  if (typeof titlePatternId !== "string" || typeof titleSuffixKey !== "string" || typeof titleFallback !== "boolean" || typeof keywordsRebuilt !== "boolean" || typeof fallback !== "boolean") {
    return null
  }
  if (faqSelection !== "hash" && faqSelection !== "fallback" && faqSelection !== "exhausted-min-overlap") {
    return null
  }
  const keywordRoles = Array.isArray(stored["keyword_roles"]) ? stored["keyword_roles"].filter((role): role is string => typeof role === "string") : []
  const faqTopicKeys = Array.isArray(stored["faq_topic_keys"]) ? stored["faq_topic_keys"].filter((key): key is string => typeof key === "string") : []
  return {
    title_pattern_id: titlePatternId,
    title_suffix_key: titleSuffixKey,
    title_fallback: titleFallback,
    keyword_roles: keywordRoles,
    keywords_rebuilt: keywordsRebuilt,
    faq_topic_keys: faqTopicKeys,
    faq_selection: faqSelection,
    fallback,
  }
}

// output 래퍼의 품질 FAIL 복구 재시도 감사 기록을 안전 파싱한다 (일반 생성·구 레코드는 null).
export function parseGenerationRetry(output: Json | null): AiGenerationRetryAudit | null {
  const record = asRecord(output)
  const stored = asRecord(record?.["retry"] ?? null)
  if (stored === null) {
    return null
  }
  const of = stored["of"]
  const reason = stored["reason"]
  return typeof of === "string" && of.length > 0 && typeof reason === "string" && reason.length > 0 ? { of, reason } : null
}

// output 래퍼의 제목 정규화 감사 기록을 안전 파싱한다 (구 레코드는 null).
export function parseGenerationTitleNormalization(output: Json | null): TitleNormalization | null {
  const record = asRecord(output)
  const stored = asRecord(record?.["title_normalization"] ?? null)
  if (stored === null) {
    return null
  }
  const modelTitle = stored["model_title"]
  const finalTitle = stored["final_title"]
  const normalized = stored["normalized"]
  const reason = stored["reason"]
  if (typeof modelTitle !== "string" || typeof finalTitle !== "string" || typeof normalized !== "boolean") {
    return null
  }
  if (reason !== "plan-match" && reason !== "suffix-appended" && reason !== "plan-restored" && reason !== "no-plan") {
    return null
  }
  return { model_title: modelTitle, final_title: finalTitle, normalized, reason }
}

// 실패 레코드에도 retry 감사 기록을 남긴다 — 복구 재시도가 생성에 실패해도 "1회 소진"이 DB에 내구적으로 남아야 한다.
// error_detail은 안전 문자열만 허용한다 — 분류된 오류의 짧은 사유(HTTP 상태·request id·계획 사유)이며
// 원본 응답·프롬프트·시크릿은 절대 담지 않는다 (호출부 계약).
export function wrapFailedGenerationOutput(
  metadata: Readonly<{ provider: string; model: string | null }>,
  errorCode: string,
  retry?: AiGenerationRetryAudit | null,
  errorDetail?: string | null,
): Json {
  return {
    generated: null,
    after: null,
    provider: metadata.provider,
    model: metadata.model,
    usage: null,
    estimated_cost: null,
    error_code: errorCode,
    ...(errorDetail == null || errorDetail.length === 0 ? {} : { error_detail: errorDetail.slice(0, 300) }),
    ...(retry == null ? {} : { retry }),
  }
}

// apply 시 generated/after만 갱신하고 provider/usage 등 기존 메타데이터 키는 보존한다.
export function mergeGenerationOutputWrapper(existing: Json | null, output: AiGeneratedSeoContent, after: AiGeneratedSeoContent | null): Json {
  const base = asRecord(existing) ?? {}
  return { ...base, generated: output, after }
}

export type AiGenerationStoredMetadata = {
  readonly provider: string | null
  readonly model: string | null
  readonly usage: AiGenerationUsage | null
  readonly estimatedCost: number | null
  readonly errorCode: string | null
  // 실패 레코드의 안전 상세 (HTTP 상태·request id·계획 사유 등) — 구 레코드는 null.
  readonly errorDetail: string | null
}

export function parseGenerationStoredMetadata(output: Json | null): AiGenerationStoredMetadata {
  const record = asRecord(output)
  const usageRecord = asRecord(record?.["usage"] ?? null)

  return {
    provider: textOrNull(record?.["provider"]),
    model: textOrNull(record?.["model"]),
    usage:
      usageRecord === null
        ? null
        : {
            input_tokens: numberOrNull(usageRecord["input_tokens"]),
            output_tokens: numberOrNull(usageRecord["output_tokens"]),
            total_tokens: numberOrNull(usageRecord["total_tokens"]),
          },
    estimatedCost: numberOrNull(record?.["estimated_cost"]),
    errorCode: textOrNull(record?.["error_code"]),
    errorDetail: textOrNull(record?.["error_detail"]),
  }
}

export type StoredQualityIssue = {
  readonly level: "fail" | "warn"
  readonly code: string
  readonly message: string
}

export type StoredQualityReport = {
  readonly status: "pass" | "warn" | "fail"
  readonly issues: readonly StoredQualityIssue[]
}

// output 래퍼의 quality 성적표를 안전 파싱한다 (없거나 구 레코드면 null).
export function parseGenerationStoredQuality(output: Json | null): StoredQualityReport | null {
  const record = asRecord(output)
  const quality = asRecord(record?.["quality"] ?? null)
  if (quality === null) {
    return null
  }
  const status = quality["status"]
  if (status !== "pass" && status !== "warn" && status !== "fail") {
    return null
  }
  const rawIssues = quality["issues"]
  const issues: StoredQualityIssue[] = []
  if (Array.isArray(rawIssues)) {
    for (const entry of rawIssues) {
      const issue = asRecord(entry as Json)
      const level = issue?.["level"]
      const code = issue?.["code"]
      const message = issue?.["message"]
      if ((level === "fail" || level === "warn") && typeof code === "string" && typeof message === "string") {
        issues.push({ level, code, message })
      }
    }
  }
  return { status, issues }
}

export function aiGenerationRowToRecord(row: AiGenerationTableRow): AiGenerationRecord {
  const inputWrapper = asRecord(row.input)
  const outputWrapper = asRecord(row.output)

  return {
    id: row.id,
    place_id: row.place_id,
    status: row.status,
    input: (inputWrapper?.["generation_input"] ?? row.input) as unknown as AiGenerationInput,
    output: (outputWrapper?.["generated"] ?? row.output) as unknown as AiGeneratedSeoContent,
    before: (inputWrapper?.["before"] ?? null) as AiGenerationRecord["before"],
    after: (outputWrapper?.["after"] ?? null) as AiGenerationRecord["after"],
    created_at: row.created_at,
    applied_at: row.applied_at,
  }
}

function asRecord(value: Json | null): Record<string, Json | undefined> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json | undefined>) : null
}

function textOrNull(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

function numberOrNull(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}
