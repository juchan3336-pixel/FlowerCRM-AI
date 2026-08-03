import { describe, expect, it } from "vitest"

import { checkTitleKeywordPatterns, evaluateGeneratedContent, maskPlaceTokens, type QualityEvaluationInput, type RecentContentSnapshot } from "@/lib/ai/content-quality"
import { buildKeywordPlan, hasCommonTrioStreak, keywordRegionLabel, STOCK_KEYWORD_TRIO } from "@/lib/ai/keyword-variation"
import { buildTitleKeywordRevision } from "@/lib/ai/title-keyword-revision"
import { detectTitlePatternId, pickTitlePattern, titlePatternsFor, titleRegionLabel } from "@/lib/ai/title-variation"
import type { AiGeneratedSeoContent } from "@/lib/ai/types"

const EIGHTH = { mode: "condolence" as const, placeId: "e690ff19-b2aa-4574-929f-c8371a1b311a", placeName: "영남대학교병원 장례식장", city: "대구", district: "남구" }
const NINTH = { mode: "condolence" as const, placeId: "692d0927-0ba9-412c-bed8-334be14fd4b7", placeName: "대구파티마병원 장례식장", city: "대구", district: "동구" }
const TENTH = { mode: "condolence" as const, placeId: "710a371e-e767-4d65-8706-a2b19e66f6dd", placeName: "조은금강병원 장례식장", city: "경남", district: "김해시" }

function snapshot(placeName: string, region: string, title: string, keywords: readonly string[]): RecentContentSnapshot {
  return { placeName, region, title, description: null, faqQuestions: [], keywords }
}

// 5~7호점 운영 제목 그대로 (원문 수렴 패턴 A 포함)
const RECENT_PAGES: readonly RecentContentSnapshot[] = [
  snapshot("남해병원 장례식장", "남해군", "남해병원 장례식장 근조화환 보내기 전 확인 정보", ["남해병원 장례식장", "남해 근조화환", "남해병원 화환", "남해 장례식장 꽃배달", "근조화환 보내기"]),
  snapshot("대구보훈병원 장례식장", "달서구", "대구보훈병원 장례식장 화환 주문 전 확인사항", ["대구보훈병원 장례식장", "근조화환 주문", "대구 달서구 화환", "장례식장 화환", "화환 주문 안내"]),
  snapshot("거창적십자병원 장례식장", "거창군", "거창적십자병원 장례식장 근조화환 주문 안내", ["거창적십자병원", "근조화환", "장례식장 화환", "빈소명 확인", "받는 분 성함"]),
]

describe("제목 다양화", () => {
  it("defines eight distinct title patterns", () => {
    // Given / When / Then: 8개 유형, id·생성문 모두 상이.
    expect(titlePatternsFor("condolence")).toHaveLength(8)
    const titles = titlePatternsFor("condolence").map((pattern) => pattern.build("영남대학교병원 장례식장", "대구 남구"))
    expect(new Set(titles).size).toBe(8)
    expect(new Set(titlePatternsFor("condolence").map((pattern) => pattern.id)).size).toBe(8)
  })

  it("avoids patterns used by the recent five pages", () => {
    // Given: 최근 5건이 A 패턴(order-guide)을 포함.
    const recent = { patternIds: ["order-guide" as const, null, null, null, null], suffixKeys: ["안내", null, null, null, null] }

    // When: 해시 기본 선택이 order-guide인 seed라도.
    for (let index = 0; index < 40; index += 1) {
      const pick = pickTitlePattern(`seed-${String(index)}`, "테스트병원 장례식장", "김해시", recent, "condolence")
      // Then: 최근 5건과 같은 패턴은 선택되지 않는다.
      expect(pick.patternId).not.toBe("order-guide")
    }
  })

  it("prevents the same suffix three times in a row", () => {
    // Given: 직전 2건 접미사가 모두 '안내'.
    const recent = { patternIds: [null, null], suffixKeys: ["안내", "안내"] }

    // When / Then: 어떤 seed라도 접미사 '안내' 패턴(A/E)은 3회 연속으로 선택되지 않는다.
    for (let index = 0; index < 40; index += 1) {
      const pick = pickTitlePattern(`seed-${String(index)}`, "테스트병원 장례식장", "김해시", recent, "condolence")
      expect(pick.suffixKey).not.toBe("안내")
    }
  })

  it("detects template titles after masking place and region", () => {
    // Given / When / Then: 장소명·지역만 바꾼 동일 패턴이 정확히 감지된다.
    expect(detectTitlePatternId("영남대학교병원 장례식장 근조화환 주문 안내", "영남대학교병원 장례식장", ["대구 남구"], "condolence")).toBe("order-guide")
    expect(detectTitlePatternId("김해시 조은금강병원 장례식장 근조화환 주문 체크사항", "조은금강병원 장례식장", ["김해시"], "condolence")).toBe("region-checklist")
    expect(detectTitlePatternId("완전히 다른 형식의 제목", "조은금강병원 장례식장", ["김해시"], "condolence")).toBeNull()
  })

  it("keeps titles within the length budget and builds region labels correctly", () => {
    // Given / When / Then: 지역 라벨 규칙과 길이 상한.
    expect(titleRegionLabel("대구", "남구")).toBe("대구 남구")
    expect(titleRegionLabel("경남", "김해시")).toBe("김해시")
    const longPlace = "성균관대학교 삼성창원병원 장례식장"
    const pick = pickTitlePattern("seed", longPlace, "창원시 마산회원구", { patternIds: [], suffixKeys: [] }, "condolence")
    expect(pick.title.length).toBeLessThanOrEqual(40)
  })
})

