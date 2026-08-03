import { describe, expect, it } from "vitest"

import { evaluateGeneratedContent } from "@/lib/ai/content-quality"
import { parseGenerationRetry, wrapFailedGenerationOutput, wrapGenerationOutput } from "@/lib/ai/generation-mapping"
import {
  BATCH_RETRY_ERROR_CODE_PREFIX,
  BATCH_RETRY_FAILURE_MESSAGE_PREFIX,
  countConsumedQualityFailRetries,
  decideQualityFailRetry,
  faqPairOfFailedGeneration,
  isBatchItemRetryConsumed,
  isRetryAttemptConsumed,
  QUALITY_FAIL_RETRY_MAX,
  type BatchRetryConsumptionRow,
} from "@/lib/ai/retry-policy"
import { generateAiPreview } from "@/lib/ai/service"
import type { AiGeneratedSeoContent, AiGenerationInput, AiProvider, AiRepository, NewAiGeneration } from "@/lib/ai/types"

// 13호점 실측 FAIL — repeat:faq 1건.
const MASAN_FAIL_QUALITY = {
  status: "fail",
  issues: [{ level: "fail", code: "repeat:faq", message: "FAQ 질문 2개가 모두 기존 페이지(새통영병원 장례식장)와 동일" }],
} as const

describe("품질 FAIL 재시도 판정", () => {
  it("allows exactly one retry for a fail-quality generation with the derived reason", () => {
    const decision = decideQualityFailRetry({ quality: MASAN_FAIL_QUALITY, consumedRetryCount: 0, isRetryGeneration: false })
    expect(decision).toEqual({ allowed: true, reason: "quality-fail-repeat-faq" })
    expect(QUALITY_FAIL_RETRY_MAX).toBe(1)
  })

  it("blocks retry when quality is missing, not fail, already retried, or itself a retry", () => {
    expect(decideQualityFailRetry({ quality: null, consumedRetryCount: 0, isRetryGeneration: false })).toEqual({ allowed: false, blockedBy: "no-quality" })
    expect(decideQualityFailRetry({ quality: { status: "pass", issues: [] }, consumedRetryCount: 0, isRetryGeneration: false })).toEqual({ allowed: false, blockedBy: "not-fail" })
    expect(decideQualityFailRetry({ quality: { status: "warn", issues: [] }, consumedRetryCount: 0, isRetryGeneration: false })).toEqual({ allowed: false, blockedBy: "not-fail" })
    expect(decideQualityFailRetry({ quality: MASAN_FAIL_QUALITY, consumedRetryCount: 1, isRetryGeneration: false })).toEqual({ allowed: false, blockedBy: "retry-exhausted" })
    expect(decideQualityFailRetry({ quality: MASAN_FAIL_QUALITY, consumedRetryCount: 0, isRetryGeneration: true })).toEqual({ allowed: false, blockedBy: "is-retry" })
  })

  it("blocks a second retry regardless of how much time passed (guard has no time component)", () => {
    // 시간 경과는 판정 입력이 아니다 — 소진 1회면 언제 호출해도 차단.
    for (const isRetryGeneration of [false, true]) {
      expect(decideQualityFailRetry({ quality: MASAN_FAIL_QUALITY, consumedRetryCount: 1, isRetryGeneration }).allowed).toBe(false)
    }
    // 재시도 결과가 PASS든 FAIL이든, 재시도 generation 자체는 추가 재시도 대상이 아니다.
    expect(decideQualityFailRetry({ quality: { status: "pass", issues: [] }, consumedRetryCount: 1, isRetryGeneration: true })).toEqual({ allowed: false, blockedBy: "not-fail" })
    expect(decideQualityFailRetry({ quality: MASAN_FAIL_QUALITY, consumedRetryCount: 1, isRetryGeneration: true })).toEqual({ allowed: false, blockedBy: "is-retry" })
  })

  it("restores the failed generation's faq pair from plan keys or, for old records, from questions", () => {
    // content_plan.faq_topic_keys가 있으면 그대로.
    expect(faqPairOfFailedGeneration({ contentPlanFaqKeys: ["address-lookup", "delivery-availability"], faqQuestions: [], mode: "condolence" })).toEqual(["address-lookup", "delivery-availability"])
    // 13호점 원본(구 형식 — plan에 faq 키 없음)은 생성 질문에서 복원.
    expect(
      faqPairOfFailedGeneration({
        contentPlanFaqKeys: null,
        faqQuestions: ["빈소명을 모를 때는 어떻게 확인하나요?", "받는 분 정보를 어떻게 입력해야 하나요?"],
        mode: "condolence",
      }),
    ).toEqual(["unknown-room", "recipient-input"])
    // 둘 다 복원 불가하면 null.
    expect(faqPairOfFailedGeneration({ contentPlanFaqKeys: ["invalid-key"], faqQuestions: ["판별 불가"], mode: "condolence" })).toBeNull()
  })
})

