import { describe, expect, it } from "vitest"

import { decideBatchCandidate } from "@/lib/batch/candidate-policy"
import { contentModeForCategory, requireContentMode, UnsupportedContentCategoryError, type ContentMode } from "@/lib/ai/content-mode"
import { faqTopicsFor, pickContentVariation } from "@/lib/ai/content-variation"
import { FakeDeterministicAiProvider } from "@/lib/ai/fake-provider"
import { pickFaqTopicPair } from "@/lib/ai/faq-variation"
import { buildKeywordPlan } from "@/lib/ai/keyword-variation"
import { systemPromptForMode } from "@/lib/ai/openai-provider"
import { buildTitleKeywordRevision } from "@/lib/ai/title-keyword-revision"
import { titlePatternsFor } from "@/lib/ai/title-variation"
import type { AiGenerationInput } from "@/lib/ai/types"

// 비장례 콘텐츠에 절대 나오면 안 되는 어휘. 실제 FAIL 판정은 PR B 범위이고, 여기서는 생성 구조가
// 이 어휘를 만들어내지 않는지만 확인한다.
const FUNERAL_WORDS = ["근조", "빈소", "장례", "조문", "상주", "유가족"]
const NON_CONDOLENCE_MODES: readonly ContentMode[] = ["celebration", "corporate-celebration"]

function containsFuneralWord(text: string): boolean {
  return FUNERAL_WORDS.some((word) => text.includes(word))
}

describe("업종 → 콘텐츠 모드 매핑", () => {
  it("maps funeral to condolence and leaves hospital unmapped", () => {
    expect(contentModeForCategory("funeral")).toBe("condolence")
    // 병원 본체는 목적이 하나로 정해지지 않아 의도적으로 매핑하지 않는다 (병원 장례식장은 funeral로 들어온다).
    expect(contentModeForCategory("hospital")).toBeNull()
  })

  it("maps the real sheet categories of the 2026-08-01 mis-generated places", () => {
    expect(contentModeForCategory("숙박/행사")).toBe("celebration")
    expect(contentModeForCategory("호텔")).toBe("celebration")
    expect(contentModeForCategory("제조")).toBe("corporate-celebration")
    expect(contentModeForCategory("건설/부동산")).toBe("corporate-celebration")
  })

  it("never falls back silently: unknown, empty, and missing categories have no mode", () => {
    for (const category of ["자동차", "전문서비스", "", "   ", null, undefined]) {
      expect(contentModeForCategory(category)).toBeNull()
      expect(() => requireContentMode(category)).toThrow(UnsupportedContentCategoryError)
    }
  })
})

describe("모드별 프롬프트", () => {
  it("keeps condolence wording for funeral places", () => {
    const prompt = systemPromptForMode("condolence")
    expect(prompt).toContain("근조화환")
    expect(prompt).toContain("장례식장")
  })

  it("has no funeral wording in celebration or corporate prompts", () => {
    for (const mode of NON_CONDOLENCE_MODES) {
      const prompt = systemPromptForMode(mode)
      // 금지 지시문 자체에는 어휘가 등장하므로, 그 줄을 뺀 나머지에 남아 있지 않은지 본다.
      const withoutBanLine = prompt
        .split("\n")
        .filter((line) => !line.includes("쓰지 마세요"))
        .join("\n")
      expect(containsFuneralWord(withoutBanLine)).toBe(false)
      expect(prompt).toContain("축하화환")
      expect(prompt).toContain("장례 관련 표현은 어떤 형태로도 쓰지 마세요")
    }
  })

  it("describes each mode's own purpose", () => {
    expect(systemPromptForMode("celebration")).toContain("행사")
    const corporate = systemPromptForMode("corporate-celebration")
    for (const word of ["개업", "이전", "준공", "창립", "취임"]) {
      expect(corporate).toContain(word)
    }
  })
})

