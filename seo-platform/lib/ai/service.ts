import { addressResolutionRecordOf, checkPlaceGenerationAddress, resolveVerifiedAddress, type GenerationAddressCheck, type VerifiedAddressEntry } from "@/lib/domain/verified-address"

import { formatAddressForContent } from "./address-format"
import { assertAiOutputAllowed, parseAiProviderOutput } from "./guardrails"
import { requireContentMode, type ContentMode } from "./content-mode"
import type { RecentContentSnapshot } from "./content-quality"
import { pickFaqTopicPair, type FaqPairKeys } from "./faq-variation"
import { buildTitleKeywordRevision } from "./title-keyword-revision"
import { normalizeGeneratedTitle } from "./title-normalization"
import type { TitlePatternId } from "./title-variation"
import type { AiGenerationInput, AiGenerationRecord, AiGenerationRetryAudit, AiProvider, AiRepository, GenerationVariationAudit } from "./types"

const COMMON_GUARDRAILS = [
  "Do not invent facts absent from the source place.",
  "Do not generate phone, email, or price information.",
  "Express ordering and delivery availability only through the default CTA.",
] as const

// 모드별 어조 가드레일 — 공통 가드레일 뒤에 한 줄 덧붙인다.
const MODE_GUARDRAIL: Readonly<Record<ContentMode, string>> = {
  condolence: "Keep funeral and hospital language factual and restrained.",
  celebration: "This is a celebration venue. Never use funeral, mourning, or memorial-room wording.",
  "corporate-celebration": "This is a business site. Never use funeral, mourning, or memorial-room wording.",
}

function guardrailsFor(mode: ContentMode): readonly string[] {
  return [...COMMON_GUARDRAILS, MODE_GUARDRAIL[mode]]
}

// 같은 Batch 내 앞선 item에서 복원한 회피 컨텍스트 (PR-S3) — 최근 공개 5건 회피에 더해 선반영된다.
export type BatchGenerationAvoidance = {
  readonly titlePatterns: readonly { readonly patternId: TitlePatternId | null; readonly suffixKey: string | null }[]
  readonly faqPairs: readonly FaqPairKeys[]
  readonly keywordSets: readonly { readonly placeName: string; readonly region: string | null; readonly keywords: readonly string[] }[]
  // 앞선 item 본문 — 생성 선택에는 쓰지 않고 품질 평가(본문 반복 비교)로만 흘러간다.
  readonly bodies?: readonly { readonly placeName: string; readonly region: string | null; readonly description: string | null }[]
}

export type GenerateAiPreviewInput = {
  readonly placeId: string
  readonly provider: AiProvider
  readonly repository: AiRepository
  // 최근 공개 페이지 스냅샷 (최신순) — 제목 패턴·키워드·FAQ 조합 중복 회피용. 미제공 시 해시 기본 선택만 적용된다.
  readonly recentContent?: readonly RecentContentSnapshot[]
  // 같은 Batch의 앞선 item 다양성 회피 (PR-S3) — 미제공 시 기존 동작과 완전히 동일하다.
  readonly batchAvoidance?: BatchGenerationAvoidance
  // 품질 FAIL 복구 재시도 컨텍스트 — 원본 generation과 사유를 감사 기록하고, 실패한 FAQ pair 재사용을 금지한다.
  // forbiddenTerms가 있으면 직전 시도에서 업종 금지 어휘가 걸린 것이라 프롬프트에 명시해 재사용을 막는다.
  // 검수 주소 맵 — 미제공 시 운영 맵. 테스트가 대역 맵을 넣는 용도다.
  readonly verifiedAddresses?: readonly VerifiedAddressEntry[]
  readonly retry?: AiGenerationRetryAudit & { readonly bannedFaqPairs?: readonly FaqPairKeys[]; readonly forbiddenTerms?: readonly string[] }
}

export type ApplyAiGenerationServiceInput = {
  readonly generationId: string
  readonly repository: AiRepository
  readonly verifiedAddresses?: readonly VerifiedAddressEntry[]
}

