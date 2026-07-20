import { describe, expect, it } from "vitest"

import { evaluateGeneratedContent, maskPlaceTokens, tokenJaccardSimilarity, type QualityEvaluationInput, type RecentContentSnapshot } from "@/lib/ai/content-quality"
import { pickContentVariation } from "@/lib/ai/content-variation"
import { ADMIN_PLACES_NOTICES } from "@/lib/admin/places-url"
import type { AiGeneratedSeoContent } from "@/lib/ai/types"

function makeContent(overrides: Partial<AiGeneratedSeoContent> = {}): AiGeneratedSeoContent {
  return {
    meta_title: "거제 대우병원 장례식장 근조화환 배송",
    meta_description: "거제 대우병원 장례식장으로 근조화환을 보낼 때 필요한 주문 정보를 안내합니다.",
    description:
      "거제 대우병원 장례식장으로 근조화환을 보내려면 주문 전에 장례식장명과 빈소명을 정확히 확인하는 것이 중요합니다. 주문 시에는 받는 분의 성함과 빈소 정보를 함께 입력해 주세요. 배송 가능 여부와 세부 조건은 페이지의 ‘화환 주문하기’ 버튼을 통해 주문 과정에서 확인할 수 있습니다.",
    faq: [
      { question: "대우병원 장례식장으로 화환을 보내기 전에 무엇을 확인해야 하나요?", answer: "장례식장명과 빈소명, 받는 분의 성함을 먼저 확인해 주세요." },
      { question: "대우병원 장례식장 주소는 어디에서 확인할 수 있나요?", answer: "자세한 위치는 대우병원 공식 홈페이지에서 확인할 수 있습니다." },
    ],
    keywords: ["대우병원 장례식장", "거제 근조화환", "대우병원 근조화환", "거제 장례식장 꽃배달", "근조화환 배송"],
    internal_links: [],
    ...overrides,
  }
}

function makeInput(content: AiGeneratedSeoContent, recentPages: readonly RecentContentSnapshot[] = []): QualityEvaluationInput {
  return {
    content,
    placeName: "대우병원 장례식장",
    regionTokens: ["거제", "거제시"],
    verifiedInternalPaths: new Set<string>(),
    recentPages,
  }
}

const RECENT_PAGE: RecentContentSnapshot = {
  placeName: "경상국립대학교병원 장례식장",
  region: "진주시",
  title: "경상국립대학교병원 장례식장 근조화환 배송",
  description: "경상국립대학교병원 장례식장은 경남 진주시 강남로 79에 위치한 장례식장입니다. 주문 및 배송 안내는 페이지의 ‘화환 주문하기’ 버튼을 통해 확인할 수 있습니다.",
  faqQuestions: ["근조화환은 어떻게 주문하나요?", "경상국립대학교병원 장례식장 위치는 어디인가요?"],
  keywords: ["경상국립대학교병원", "진주시 장례식장", "근조화환 배송", "경남 꽃배달", "장례식장 화환"],
}

describe("금지 표현 검사", () => {
  it("fails when the content contains 공식 주문 CTA", () => {
    // Given: '공식 주문 CTA' 표현이 포함된 생성 결과 (1~4호점 반복 결함).
    const report = evaluateGeneratedContent(makeInput(makeContent({ description: "주문 및 배송 안내는 공식 주문 CTA를 통해 확인하세요." })))

    // Then: FAIL — 게시 준비가 차단되어야 한다.
    expect(report.status).toBe("fail")
    expect(report.issues.some((issue) => issue.code === "banned:official-order")).toBe(true)
  })

  it("fails on delivery guarantee sentences", () => {
    // Given: 배송 확정 표현.
    const report = evaluateGeneratedContent(makeInput(makeContent({ faq: [{ question: "꽃배달이 가능한가요?", answer: "네, 배송이 가능합니다." }, { question: "주소는?", answer: "공식 홈페이지에서 확인하세요." }] })))

    // Then: FAIL.
    expect(report.status).toBe("fail")
    expect(report.issues.some((issue) => issue.code === "banned:delivery-guarantee")).toBe(true)
  })

  it("fails on facility or atmosphere claims", () => {
    // Given: 시설·분위기 추정 문장 (2·3·4호점 반복 결함).
    const report = evaluateGeneratedContent(makeInput(makeContent({ description: "조용하고 엄숙한 분위기에서 장례 절차를 진행할 수 있으며 편리한 시설을 제공합니다." })))

    // Then: FAIL.
    expect(report.status).toBe("fail")
    expect(report.issues.some((issue) => issue.code === "banned:facility-claim")).toBe(true)
  })

  it("passes clean approved-style content", () => {
    // Given: 4호점 승인 최종본 스타일의 깨끗한 콘텐츠 + internal_links=[].
    const report = evaluateGeneratedContent(makeInput(makeContent()))

    // Then: PASS.
    expect(report.status).toBe("pass")
    expect(report.issues).toHaveLength(0)
  })
})

