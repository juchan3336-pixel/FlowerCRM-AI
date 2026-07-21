import { describe, expect, it } from "vitest"

import { evaluateGeneratedContent } from "@/lib/ai/content-quality"
import { parseGenerationRetry, wrapGenerationOutput } from "@/lib/ai/generation-mapping"
import { decideQualityFailRetry, faqPairOfFailedGeneration, QUALITY_FAIL_RETRY_MAX } from "@/lib/ai/retry-policy"
import { generateAiPreview } from "@/lib/ai/service"
import type { AiGeneratedSeoContent, AiGenerationInput, AiProvider, AiRepository, NewAiGeneration } from "@/lib/ai/types"

// 13호점 실측 FAIL — repeat:faq 1건.
const MASAN_FAIL_QUALITY = {
  status: "fail",
  issues: [{ level: "fail", code: "repeat:faq", message: "FAQ 질문 2개가 모두 기존 페이지(새통영병원 장례식장)와 동일" }],
} as const

describe("품질 FAIL 재시도 판정", () => {
  it("allows exactly one retry for a fail-quality generation with the derived reason", () => {
    const decision = decideQualityFailRetry({ quality: MASAN_FAIL_QUALITY, existingRetryCount: 0, isRetryGeneration: false })
    expect(decision).toEqual({ allowed: true, reason: "quality-fail-repeat-faq" })
    expect(QUALITY_FAIL_RETRY_MAX).toBe(1)
  })

  it("blocks retry when quality is missing, not fail, already retried, or itself a retry", () => {
    expect(decideQualityFailRetry({ quality: null, existingRetryCount: 0, isRetryGeneration: false })).toEqual({ allowed: false, blockedBy: "no-quality" })
    expect(decideQualityFailRetry({ quality: { status: "pass", issues: [] }, existingRetryCount: 0, isRetryGeneration: false })).toEqual({ allowed: false, blockedBy: "not-fail" })
    expect(decideQualityFailRetry({ quality: { status: "warn", issues: [] }, existingRetryCount: 0, isRetryGeneration: false })).toEqual({ allowed: false, blockedBy: "not-fail" })
    expect(decideQualityFailRetry({ quality: MASAN_FAIL_QUALITY, existingRetryCount: 1, isRetryGeneration: false })).toEqual({ allowed: false, blockedBy: "retry-exhausted" })
    expect(decideQualityFailRetry({ quality: MASAN_FAIL_QUALITY, existingRetryCount: 0, isRetryGeneration: true })).toEqual({ allowed: false, blockedBy: "is-retry" })
  })

  it("restores the failed generation's faq pair from plan keys or, for old records, from questions", () => {
    // content_plan.faq_topic_keys가 있으면 그대로.
    expect(faqPairOfFailedGeneration({ contentPlanFaqKeys: ["address-lookup", "delivery-availability"], faqQuestions: [] })).toEqual(["address-lookup", "delivery-availability"])
    // 13호점 원본(구 형식 — plan에 faq 키 없음)은 생성 질문에서 복원.
    expect(
      faqPairOfFailedGeneration({
        contentPlanFaqKeys: null,
        faqQuestions: ["빈소명을 모를 때는 어떻게 확인하나요?", "받는 분 정보를 어떻게 입력해야 하나요?"],
      }),
    ).toEqual(["unknown-room", "recipient-input"])
    // 둘 다 복원 불가하면 null.
    expect(faqPairOfFailedGeneration({ contentPlanFaqKeys: ["invalid-key"], faqQuestions: ["판별 불가"] })).toBeNull()
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
      verifiedInternalPaths: new Set(),
      recentPages: RECENT,
    })
    expect(report.status).toBe("fail")
    expect(report.issues.some((issue) => issue.code === "repeat:faq")).toBe(true)
  })
})