describe("키워드 다양화", () => {
  it("builds five role-based keywords without the stock trio or banned terms", () => {
    // Given / When: 10호점 조건.
    const plan = buildKeywordPlan({ mode: "condolence", seed: "s", placeName: TENTH.placeName, city: TENTH.city, district: TENTH.district, faqTopicKeys: ["unknown-room", "branch-lookup"], recentSets: [] })

    // Then: 5개 슬롯, 공식명·지역·핵심명 포함, 고정 3종 동시 포함 없음, 금지어 없음.
    expect(plan.keywords).toHaveLength(5)
    expect(plan.keywords[0]).toBe("조은금강병원 장례식장")
    expect(plan.keywords).toContain("김해 근조화환")
    expect(plan.keywords).toContain("조은금강병원 화환")
    const stockHits = plan.keywords.filter((keyword) => (STOCK_KEYWORD_TRIO as readonly string[]).includes(keyword))
    expect(stockHits.length).toBeLessThan(3)
    for (const keyword of plan.keywords) {
      expect(keyword).not.toMatch(/조문 서비스|장례 시설|공식/)
    }
  })

  it("rebuilds automatically when overlapping a recent set at 4/5", () => {
    // Given: 기본 구성과 마스킹 기준 4/5 겹치는 최근 세트.
    const base = buildKeywordPlan({ mode: "condolence", seed: "s", placeName: EIGHTH.placeName, city: EIGHTH.city, district: EIGHTH.district, faqTopicKeys: ["pre-order-check", "unknown-room"], recentSets: [] })
    const maskMine = (keyword: string) => maskPlaceTokens(keyword, EIGHTH.placeName, [EIGHTH.city, EIGHTH.district])
    // 다른 장소 이름·지역으로는 마스킹되지 않는 문자열이라, 마스킹 후 4개가 정확히 일치하는 최근 세트가 된다.
    const recentSet = { placeName: "다른병원 장례식장", region: "다른시", keywords: [...base.keywords.slice(0, 4).map(maskMine), "전혀 다른 키워드"] }
    const overlappingRecent = [recentSet]

    // When: 같은 seed로 재구성 조건을 걸면.
    const rebuiltPlan = buildKeywordPlan({ mode: "condolence", seed: "s", placeName: EIGHTH.placeName, city: EIGHTH.city, district: EIGHTH.district, faqTopicKeys: ["pre-order-check", "unknown-room"], recentSets: overlappingRecent })

    // Then: 자동 재구성이 발동해 마스킹 기준 4/5 미만이 된다.
    expect(rebuiltPlan.rebuilt).toBe(true)
    const theirMasked = new Set(recentSet.keywords.map((keyword) => maskPlaceTokens(keyword, recentSet.placeName, [recentSet.region])))
    const overlap = rebuiltPlan.keywords.map(maskMine).filter((keyword) => theirMasked.has(keyword)).length
    expect(overlap).toBeLessThan(4)
  })

  it("derives region labels for provinces and metro cities", () => {
    expect(keywordRegionLabel("경남", "김해시")).toBe("김해")
    expect(keywordRegionLabel("경남", "남해군")).toBe("남해")
    expect(keywordRegionLabel("대구", "남구")).toBe("대구")
  })

  it("flags three common keywords repeated three times in a row", () => {
    // Given: 마스킹 후 동일한 3개 공통 키워드를 가진 최근 3세트.
    const sets = ["A병원 장례식장", "B병원 장례식장", "C병원 장례식장"].map((name, index) =>
      ({ placeName: name, region: `지역${String(index)}시`, keywords: [name, "근조화환 주문", "장례식장 화환", "화환 주문 안내", `지역${String(index)} 꽃배달`] }))
    expect(hasCommonTrioStreak(sets)).toBe(true)
    expect(hasCommonTrioStreak(sets.slice(0, 2))).toBe(false)
  })
})