describe("모드별 제목 패턴", () => {
  it("keeps the eight condolence patterns unchanged", () => {
    const condolence = titlePatternsFor("condolence")
    expect(condolence).toHaveLength(8)
    expect(condolence.map((pattern) => pattern.id)).toEqual([
      "order-guide",
      "pre-send-check",
      "region-checklist",
      "order-info",
      "directional",
      "intake-check",
      "region-dash",
      "binso-guide",
    ])
    expect(condolence[0]?.build("영남대학교병원 장례식장", "대구 남구")).toBe("영남대학교병원 장례식장 근조화환 주문 안내")
  })

  it("builds celebration and corporate titles without funeral wording", () => {
    for (const mode of NON_CONDOLENCE_MODES) {
      const patterns = titlePatternsFor(mode)
      expect(patterns.length).toBeGreaterThanOrEqual(4)
      for (const pattern of patterns) {
        const title = pattern.build("아이스퀘어호텔", "김해시")
        expect(containsFuneralWord(title), `${pattern.id}: ${title}`).toBe(false)
        expect(title.length).toBeLessThanOrEqual(40)
      }
    }
    expect(titlePatternsFor("celebration").map((pattern) => pattern.build("아이스퀘어호텔", "김해시"))).toContain("아이스퀘어호텔 행사·오픈 축하화환 배송")
    expect(titlePatternsFor("corporate-celebration").map((pattern) => pattern.build("KCC 울산공장", "울산"))).toContain("KCC 울산공장 개업·이전 축하화환 주문 안내")
  })

  it("never mixes pattern ids across modes", () => {
    const ids = (["condolence", ...NON_CONDOLENCE_MODES] as const).flatMap((mode) => titlePatternsFor(mode).map((pattern) => pattern.id))
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("모드별 키워드", () => {
  const base = { seed: "seed-1", placeName: "아이스퀘어호텔", city: "경남", district: "김해시", recentSets: [] }

  it("keeps the condolence keyword shape", () => {
    const plan = buildKeywordPlan({ ...base, placeName: "조은금강병원 장례식장", mode: "condolence", faqTopicKeys: ["pre-order-check", "unknown-room"] })
    expect(plan.keywords).toContain("김해 근조화환")
    expect(plan.roles).toEqual(["official-name", "region-wreath", "place-flower", "faq-intent", "delivery"])
  })

  it("produces celebration and corporate keywords with no funeral wording", () => {
    const celebration = buildKeywordPlan({ ...base, mode: "celebration", faqTopicKeys: ["event-date", "venue-access"] })
    expect(celebration.keywords).toContain("김해 축하화환")
    expect(celebration.keywords.some((keyword) => containsFuneralWord(keyword))).toBe(false)

    const corporate = buildKeywordPlan({ ...base, placeName: "KCC 울산공장", city: "울산", district: "동구", mode: "corporate-celebration", faqTopicKeys: ["gate-delivery", "ceremony-time"] })
    expect(corporate.keywords).toContain("울산 개업화환")
    expect(corporate.keywords.some((keyword) => containsFuneralWord(keyword))).toBe(false)
    // 슬롯 구성은 모드가 달라도 같다.
    expect(corporate.roles).toEqual(["official-name", "region-wreath", "place-flower", "faq-intent", "delivery"])
  })
})

describe("모드별 FAQ 폴백", () => {
  it("gives every mode the same number of topics", () => {
    const sizes = (["condolence", ...NON_CONDOLENCE_MODES] as const).map((mode) => faqTopicsFor(mode).length)
    expect(new Set(sizes).size).toBe(1)
    expect(sizes[0]).toBe(6)
  })

  it("keeps funeral wording out of non-condolence FAQ instructions", () => {
    for (const mode of NON_CONDOLENCE_MODES) {
      for (const topic of faqTopicsFor(mode)) {
        expect(containsFuneralWord(topic.instruction), `${mode}/${topic.key}`).toBe(false)
      }
    }
    // 반대로 condolence는 빈소 문항을 그대로 유지한다.
    expect(faqTopicsFor("condolence").map((topic) => topic.key)).toContain("unknown-room")
  })

  it("picks pairs from the requested mode only", () => {
    for (const mode of ["condolence", ...NON_CONDOLENCE_MODES] as const) {
      const pick = pickFaqTopicPair({ seed: "seed-1", mode, placeName: "아이스퀘어호텔", recentPages: [] })
      const keys = faqTopicsFor(mode).map((topic) => topic.key)
      expect(keys).toContain(pick.keys[0])
      expect(keys).toContain(pick.keys[1])
    }
  })

  it("keeps intro/structure instructions mode-scoped", () => {
    for (const mode of NON_CONDOLENCE_MODES) {
      const variation = pickContentVariation("seed-1", mode)
      expect(containsFuneralWord(variation.intro.instruction)).toBe(false)
      expect(containsFuneralWord(variation.structure.instruction)).toBe(false)
    }
  })
})

describe("전체 계획이 한 모드로 일관되게 나온다", () => {
  it("builds a celebration plan end to end without funeral wording", () => {
    const revision = buildTitleKeywordRevision({
      placeId: "910e5a42",
      placeName: "아이스퀘어호텔",
      city: "경남",
      district: "김해시",
      mode: "celebration",
      recentPages: [],
    })
    expect(containsFuneralWord(revision.title)).toBe(false)
    expect(revision.keywords.some((keyword) => containsFuneralWord(keyword))).toBe(false)
  })

  it("keeps the fake provider's copy aligned with the mode", async () => {
    const input = (mode: ContentMode): AiGenerationInput => ({
      content_mode: mode,
      place: { id: "p1", name: "아이스퀘어호텔", category: "호텔", city: "경남", district: "김해시", address: null, homepage: null },
      guardrails: [],
    })
    const provider = new FakeDeterministicAiProvider()
    const celebration = await provider.generateSeoContent(input("celebration"))
    expect(JSON.stringify(celebration)).not.toContain("근조")
    const condolence = await provider.generateSeoContent(input("condolence"))
    expect(JSON.stringify(condolence)).toContain("근조화환")
  })
})

describe("후보 자격 — 중앙 resolver 기준 (PR C 이후)", () => {
  it("mode가 매핑된 업종은 eligible이고, 매핑 없는 업종만 category-unsupported다", () => {
    const place = {
      id: "p1",
      status: "draft" as const,
      slug: "x",
      official_verification_status: "verified" as const,
      exclusion_reason: null,
      category: "funeral",
    }
    const base = { place, generationCount: 0, seoPagePathExists: false, slugDuplicateCount: 0 }
    expect(decideBatchCandidate(base)).toEqual({ eligible: true, mode: "condolence" })

    // PR C의 핵심 계약: 후보 자격이 별도 allowlist가 아니라 contentModeForCategory 하나를 따른다.
    for (const category of ["호텔", "숙박/행사", "제조", "건설/부동산"]) {
      const mode = contentModeForCategory(category)
      expect(mode).not.toBeNull()
      expect(decideBatchCandidate({ ...base, place: { ...place, category } })).toEqual({ eligible: true, mode })
    }
    // 매핑조차 없는 업종은 여전히 막힌다.
    expect(contentModeForCategory("hospital")).toBeNull()
    expect(decideBatchCandidate({ ...base, place: { ...place, category: "hospital" } })).toEqual({ eligible: false, reason: "category-unsupported", mode: null })
  })
})