describe("재시도 소진 판정 — generation이 남지 않은 시도 포함", () => {
  // 2026-07-23 대구병원 실측 item — 복구 재시도가 recent-preview 가드에 막혀 retry generation이 남지 않았다.
  // 접두 규칙 도입 이전 행이라 last_error_code는 "recent-preview"(retry- 접두 없음)다.
  const DAEGU_LEGACY_ITEM: BatchRetryConsumptionRow = {
    generationId: "67b3fd0d-1724-4ed7-8308-b717b91ad8aa",
    retryGenerationId: null,
    lastErrorCode: "recent-preview",
    lastErrorMessage: "복구 재시도 실패: recent-preview",
  }

  it("treats a batch retry that produced no generation as consumed (대구병원 재허용 버그)", () => {
    expect(isBatchItemRetryConsumed(DAEGU_LEGACY_ITEM)).toBe(true)
    // 재시도 generation이 0건이어도 Batch 흔적만으로 소진 1회 — 시간이 지나도 재허용되지 않는다.
    const consumed = countConsumedQualityFailRetries({
      generationId: "67b3fd0d-1724-4ed7-8308-b717b91ad8aa",
      retryGenerationCount: 0,
      batchItems: [DAEGU_LEGACY_ITEM],
    })
    expect(consumed).toBe(1)
    expect(decideQualityFailRetry({ quality: MASAN_FAIL_QUALITY, consumedRetryCount: consumed, isRetryGeneration: false })).toEqual({
      allowed: false,
      blockedBy: "retry-exhausted",
    })
  })

  it("recognizes the structural retry- error prefix and the retry_generation_id link", () => {
    expect(isBatchItemRetryConsumed({ ...DAEGU_LEGACY_ITEM, lastErrorCode: `${BATCH_RETRY_ERROR_CODE_PREFIX}recent-preview`, lastErrorMessage: null })).toBe(true)
    expect(isBatchItemRetryConsumed({ ...DAEGU_LEGACY_ITEM, lastErrorCode: "retry-quality-fail", lastErrorMessage: null })).toBe(true)
    expect(isBatchItemRetryConsumed({ ...DAEGU_LEGACY_ITEM, retryGenerationId: "gen-retry", lastErrorCode: null, lastErrorMessage: null })).toBe(true)
    expect(BATCH_RETRY_FAILURE_MESSAGE_PREFIX).toBe("복구 재시도 실패: ")
  })

  it("does not consume a retry for ordinary generation failures or unrelated items", () => {
    // 일반 생성 실패(재시도 아님)는 소진이 아니다 — 복구 재시도 1회는 그대로 남는다.
    expect(isBatchItemRetryConsumed({ generationId: "gen-a", retryGenerationId: null, lastErrorCode: "provider_error", lastErrorMessage: "생성 실패: provider_error" })).toBe(false)
    expect(isBatchItemRetryConsumed({ generationId: "gen-a", retryGenerationId: null, lastErrorCode: "warn-other", lastErrorMessage: null })).toBe(false)
    // 다른 원본 generation의 item은 이 원본의 소진으로 세지 않는다.
    expect(countConsumedQualityFailRetries({ generationId: "gen-a", retryGenerationCount: 0, batchItems: [DAEGU_LEGACY_ITEM] })).toBe(0)
  })

  it("consumes the retry only when the provider call actually started", () => {
    // 부작용이 있는 결과만 소진 — generation이 남거나, 호출 후 실패한 경우.
    expect(isRetryAttemptConsumed("generated")).toBe(true)
    expect(isRetryAttemptConsumed("failed")).toBe(true)
    // 호출 전 차단은 아무것도 바꾸지 않았으므로 재시도 1회가 남는다.
    expect(isRetryAttemptConsumed("misconfigured")).toBe(false)
    expect(isRetryAttemptConsumed("busy")).toBe(false)
    expect(isRetryAttemptConsumed("recent-preview")).toBe(false)
  })

  it("does not treat a guard-blocked batch item as a consumption", () => {
    // 재시도가 차단되어 실행되지 않은 item은 소진 흔적이 아니다 (retry- 접두를 쓰지 않는 이유).
    expect(
      isBatchItemRetryConsumed({
        generationId: "gen-original",
        retryGenerationId: null,
        lastErrorCode: "quality-fail-retry-blocked",
        lastErrorMessage: "복구 재시도가 이미 소진되어 실행하지 않음 (retry-exhausted)",
      }),
    ).toBe(false)
    // 호출 전 차단으로 끝난 신규 실행 기록도 소진이 아니다 (메시지 접두가 다르다).
    expect(
      isBatchItemRetryConsumed({ generationId: "gen-original", retryGenerationId: null, lastErrorCode: "api_key_missing", lastErrorMessage: "복구 재시도 시작 불가: api_key_missing" }),
    ).toBe(false)
  })

  it("counts a batch retry that did produce a generation only once", () => {
    // 재시도 generation이 남으면 generation 계층과 Batch 흔적 양쪽에 잡히지만 소진은 1회다.
    const consumed = countConsumedQualityFailRetries({
      generationId: "gen-original",
      retryGenerationCount: 1,
      batchItems: [{ generationId: "gen-original", retryGenerationId: "gen-retry", lastErrorCode: "retry-quality-fail", lastErrorMessage: null }],
    })
    expect(consumed).toBe(1)
  })

  it("malformed retry chains fail closed rather than reopening the retry", () => {
    // retry.of가 자기 자신을 가리키거나 알 수 없는 값이어도, isRetryGeneration이 참이면 추가 재시도는 차단된다.
    expect(decideQualityFailRetry({ quality: MASAN_FAIL_QUALITY, consumedRetryCount: 0, isRetryGeneration: true })).toEqual({ allowed: false, blockedBy: "is-retry" })
    // Batch 흔적이 여러 건이어도(재실행 등) 소진으로만 커진다 — 절대 0으로 내려가지 않는다.
    expect(
      countConsumedQualityFailRetries({
        generationId: "gen-original",
        retryGenerationCount: 0,
        batchItems: [
          { generationId: "gen-original", retryGenerationId: null, lastErrorCode: null, lastErrorMessage: "복구 재시도 실패: timeout" },
          { generationId: "gen-original", retryGenerationId: null, lastErrorCode: "retry-busy", lastErrorMessage: null },
        ],
      }),
    ).toBeGreaterThanOrEqual(1)
  })
})

