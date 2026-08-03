import { describe, expect, it } from "vitest"

import { evaluateGeneratedContent } from "@/lib/ai/content-quality"
import { parseGenerationTitleNormalization, wrapGenerationOutput } from "@/lib/ai/generation-mapping"
import { generateAiPreview } from "@/lib/ai/service"
import { normalizeGeneratedTitle } from "@/lib/ai/title-normalization"
import type { AiGeneratedSeoContent, AiGenerationInput, AiProvider, AiRepository, NewAiGeneration } from "@/lib/ai/types"

// 11·12호점 실제 사례 문자열
const ELEVENTH_PLAN = "새통영병원 장례식장 화환 접수 전 확인사항"
const ELEVENTH_MODEL = "새통영병원 장례식장 화환 접수 전 확인사항 안내"
const TWELFTH_PLAN = "대구 중구 계명대학교 대구동산병원 장례식장 근조화환 주문 체크사항"
const TWELFTH_MODEL = "대구 중구 계명대학교 대구동산병원 장례식장 근조화환 주문 안내"

describe("제목 후처리 정규화 규칙", () => {
  it("keeps the title unchanged when the model matches the plan", () => {
    // Given / When: 계획값과 동일한 모델 제목.
    const result = normalizeGeneratedTitle(ELEVENTH_PLAN, ELEVENTH_PLAN)

    // Then: 변경 없음.
    expect(result).toEqual({ model_title: ELEVENTH_PLAN, final_title: ELEVENTH_PLAN, normalized: false, reason: "plan-match" })
  })

  it("normalizes the 11th-place case where the model appended 안내", () => {
    // Given / When: 11호점 실측 사례 — 계획 제목 뒤 '안내' 추가.
    const result = normalizeGeneratedTitle(ELEVENTH_MODEL, ELEVENTH_PLAN)

    // Then: 계획 제목으로 정규화, 사유는 접미사 추가.
    expect(result.final_title).toBe(ELEVENTH_PLAN)
    expect(result.normalized).toBe(true)
    expect(result.reason).toBe("suffix-appended")
    expect(result.model_title).toBe(ELEVENTH_MODEL)
  })

  it("normalizes the 12th-place case where 체크사항 was replaced with 안내", () => {
    // Given / When: 12호점 실측 사례 — 접미사 치환(구조 변경).
    const result = normalizeGeneratedTitle(TWELFTH_MODEL, TWELFTH_PLAN)

    // Then: 계획 제목으로 정규화, 사유는 구조 변경.
    expect(result.final_title).toBe(TWELFTH_PLAN)
    expect(result.normalized).toBe(true)
    expect(result.reason).toBe("plan-restored")
  })

  it("keeps the model title when there is no plan title", () => {
    // Given / When: content_plan.title 부재.
    expect(normalizeGeneratedTitle(ELEVENTH_MODEL, null)).toEqual({ model_title: ELEVENTH_MODEL, final_title: ELEVENTH_MODEL, normalized: false, reason: "no-plan" })
    expect(normalizeGeneratedTitle(ELEVENTH_MODEL, "  ")).toMatchObject({ normalized: false, reason: "no-plan" })
  })
})

describe("정규화 감사 기록 저장·파싱", () => {
  const CONTENT: AiGeneratedSeoContent = {
    meta_title: ELEVENTH_PLAN,
    meta_description: "메타",
    description: "본문입니다.",
    faq: [
      { question: "질문 하나?", answer: "답변 하나." },
      { question: "질문 둘?", answer: "답변 둘." },
    ],
    keywords: ["키워드"],
    internal_links: [],
  }

  it("round-trips title_normalization through the output wrapper", () => {
    // Given: 정규화 기록과 함께 래핑된 output.
    const normalization = normalizeGeneratedTitle(ELEVENTH_MODEL, ELEVENTH_PLAN)
    const wrapped = wrapGenerationOutput(CONTENT, null, null, normalization)

    // When / Then: 파서가 동일 값을 복원하고, 기록이 없으면 null.
    expect(parseGenerationTitleNormalization(wrapped)).toEqual(normalization)
    expect(parseGenerationTitleNormalization(wrapGenerationOutput(CONTENT, null, null))).toBeNull()
  })
})

