// 단일 장소 AI 생성 코어 — 관리자 단건 액션과 Batch 오케스트레이션이 공유한다.
// generatePlaceAiPreviewAction의 본문을 동작 무변경으로 추출한 것 (PR-1 batch 준비).
// redirect/notice 매핑은 호출부(actions.ts) 책임이고, 이 모듈은 결과를 값으로 반환한다.
import { contentModeForCategory } from "./content-mode"
import { FakeDeterministicAiProvider } from "./fake-provider"
import { AiGuardrailViolationError } from "./guardrails"
import { endAiGeneration, tryBeginAiGeneration } from "./in-flight"
import { withAiGenerationMetadata } from "./metadata"
import { AiProviderRequestError, OpenAiSeoContentProvider } from "./openai-provider"
import { resolveAiProviderSelection } from "./provider-selection"
import { generateAiPreview, type BatchGenerationAvoidance } from "./service"
import { estimateUsageCostUsd } from "./usage-cost"
import type { QualityReport } from "./content-quality"
import type { FaqPairKeys } from "./faq-variation"
import type { AiGeneratedSeoContent, AiGenerationInput, AiGenerationMetadata, AiGenerationRetryAudit, AiGenerationUsage, AiProvider } from "./types"

export const RECENT_PREVIEW_GUARD_SECONDS = 60

// AdminPlacesAiCode와 동일한 문자열 집합 (admin URL 계층에 의존하지 않기 위해 로컬로 정의)
export type GenerationRunErrorCode =
  | "api_key_missing"
  | "provider_config"
  | "timeout"
  | "rate_limit"
  | "invalid_response"
  | "json_parse"
  | "network"
  | "provider_error"

export type GenerationRunRetryContext = {
  readonly of: string
  readonly reason: string
  readonly bannedFaqPairs: readonly FaqPairKeys[]
}

export type GenerationRunBatchAvoidance = BatchGenerationAvoidance

export type GenerationRunResult =
  | {
      readonly kind: "generated"
      readonly generationId: string
      readonly quality: QualityReport | null
      readonly provider: string
      readonly model: string
      readonly usage: AiGenerationUsage | null
      readonly estimatedCostUsd: number | null
    }
  | { readonly kind: "misconfigured"; readonly errorCode: "api_key_missing" | "provider_config" }
  | { readonly kind: "recent-preview" }
  | { readonly kind: "busy" }
  | { readonly kind: "failed"; readonly errorCode: GenerationRunErrorCode }

export async function runPlaceAiGeneration(
  input: Readonly<{ placeId: string; retry?: GenerationRunRetryContext; batchAvoidance?: GenerationRunBatchAvoidance }>,
): Promise<GenerationRunResult> {
  const { createSupabaseAiRepository, hasRecentPreviewAiGeneration, recordFailedAiGeneration, listRecentPublishedContentSnapshots } = await import("./supabase-repository")

  // 복구 재시도가 provider 호출 이후 실패해도 실패 레코드에 원본 참조를 남겨 "1회 소진"이 DB에 내구적으로 남게 한다.
  // 소진 기준은 lib/ai/retry-policy.ts의 isRetryAttemptConsumed와 같다 — 호출 전 차단(misconfigured/busy)은 소진이 아니다.
  const retryAudit: AiGenerationRetryAudit | null = input.retry === undefined ? null : { of: input.retry.of, reason: input.retry.reason }

  const selection = resolveAiProviderSelection({
    AI_PROVIDER: process.env["AI_PROVIDER"],
    OPENAI_API_KEY: process.env["OPENAI_API_KEY"],
    OPENAI_MODEL: process.env["OPENAI_MODEL"],
  })
  // 환경 오설정은 provider 호출 전 차단이라 부작용이 없다 — 복구 재시도 1회를 소진시키지 않는다(retry 감사 기록 미부착).
  if (selection.kind === "misconfigured") {
    await recordFailedAiGenerationSafely(recordFailedAiGeneration, input.placeId, "openai", null, selection.errorCode, null)
    return { kind: "misconfigured", errorCode: selection.errorCode }
  }

  // 최근 preview 가드는 "일반 생성 재클릭" 중복 방지용이다. 제어된 복구 재시도는 원본 생성 직후 실행되는 것이 정상이므로
  // (Batch는 수 초 내 재시도) 이 가드에 걸리면 재시도가 구조적으로 불가능해진다 — 재시도 경로는 우회한다.
  // 중복 방지는 재시도 1회 정책(decideQualityFailRetry)과 in-flight 잠금이 대신한다.
  if (input.retry === undefined && (await hasRecentPreviewAiGeneration(input.placeId, RECENT_PREVIEW_GUARD_SECONDS))) {
    return { kind: "recent-preview" }
  }
  if (!tryBeginAiGeneration(input.placeId)) {
    return { kind: "busy" }
  }

  const providerName = selection.kind === "openai" ? "openai" : "fake"
  const modelName = selection.kind === "openai" ? selection.model : "FakeDeterministicAiProvider"
  const openAiProvider = selection.kind === "openai" ? new OpenAiSeoContentProvider({ apiKey: selection.apiKey, model: selection.model }) : null
  const provider: AiProvider = openAiProvider ?? new FakeDeterministicAiProvider()
  const buildMetadata = (): AiGenerationMetadata => {
    const usage = openAiProvider?.lastUsage ?? null
    return {
      provider: providerName,
      model: modelName,
      usage,
      estimated_cost: providerName === "openai" ? estimateUsageCostUsd(modelName, usage) : null,
    }
  }

  // 제목 패턴·키워드·FAQ 중복 회피용 최근 공개 스냅샷 — 조회 실패 시 해시 기본 선택으로 진행한다.
  const recentContent = await listRecentPublishedContentSnapshots().catch(() => [])

  try {
    const record = await generateAiPreview({
      placeId: input.placeId,
      provider,
      recentContent,
      repository: withAiGenerationMetadata(createSupabaseAiRepository(), buildMetadata),
      ...(input.batchAvoidance === undefined ? {} : { batchAvoidance: input.batchAvoidance }),
      ...(input.retry === undefined ? {} : { retry: input.retry }),
    })
    // 생성 직후 품질 성적표를 계산해 저장한다 (실패해도 생성 흐름은 유지).
    const quality = await evaluateGenerationQuality(record.id)
    const metadata = buildMetadata()
    return {
      kind: "generated",
      generationId: record.id,
      quality,
      provider: providerName,
      model: modelName,
      usage: metadata.usage,
      estimatedCostUsd: metadata.estimated_cost,
    }
  } catch (error) {
    const errorCode = classifyAiGenerationError(error)
    await recordFailedAiGenerationSafely(recordFailedAiGeneration, input.placeId, providerName, modelName, errorCode, retryAudit)
    return { kind: "failed", errorCode }
  } finally {
    endAiGeneration(input.placeId)
  }
}