describe("내부 링크 검사", () => {
  it("fails on internal links that are not verified real paths", () => {
    // Given: AI가 임의 생성한 /area 경로 (4회 연속 404 결함).
    const report = evaluateGeneratedContent(makeInput(makeContent({ internal_links: [{ href: "/area/gyeongnam-geoje-si", label: "거제 꽃배달" }] })))

    // Then: FAIL.
    expect(report.status).toBe("fail")
    expect(report.issues.some((issue) => issue.code === "link:unverified")).toBe(true)
  })

  it("passes verified paths and empty links", () => {
    // Given: 검증된 실경로만 허용.
    const verified = new Set(["/places/verified-slug"])
    const withVerified = evaluateGeneratedContent({ ...makeInput(makeContent({ internal_links: [{ href: "/places/verified-slug", label: "관련" }] })), verifiedInternalPaths: verified })
    expect(withVerified.issues.some((issue) => issue.code === "link:unverified")).toBe(false)
  })
})

describe("반복도 검사", () => {
  it("fails when the first sentence repeats the location template from a recent page", () => {
    // Given: "[장소명]은 [지역]에 위치한 장례식장입니다" 템플릿 (1~3호점 반복 결함).
    const content = makeContent({
      description: "대우병원 장례식장은 경남 거제시 두모길 16에 위치한 장례식장입니다. 주문 및 배송 안내는 페이지의 ‘화환 주문하기’ 버튼을 통해 확인할 수 있습니다.",
    })
    const report = evaluateGeneratedContent(makeInput(content, [RECENT_PAGE]))

    // Then: 첫 문장 유사도 FAIL + 동일 문장 감지.
    expect(report.status).toBe("fail")
    expect(report.issues.some((issue) => issue.code === "repeat:first-sentence")).toBe(true)
  })

  it("fails when both faq questions repeat a recent page", () => {
    // Given: 기존 페이지와 동일한 FAQ 2종 (장소명만 치환).
    const content = makeContent({
      faq: [
        { question: "근조화환은 어떻게 주문하나요?", answer: "페이지의 ‘화환 주문하기’ 버튼에서 확인해 주세요." },
        { question: "대우병원 장례식장 위치는 어디인가요?", answer: "공식 홈페이지에서 확인할 수 있습니다." },
      ],
    })
    const report = evaluateGeneratedContent(makeInput(content, [RECENT_PAGE]))

    // Then: FAQ 조합 반복 FAIL.
    expect(report.issues.some((issue) => issue.code === "repeat:faq")).toBe(true)
    expect(report.status).toBe("fail")
  })

  it("passes differentiated content against recent pages", () => {
    // Given: 4호점 승인본 (차별화 구조) vs 3호점 스냅샷.
    const report = evaluateGeneratedContent(makeInput(makeContent(), [RECENT_PAGE]))

    // Then: 반복도 FAIL 없음.
    expect(report.status).toBe("pass")
  })

  it("masks place and region tokens for template detection", () => {
    // Given / When / Then: 장소명·지역명 치환 템플릿이 마스킹 후 동일 문자열이 된다.
    const a = maskPlaceTokens("대우병원 장례식장은 거제시에 위치한 장례식장입니다.", "대우병원 장례식장", ["거제시"])
    const b = maskPlaceTokens("경상국립대학교병원 장례식장은 진주시에 위치한 장례식장입니다.", "경상국립대학교병원 장례식장", ["진주시"])
    expect(a).toBe(b)
    expect(tokenJaccardSimilarity(a, b)).toBe(1)
  })
})

describe("콘텐츠 다양화", () => {
  it("selects deterministic variations that differ across places", () => {
    // Given / When: 서로 다른 장소 seed 30개.
    const variations = Array.from({ length: 30 }, (_, index) => pickContentVariation(`place-${String(index)}:이름${String(index)}`))

    // Then: 같은 seed는 항상 같은 결과(결정적), 도입문·FAQ 조합이 고르게 분산된다.
    expect(pickContentVariation("place-1:이름1")).toEqual(pickContentVariation("place-1:이름1"))
    const introKeys = new Set(variations.map((variation) => variation.intro.key))
    const faqPairs = new Set(variations.map((variation) => variation.faqTopics.map((topic) => topic.key).join("+")))
    expect(introKeys.size).toBeGreaterThanOrEqual(4)
    expect(faqPairs.size).toBeGreaterThanOrEqual(6)
    for (const variation of variations) {
      expect(variation.faqTopics[0].key).not.toBe(variation.faqTopics[1].key)
    }
  })
})

describe("품질 게이트 계약", () => {
  it("registers the quality-blocked notice", () => {
    // Given / When / Then: 게시 준비 차단 notice가 URL 계약에 포함된다.
    expect(ADMIN_PLACES_NOTICES).toContain("quality-blocked")
  })
})