describe("생성 서비스 통합", () => {
  function makeRepository(created: NewAiGeneration[]): AiRepository {
    return {
      findPlaceById: () =>
        Promise.resolve({
          id: "place-12",
          name: "계명대학교 대구동산병원 장례식장",
          category: "funeral",
          city: "대구",
          district: "중구",
          address: "대구 중구 달성로 56",
          homepage: null,
          phone: null,
          normalized_phone: null,
          email: null,
          slug: "slug-12",
          description: null,
          meta_title: null,
          meta_description: null,
          faq: [],
          keywords: [],
          internal_links: [],
        } as unknown as Awaited<ReturnType<AiRepository["findPlaceById"]>>),
      createAiGeneration: (input) => {
        created.push(input)
        return Promise.resolve({ id: "gen-12", place_id: input.placeId, status: "preview", input: input.input, output: input.output, before: null, after: null, created_at: "", applied_at: null })
      },
      findAiGenerationById: () => Promise.resolve(undefined),
      applyAiGeneration: () => Promise.reject(new Error("not used")),
    }
  }

  function makeProvider(buildTitle: (plan: string) => string): AiProvider {
    return {
      generateSeoContent: (input: AiGenerationInput) =>
        Promise.resolve({
          description: "계명대학교 대구동산병원 장례식장 안내 본문입니다. 두 번째 문장입니다.",
          meta_title: buildTitle(input.content_plan?.title ?? ""),
          meta_description: "계명대학교 대구동산병원 장례식장 메타 설명입니다.",
          faq: [
            { question: "질문 하나는 무엇인가요?", answer: "답변 하나입니다." },
            { question: "질문 둘은 무엇인가요?", answer: "답변 둘입니다." },
          ],
          keywords: input.content_plan?.keywords ?? ["키워드"],
          internal_links: [],
        }),
    }
  }

  it("stores the normalized title and audit record when the model deviates", async () => {
    // Given: 계획 제목 뒤에 '안내'를 덧붙이는 모델.
    const created: NewAiGeneration[] = []
    await generateAiPreview({ placeId: "place-12", provider: makeProvider((plan) => `${plan} 안내`), repository: makeRepository(created) })

    // Then: 저장 제목은 계획값이고 감사 기록에 모델 원본이 보존된다.
    const stored = created[0]
    expect(stored?.output.meta_title).toBe(stored?.input.content_plan?.title)
    expect(stored?.titleNormalization?.normalized).toBe(true)
    expect(stored?.titleNormalization?.model_title).toBe(`${stored?.input.content_plan?.title ?? ""} 안내`)
    // 메타·본문·FAQ·키워드는 정규화의 영향을 받지 않는다.
    expect(stored?.output.description).toContain("본문입니다")
    expect(stored?.output.faq).toHaveLength(2)
  })

  it("keeps the model title untouched when it already matches the plan", async () => {
    // Given: 계획을 그대로 따르는 모델.
    const created: NewAiGeneration[] = []
    await generateAiPreview({ placeId: "place-12", provider: makeProvider((plan) => plan), repository: makeRepository(created) })

    // Then: normalized=false, 제목 동일.
    expect(created[0]?.titleNormalization?.normalized).toBe(false)
    expect(created[0]?.titleNormalization?.reason).toBe("plan-match")
    expect(created[0]?.output.meta_title).toBe(created[0]?.input.content_plan?.title)
  })
})

describe("계획 제목 결함은 기존 Quality 게이트가 차단", () => {
  const BASE: AiGeneratedSeoContent = {
    meta_title: "잘못된 제목",
    meta_description: "메타 설명입니다.",
    description: "테스트병원 장례식장 안내 본문입니다.",
    faq: [
      { question: "질문 하나는 무엇인가요?", answer: "답변 하나입니다." },
      { question: "질문 둘은 무엇인가요?", answer: "답변 둘입니다." },
    ],
    keywords: ["테스트"],
    internal_links: [],
  }

  it("fails when the planned title drops the official place name", () => {
    // Given: 장소명이 빠진 제목 (+ 본문에서도 장소명 제거).
    const report = evaluateGeneratedContent({
      content: { ...BASE, meta_title: "근조화환 주문 체크사항", description: "이곳으로 보내는 안내 본문입니다." },
      placeName: "테스트병원 장례식장",
      regionTokens: ["경남", "테스트시"],
      mode: "condolence" as const,
      verifiedInternalPaths: new Set(),
      recentPages: [],
    })
    expect(report.status).toBe("fail")
    expect(report.issues.some((issue) => issue.code === "structure:place-name")).toBe(true)
  })

  it("fails when the planned title contains a banned expression", () => {
    // Given: 금지 표현이 든 제목.
    const report = evaluateGeneratedContent({
      content: { ...BASE, meta_title: "테스트병원 장례식장 공식 주문 CTA 안내" },
      placeName: "테스트병원 장례식장",
      regionTokens: ["경남", "테스트시"],
      mode: "condolence" as const,
      verifiedInternalPaths: new Set(),
      recentPages: [],
    })
    expect(report.status).toBe("fail")
    expect(report.issues.some((issue) => issue.code.startsWith("banned:"))).toBe(true)
  })
})