// 생성 콘텐츠를 최근 공개 페이지와 비교 평가하고 성적표를 레코드에 저장한다. 반환값은 게이트 판정용.
export async function evaluateGenerationQuality(generationId: string): Promise<QualityReport | null> {
  try {
    const [{ createSupabaseAiRepository, listRecentPublishedContentSnapshots, listVerifiedInternalPaths, attachGenerationQuality }, { evaluateGeneratedContent }] = await Promise.all([
      import("./supabase-repository"),
      import("./content-quality"),
    ])
    const repository = createSupabaseAiRepository()
    const generation = await repository.findAiGenerationById(generationId)
    if (generation === undefined) {
      return null
    }
    // 저장 계약상 output/input은 실패 레코드에서 null일 수 있다 — 타입을 nullable로 넓혀 검사한다.
    const output = generation.output as AiGeneratedSeoContent | null
    if (output === null) {
      return null
    }
    const place = (generation.input as AiGenerationInput | null)?.place ?? null
    const fallbackPlace = place === null ? await repository.findPlaceById(generation.place_id) : null
    const placeName = place?.name ?? fallbackPlace?.name ?? ""
    const regionTokens = place !== null ? [place.city, place.district] : [fallbackPlace?.city ?? null, fallbackPlace?.district ?? null]
    const [recentPages, verifiedInternalPaths] = await Promise.all([listRecentPublishedContentSnapshots(), listVerifiedInternalPaths()])
    // 모드는 저장된 생성 입력에서 그대로 복원한다. content_mode가 없는 구 레코드는 업종으로 되짚고,
    // 그래도 정해지지 않으면 null로 넘겨 제목 패턴 비교만 건너뛴다 (임의 가정 금지).
    const storedInput = generation.input as AiGenerationInput | null
    const mode = storedInput?.content_mode ?? contentModeForCategory(place?.category ?? fallbackPlace?.category ?? null)
    const quality = evaluateGeneratedContent({
      content: output,
      placeName,
      regionTokens,
      mode,
      verifiedInternalPaths,
      // 자기 자신(같은 장소)의 기존 공개본은 반복도 비교에서 제외한다.
      recentPages: recentPages.filter((page) => page.placeName !== placeName),
      faqSelection: (generation.input as AiGenerationInput | null)?.content_plan?.faq_selection ?? null,
    })
    await attachGenerationQuality(generationId, quality)
    return quality
  } catch (error) {
    console.error("[content-quality] evaluation failed", { generationId, error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

export function classifyAiGenerationError(error: unknown): GenerationRunErrorCode {
  if (error instanceof AiProviderRequestError) {
    return error.code
  }
  if (error instanceof AiGuardrailViolationError) {
    return "invalid_response"
  }
  return "provider_error"
}

async function recordFailedAiGenerationSafely(
  record: (input: Readonly<{ placeId: string; provider: string; model: string | null; errorCode: string; retry?: AiGenerationRetryAudit | null }>) => Promise<void>,
  placeId: string,
  provider: string,
  model: string | null,
  errorCode: string,
  retry: AiGenerationRetryAudit | null,
): Promise<void> {
  try {
    await record({ placeId, provider, model, errorCode, retry })
  } catch {
    // 실패 이력 기록이 실패해도 호출 흐름은 유지한다.
  }
}