describe("재시도 감사 기록 저장·파싱", () => {
  const CONTENT: AiGeneratedSeoContent = {
    meta_title: "제목",
    meta_description: "메타",
    description: "본문입니다.",
    faq: [
      { question: "질문 하나?", answer: "답변 하나." },
      { question: "질문 둘?", answer: "답변 둘." },
    ],
    keywords: ["키워드"],
    internal_links: [],
  }

  it("round-trips the retry audit through the output wrapper and distinguishes normal generations", () => {
    const audit = { of: "7da1a339-0274-4678-ac02-c19d3e00c149", reason: "quality-fail-repeat-faq" }
    expect(parseGenerationRetry(wrapGenerationOutput(CONTENT, null, null, null, audit))).toEqual(audit)
    // 일반 생성(재클릭 포함)은 retry 키가 없어 null — 대시보드·이력에서 구분 가능.
    expect(parseGenerationRetry(wrapGenerationOutput(CONTENT, null, null, null))).toBeNull()
  })

  it("keeps the retry audit on failure records so a failed retry still counts as consumed", () => {
    const audit = { of: "7da1a339-0274-4678-ac02-c19d3e00c149", reason: "quality-fail-repeat-faq" }
    const failed = wrapFailedGenerationOutput({ provider: "openai", model: "gpt-4.1-mini" }, "timeout", audit)
    expect(parseGenerationRetry(failed)).toEqual(audit)
    // 일반 생성 실패는 retry 키가 없어 소진으로 세지 않는다.
    expect(parseGenerationRetry(wrapFailedGenerationOutput({ provider: "openai", model: "gpt-4.1-mini" }, "timeout"))).toBeNull()
  })
})