export async function generateAiPreview(input: GenerateAiPreviewInput): Promise<AiGenerationRecord> {
  const place = await input.repository.findPlaceById(input.placeId)
  if (place === undefined) {
    throw new MissingAiPlaceError(input.placeId)
  }
  // 검수 주소 등록 장소인데 등록 값과 현재 장소 정보가 다르면 모델을 부르기 전에 멈춘다 — 원문 주소로 되돌아가지 않는다.
  const addressResolution = resolveVerifiedAddress({ placeId: place.id, slug: place.slug, name: place.name, rawAddress: place.address }, input.verifiedAddresses)
  if (addressResolution.kind === "conflict") {
    throw new VerifiedAddressBlockedError(place.id, "conflict", `검수 주소 등록 값과 현재 장소 정보가 다름: ${addressResolution.fields.join(", ")}`)
  }
  // 업종 → 모드. 매핑 없는 업종은 여기서 즉시 멈춘다 (근조화환 문구로 조용히 떨어지지 않게).
  const mode = requireContentMode(place.category)
  const faqPick = pickFaqTopicPair({
    seed: `${place.id}:${place.name}`,
    placeName: place.name,
    mode,
    recentPages: input.recentContent ?? [],
    // 같은 Batch의 앞선 pair는 재시도 금지 pair와 같은 강도로 회피한다 — 전 조합 충돌 시 최소 중복 + WARN(faq:pool-exhausted).
    bannedPairs: [...(input.retry?.bannedFaqPairs ?? []), ...(input.batchAvoidance?.faqPairs ?? [])],
  })
  const revision = buildTitleKeywordRevision({
    placeId: place.id,
    placeName: place.name,
    city: place.city,
    district: place.district,
    mode,
    recentPages: input.recentContent ?? [],
    pendingPatterns: input.batchAvoidance?.titlePatterns ?? [],
    pendingKeywordSets: input.batchAvoidance?.keywordSets ?? [],
    faqTopicKeys: faqPick.keys,
  })
  const retryForbiddenTerms = input.retry?.forbiddenTerms ?? []
  const generationInput: AiGenerationInput = {
    content_mode: mode,
    ...(retryForbiddenTerms.length === 0 ? {} : { retry_guidance: { forbidden_terms: retryForbiddenTerms } }),
    place: {
      id: place.id,
      name: place.name,
      category: place.category,
      city: place.city,
      district: place.district,
      // 원본 주소(places.address)는 그대로 두고, 문장에 인용될 표기만 정리해 넘긴다.
      // 검수 주소가 등록된 장소는 공식 확인된 주소만 넘긴다 — 미확인 층·호가 문장에 들어가지 않게.
      address: addressResolution.kind === "matched" ? addressResolution.address : formatAddressForContent(place.address),
      homepage: place.homepage,
    },
    ...(addressResolution.kind === "matched" ? { address_resolution: addressResolutionRecordOf(addressResolution) } : {}),
    guardrails: guardrailsFor(mode),
    content_plan: {
      title: revision.title,
      title_pattern_id: revision.titlePatternId,
      keywords: revision.keywords,
      keyword_roles: revision.keywordRoles,
      faq_topic_keys: faqPick.keys,
      faq_selection: faqPick.selection,
    },
  }
  const output = parseAiProviderOutput(await input.provider.generateSeoContent(generationInput))
  assertAiOutputAllowed(output, place)
  // 제목 후처리: 모델이 계획 제목을 바꿔도 최종 제목은 content_plan.title로 정규화한다 (모델 원본은 감사 기록으로 보존).
  const titleNormalization = normalizeGeneratedTitle(output.meta_title, generationInput.content_plan?.title ?? null)
  const finalOutput = titleNormalization.normalized ? { ...output, meta_title: titleNormalization.final_title } : output
  // 다양화 선택 감사 — 어떤 패턴·pair·역할이 어떤 경로로 결정됐는지 output.audit에 고정한다 (선택 로직 자체는 불변).
  const audit: GenerationVariationAudit = {
    title_pattern_id: revision.titlePatternId,
    title_suffix_key: revision.titleSuffixKey,
    title_fallback: revision.titleFallbackApplied,
    keyword_roles: revision.keywordRoles,
    keywords_rebuilt: revision.keywordsRebuilt,
    faq_topic_keys: faqPick.keys,
    faq_selection: faqPick.selection,
    fallback: revision.titleFallbackApplied || revision.keywordsRebuilt || faqPick.selection !== "hash",
  }
  return input.repository.createAiGeneration({
    placeId: place.id,
    input: generationInput,
    output: finalOutput,
    titleNormalization,
    audit,
    ...(input.retry === undefined ? {} : { retry: { of: input.retry.of, reason: input.retry.reason } }),
  })
}

export async function applyAiGeneration(input: ApplyAiGenerationServiceInput): Promise<AiGenerationRecord> {
  const generation = await input.repository.findAiGenerationById(input.generationId)
  if (generation === undefined) {
    throw new MissingAiGenerationError(input.generationId)
  }
  if (generation.status !== "preview") {
    throw new AiGenerationAlreadyAppliedError(input.generationId)
  }
  const place = await input.repository.findPlaceById(generation.place_id)
  if (place === undefined) {
    throw new MissingAiPlaceError(generation.place_id)
  }
  // 적용 직전 — 생성 당시의 주소 기록이 지금의 검수 주소 판정과 같은지 본다 (검수 해소·재개도 이 함수를 지난다).
  const addressCheck = checkGenerationAddress(place, generation.input, input.verifiedAddresses)
  if (!addressCheck.ok) {
    throw new VerifiedAddressBlockedError(place.id, addressCheck.reason, addressCheck.detail)
  }
  return input.repository.applyAiGeneration({
    generationId: generation.id,
    before: {
      description: place.description,
      meta_title: place.meta_title,
      meta_description: place.meta_description,
      faq: place.faq,
      keywords: place.keywords,
      internal_links: place.internal_links,
    },
    after: generation.output,
  })
}

// 장소의 현재 검수 주소 판정과 생성 입력의 주소 기록을 대조한다 — 적용·게시가 같은 함수를 쓴다.
export function checkGenerationAddress(place: { readonly id: string; readonly slug: string | null; readonly name: string; readonly address: string | null }, generationInput: unknown, entries?: readonly VerifiedAddressEntry[]): GenerationAddressCheck {
  return checkPlaceGenerationAddress(place, generationInput, entries)
}

// 검수 주소 등록 장소의 생성·적용을 멈춘 사유 — 원문 주소로 조용히 진행하지 않는다.
export class VerifiedAddressBlockedError extends Error {
  readonly name = "VerifiedAddressBlockedError"

  constructor(
    readonly placeId: string,
    readonly reason: "conflict" | "record-missing" | "record-stale",
    readonly detail: string,
  ) {
    super(`Verified address check failed for place ${placeId}: ${reason}`)
  }
}

export class MissingAiPlaceError extends Error {
  readonly name = "MissingAiPlaceError"

  constructor(readonly placeId: string) {
    super(`Missing AI place ${placeId}`)
  }
}

export class MissingAiGenerationError extends Error {
  readonly name = "MissingAiGenerationError"

  constructor(readonly generationId: string) {
    super(`Missing AI generation ${generationId}`)
  }
}

export class AiGenerationAlreadyAppliedError extends Error {
  readonly name = "AiGenerationAlreadyAppliedError"

  constructor(readonly generationId: string) {
    super(`AI generation is not preview: ${generationId}`)
  }
}