describe("8·9·10호점 보정 후보", () => {
  it("produces mutually distinct title patterns for the three pending places", () => {
    // Given: 최근 공개 페이지 + 순차 확정되는 pendingTitles.
    const eighth = buildTitleKeywordRevision({ ...EIGHTH, recentPages: RECENT_PAGES })
    const ninth = buildTitleKeywordRevision({ ...NINTH, recentPages: RECENT_PAGES, pendingTitles: [{ title: eighth.title, placeName: EIGHTH.placeName, region: "남구" }] })
    const tenth = buildTitleKeywordRevision({
      ...TENTH,
      recentPages: RECENT_PAGES,
      pendingTitles: [
        { title: eighth.title, placeName: EIGHTH.placeName, region: "남구" },
        { title: ninth.title, placeName: NINTH.placeName, region: "동구" },
      ],
    })

    // Then: 세 후보의 제목 패턴이 서로 다르고, 수렴 패턴(order-guide)이나 최근 페이지 패턴과도 겹치지 않는다.
    const ids = [eighth.titlePatternId, ninth.titlePatternId, tenth.titlePatternId]
    expect(new Set(ids).size).toBe(3)
    expect(ids).not.toContain("order-guide")
    for (const revision of [eighth, ninth, tenth]) {
      expect(revision.keywords).toHaveLength(5)
      expect(revision.title.length).toBeLessThanOrEqual(40)
    }
  })
})

describe("품질 검사 강화", () => {
  const CONTENT: AiGeneratedSeoContent = {
    meta_title: "테스트병원 장례식장 근조화환 주문 안내",
    meta_description: "테스트병원 장례식장 근조화환 안내입니다.",
    description: "테스트병원 장례식장으로 화환을 보내는 안내입니다. 페이지의 '화환 주문하기' 버튼을 이용해 주세요.",
    faq: [
      { question: "질문 하나는 무엇인가요?", answer: "답변 하나입니다." },
      { question: "질문 둘은 무엇인가요?", answer: "답변 둘입니다." },
    ],
    keywords: ["테스트병원 장례식장", "근조화환 주문", "장례식장 화환", "화환 주문 안내", "지역 꽃배달"],
    internal_links: [],
  }

  function input(recentPages: readonly RecentContentSnapshot[]): QualityEvaluationInput {
    return { content: CONTENT, placeName: "테스트병원 장례식장", regionTokens: ["경남", "테스트시"], mode: "condolence", verifiedInternalPaths: new Set(), recentPages }
  }

  it("warns when the title pattern repeats within the recent five pages", () => {
    // Given: 최근 페이지에 동일 패턴(A) 제목 존재.
    const issues = checkTitleKeywordPatterns(input([snapshot("다른병원 장례식장", "다른시", "다른병원 장례식장 근조화환 주문 안내", [])]))
    expect(issues.some((issue) => issue.code === "repeat:title-pattern")).toBe(true)
  })

  it("warns on a third consecutive title suffix and on the stock keyword trio", () => {
    // Given: 직전 2건 접미사 '안내' + 고정 3종 키워드 포함 콘텐츠.
    const recent = [
      snapshot("병원1 장례식장", "시1", "병원1 장례식장 근조화환 주문 안내", []),
      snapshot("병원2 장례식장", "시2", "병원2 장례식장으로 보내는 근조화환 안내", []),
    ]
    const issues = checkTitleKeywordPatterns(input(recent))
    expect(issues.some((issue) => issue.code === "repeat:title-suffix")).toBe(true)
    expect(issues.some((issue) => issue.code === "keywords:stock-set")).toBe(true)
  })

  it("keeps banned-expression, address, and internal-link checks regression-safe", () => {
    // Given: 금지 표현·미검증 링크가 있는 콘텐츠.
    const report = evaluateGeneratedContent({
      ...input([]),
      content: { ...CONTENT, description: "주문은 공식 주문 CTA로 확인하세요.", internal_links: [{ href: "/area/fake", label: "x" }] },
    })
    expect(report.status).toBe("fail")
    expect(report.issues.some((issue) => issue.code === "banned:official-order")).toBe(true)
    expect(report.issues.some((issue) => issue.code === "link:unverified")).toBe(true)
  })
})