describe("재시도 생성 서비스 통합", () => {
  const MASAN_PLACE = {
    id: "c5c08102-61d8-4f2d-a89f-9b0cd74c5d70",
    name: "마산의료원 장례식장",
    category: "funeral",
    city: "경남",
    district: "창원시",
    address: "경남 창원시 마산합포구 3·15대로 231 (지번: 장군동4가 26-2)",
    homepage: "https://www.mmc.or.kr/funeral",
    phone: null,
    normalized_phone: null,
    email: null,
    slug: "funeral-gyeongnam-changwonsi-masanuiryowon-jangryesikjang",
    description: null,
    meta_title: null,
    meta_description: null,
    faq: [],
    keywords: [],
    internal_links: [],
  }

  function makeRepository(created: NewAiGeneration[]): AiRepository {
    return {
      findPlaceById: () => Promise.resolve(MASAN_PLACE as unknown as Awaited<ReturnType<AiRepository["findPlaceById"]>>),
      createAiGeneration: (input) => {
        created.push(input)
        return Promise.resolve({ id: "gen-retry", place_id: input.placeId, status: "preview", input: input.input, output: input.output, before: null, after: null, created_at: "", applied_at: null })
      },
      findAiGenerationById: () => Promise.resolve(undefined),
      applyAiGeneration: () => Promise.reject(new Error("not used")),
    }
  }

  const provider: AiProvider = {
    generateSeoContent: (input: AiGenerationInput) =>
      Promise.resolve({
        description: "마산의료원 장례식장 안내 본문입니다. 두 번째 문장입니다.",
        meta_title: input.content_plan?.title ?? "제목",
        meta_description: "마산의료원 장례식장 메타 설명입니다.",
        faq: [
          { question: "질문 하나는 무엇인가요?", answer: "답변 하나입니다." },
          { question: "질문 둘은 무엇인가요?", answer: "답변 둘입니다." },
        ],
        keywords: input.content_plan?.keywords ?? ["키워드"],
        internal_links: [],
      }),
  }

  it("never reuses the failed faq pair and records the retry audit on the new generation", async () => {
    // Given: 13호점 실패 pair(unknown-room+recipient-input)를 금지한 재시도.
    const created: NewAiGeneration[] = []
    await generateAiPreview({
      placeId: MASAN_PLACE.id,
      provider,
      repository: makeRepository(created),
      retry: { of: "7da1a339-0274-4678-ac02-c19d3e00c149", reason: "quality-fail-repeat-faq", bannedFaqPairs: [["unknown-room", "recipient-input"]] },
    })

    // Then: 새 generation 1건만 생성(원본 무수정), pair가 실패 조합과 다르고, 감사 기록이 저장된다.
    expect(created).toHaveLength(1)
    const stored = created[0]
    expect(stored?.retry).toEqual({ of: "7da1a339-0274-4678-ac02-c19d3e00c149", reason: "quality-fail-repeat-faq" })
    expect(new Set(stored?.input.content_plan?.faq_topic_keys ?? [])).not.toEqual(new Set(["unknown-room", "recipient-input"]))
    expect(stored?.input.content_plan?.faq_topic_keys).toHaveLength(2)
    // content_plan도 원본과 동일하지 않다 (faq_topic_keys·faq_selection이 달라짐).
    expect(stored?.input.content_plan?.faq_selection).toBe("fallback")
  })

  it("does not record a retry audit for normal generations", async () => {
    const created: NewAiGeneration[] = []
    await generateAiPreview({ placeId: MASAN_PLACE.id, provider, repository: makeRepository(created) })
    expect(created[0]?.retry).toBeUndefined()
    expect(created[0]?.input.content_plan?.faq_selection).toBe("hash")
  })
})

describe("재시도 결과도 기존 Quality 게이트로만 판정", () => {
  const RETRY_CONTENT: AiGeneratedSeoContent = {
    meta_title: "창원시 장례식장 화환 주문 — 마산의료원 장례식장",
    meta_description: "마산의료원 장례식장 근조화환 주문 안내.",
    description: "마산의료원 장례식장에 근조화환을 보내실 때 확인할 정보를 안내합니다. 주문 과정에서 세부 조건을 확인할 수 있습니다.",
    faq: [
      { question: "장례식장 주소는 어떻게 확인하나요?", answer: "공식 안내에서 확인하실 수 있습니다." },
      { question: "배송 가능 여부는 어떻게 확인하나요?", answer: "주문 과정에서 확인할 수 있습니다." },
    ],
    keywords: ["마산의료원 장례식장", "창원 근조화환"],
    internal_links: [],
  }

  const RECENT = [
    {
      placeName: "새통영병원 장례식장",
      region: "통영시",
      title: "새통영병원 장례식장 화환 접수 전 확인사항",
      description: "새통영병원 장례식장 안내.",
      faqQuestions: ["빈소명을 모를 때는 어떻게 확인하나요?", "받는 분 정보를 어떻게 입력해야 하나요?"],
      keywords: ["새통영병원 장례식장"],
    },
  ]

  it("passes prepare gating when the retry avoids the repeated faq pair", () => {
    const report = evaluateGeneratedContent({
      content: RETRY_CONTENT,
      placeName: "마산의료원 장례식장",
      regionTokens: ["경남", "창원시"],
      mode: "condolence" as const,
      verifiedInternalPaths: new Set(),
      recentPages: RECENT,
    })
    expect(report.issues.some((issue) => issue.code === "repeat:faq")).toBe(false)
    expect(report.status).not.toBe("fail")
  })

  it("still fails (and blocks prepare) when the retry repeats both faq questions", () => {
    const report = evaluateGeneratedContent({
      content: {
        ...RETRY_CONTENT,
        faq: [
          { question: "빈소명을 모를 때는 어떻게 확인하나요?", answer: "답변." },
          { question: "받는 분 정보를 어떻게 입력해야 하나요?", answer: "답변." },
        ],
      },
      placeName: "마산의료원 장례식장",
      regionTokens: ["경남", "창원시"],
      mode: "condolence" as const,
      verifiedInternalPaths: new Set(),
      recentPages: RECENT,
    })
    expect(report.status).toBe("fail")
    expect(report.issues.some((issue) => issue.code === "repeat:faq")).toBe(true)
  })
})
