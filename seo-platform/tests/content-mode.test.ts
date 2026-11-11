import { describe, expect, it } from "vitest"

import { decideBatchCandidate } from "@/lib/batch/candidate-policy"
import { contentModeForCategory, requireContentMode, UnsupportedContentCategoryError, type ContentMode } from "@/lib/ai/content-mode"
import { faqTopicsFor, pickContentVariation } from "@/lib/ai/content-variation"
import { FakeDeterministicAiProvider } from "@/lib/ai/fake-provider"
import { detectFaqTopicKey, pickFaqTopicPair } from "@/lib/ai/faq-variation"
import { buildKeywordPlan } from "@/lib/ai/keyword-variation"
import { systemPromptForMode } from "@/lib/ai/openai-provider"
import { buildTitleKeywordRevision } from "@/lib/ai/title-keyword-revision"
import { detectTitlePatternId, pickTitlePattern, titlePatternsFor } from "@/lib/ai/title-variation"
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
  it("keeps the original eight condolence patterns unchanged at the head of the expanded set", () => {
    // 풀은 16종으로 늘었지만 기존 8종은 id·순서·문구가 그대로 앞쪽에 남아야 한다 (저장된 audit·기존 게시 제목 감지 호환).
    const condolence = titlePatternsFor("condolence")
    expect(condolence).toHaveLength(16)
    expect(condolence.slice(0, 8).map((pattern) => pattern.id)).toEqual([
      "order-guide",
      "pre-send-check",
      "region-checklist",
      "order-info",
      "directional",
      "intake-check",
      "region-dash",
      "binso-guide",
    ])
    expect(condolence.slice(0, 8).map((pattern) => pattern.build("영남대학교병원 장례식장", "대구 남구"))).toEqual([
      "영남대학교병원 장례식장 근조화환 주문 안내",
      "영남대학교병원 장례식장 화환 보내기 전 확인 정보",
      "대구 남구 영남대학교병원 장례식장 근조화환 주문 체크사항",
      "영남대학교병원 장례식장 화환 주문 정보",
      "영남대학교병원 장례식장으로 보내는 근조화환 안내",
      "영남대학교병원 장례식장 화환 접수 전 확인사항",
      "대구 남구 장례식장 화환 주문 — 영남대학교병원 장례식장",
      "영남대학교병원 장례식장 빈소 화환 주문 가이드",
    ])
  })

  it("builds celebration and corporate titles without funeral wording", () => {
    for (const mode of NON_CONDOLENCE_MODES) {
      const patterns = titlePatternsFor(mode)
      expect(patterns).toHaveLength(16)
      for (const pattern of patterns) {
        const title = pattern.build("아이스퀘어호텔", "김해시")
        expect(containsFuneralWord(title), `${pattern.id}: ${title}`).toBe(false)
        expect(title.length).toBeLessThanOrEqual(40)
      }
    }
    expect(titlePatternsFor("celebration").map((pattern) => pattern.build("아이스퀘어호텔", "김해시"))).toContain("아이스퀘어호텔 행사 축하화환 배송")
    // 예식장·호텔(celebration)은 개업 문맥이 아니다 — 제목·키워드·본문 지시에 '오픈'·건물 구조 전제가 없어야 한다.
    for (const pattern of titlePatternsFor("celebration")) expect(pattern.build("아이스퀘어호텔", "김해시")).not.toMatch(/오픈|개업/)
    expect(titlePatternsFor("corporate-celebration").map((pattern) => pattern.build("KCC 울산공장", "울산"))).toContain("KCC 울산공장 축하화환 주문 안내")
  })

  // 기업 페이지는 조사로 확인한 행사 종류를 생성 입력에 넘기지 않는다 — 코드가 정하는 제목·키워드·도입·FAQ 지시가
  // 근거 없는 행사 종류(개업·이전·준공·창립·취임·승진)나 정문·경비실을 전제하면 안 된다.
  it("keeps corporate titles, keywords and instructions free of unverified event types and gate assumptions", () => {
    const EVENT_OR_GATE = /개업|이전|준공|창립|취임|승진|정문|경비실|하역/
    for (const pattern of titlePatternsFor("corporate-celebration")) expect(pattern.build("KCC 울산공장", "울산"), pattern.id).not.toMatch(EVENT_OR_GATE)
    for (const topic of faqTopicsFor("corporate-celebration")) expect(topic.instruction, topic.key).not.toMatch(EVENT_OR_GATE)
    for (let index = 0; index < 100; index += 1) {
      const variation = pickContentVariation(`corp-${String(index)}`, "corporate-celebration")
      expect(variation.intro.instruction, variation.intro.key).not.toMatch(EVENT_OR_GATE)
      expect(variation.structure.instruction, variation.structure.key).not.toMatch(EVENT_OR_GATE)
      const topics = faqTopicsFor("corporate-celebration")
      const plan = buildKeywordPlan({ seed: `kw-${String(index)}`, placeName: "KCC 울산공장", city: "울산", district: "동구", recentSets: [], mode: "corporate-celebration", faqTopicKeys: [topics[index % topics.length]?.key ?? "sender-label", topics[(index + 3) % topics.length]?.key ?? "site-access"] })
      expect(plan.keywords.some((keyword) => EVENT_OR_GATE.test(keyword)), plan.keywords.join(", ")).toBe(false)
    }
    // 시스템 지시는 행사 종류를 쓰지 말라고만 말하고, 그 맥락으로 작성하라고 하지 않는다.
    const prompt = systemPromptForMode("corporate-celebration")
    expect(prompt).not.toMatch(/(개업|준공|창립|취임|승진)[^\n]*맥락으로 작성/)
    expect(prompt).toContain("특정 행사가 있다고 쓰지 마세요")
  })

  it("maps both old and new corporate FAQ wording back to the same topics", () => {
    expect(detectFaqTopicKey("경비실 수령이 가능한가요?", "corporate-celebration")).toBe("gate-delivery")
    expect(detectFaqTopicKey("화환을 받는 위치와 담당자는 어떻게 확인하나요?", "corporate-celebration")).toBe("gate-delivery")
    expect(detectFaqTopicKey("준공식 시간에 맞춰 보내려면 어떻게 하나요?", "corporate-celebration")).toBe("ceremony-time")
    expect(detectFaqTopicKey("사업장 행사 시간에 맞춰 도착하려면 언제 주문하나요?", "corporate-celebration")).toBe("ceremony-time")
    // 변경 질문은 먼저 변경 주제로 간다 (행사 시간이 바뀌는 경우).
    expect(detectFaqTopicKey("주문 후 행사 시간이 바뀌면 어떻게 하나요?", "corporate-celebration")).toBe("corporate-order-change")
  })

  it("still recognises the pre-2026-11-11 corporate titles as the same patterns", () => {
    const legacy: readonly (readonly [string, string])[] = [
      ["KCC 울산공장 개업·이전 축하화환 주문 안내", "corporate-opening-guide"],
      ["울산 KCC 울산공장 준공 축하화환 배송", "corporate-completion-delivery"],
      ["KCC 울산공장 창립·취임 축하화환 보내는 방법", "corporate-founding-howto"],
      ["개업·준공 축하화환 주문 전 확인 — KCC 울산공장", "corporate-wreath-first-dash"],
      ["KCC 울산공장 정문·경비실 화환 수령 확인", "corporate-gate-receipt"],
      ["KCC 울산공장 승진·취임 축하화환 주문 가이드", "corporate-promotion-guide"],
      ["울산 기업·공장 준공 축하화환 배송", "corporate-completion-delivery"],
    ]
    for (const [title, id] of legacy) expect(detectTitlePatternId(title, "KCC 울산공장", ["울산"], "corporate-celebration"), title).toBe(id)
    const current = titlePatternsFor("corporate-celebration").map((pattern) => pattern.build("KCC 울산공장", "울산"))
    for (const [title] of legacy) expect(current).not.toContain(title)
    // 새 문구끼리도 서로 다른 패턴으로 복원된다.
    for (const pattern of titlePatternsFor("corporate-celebration")) expect(detectTitlePatternId(pattern.build("KCC 울산공장", "울산"), "KCC 울산공장", ["울산"], "corporate-celebration")).toBe(pattern.id)
  })

  it("still recognises the pre-2026-11-11 celebration delivery title as the same pattern", () => {
    // Given: 문구를 바꾸기 전에 게시된 제목과 새 제목
    const legacy = "검토웨딩홀 행사·오픈 축하화환 배송"
    const current = "검토웨딩홀 행사 축하화환 배송"

    // Then: 둘 다 같은 패턴 id로 복원된다
    expect(detectTitlePatternId(legacy, "검토웨딩홀", ["서울"], "celebration")).toBe("celebration-event-delivery")
    expect(detectTitlePatternId(current, "검토웨딩홀", ["서울"], "celebration")).toBe("celebration-event-delivery")
    // And: 옛 문구는 감지 전용이라 생성 목록에는 나오지 않는다
    expect(titlePatternsFor("celebration").map((pattern) => pattern.build("검토웨딩홀", "서울"))).not.toContain(legacy)

    // And: 옛 제목이 최근 공개 목록에 있으면 같은 패턴을 다시 고르지 않는다
    const seed = Array.from({ length: 200 }, (_, index) => `legacy-check-${String(index)}`).find(
      (candidate) => pickTitlePattern(candidate, "새웨딩홀", "서울", { patternIds: [], suffixKeys: [] }, "celebration").patternId === "celebration-event-delivery",
    )
    expect(seed).toBeDefined()
    const detected = detectTitlePatternId(legacy, "검토웨딩홀", ["서울"], "celebration")
    const avoided = pickTitlePattern(seed ?? "", "새웨딩홀", "서울", { patternIds: detected === null ? [] : [detected], suffixKeys: [] }, "celebration")
    expect(avoided.patternId).not.toBe("celebration-event-delivery")
  })

  it("never puts opening wording into celebration keywords", () => {
    for (let index = 0; index < 100; index += 1) {
      const plan = buildKeywordPlan({ seed: `kw-${String(index)}`, placeName: "검토웨딩홀", city: "서울", district: "강남구", recentSets: [], mode: "celebration", faqTopicKeys: ["event-date", "venue-access"] })
      expect(plan.keywords.some((keyword) => /오픈|개업/.test(keyword)), plan.keywords.join(", ")).toBe(false)
    }
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
    expect(corporate.keywords).toContain("울산 기업 축하화환")
    expect(corporate.keywords.some((keyword) => containsFuneralWord(keyword))).toBe(false)
    // 슬롯 구성은 모드가 달라도 같다.
    expect(corporate.roles).toEqual(["official-name", "region-wreath", "place-flower", "faq-intent", "delivery"])
  })
})

describe("모드별 FAQ 폴백", () => {
  it("gives every mode the same number of topics", () => {
    const sizes = (["condolence", ...NON_CONDOLENCE_MODES] as const).map((mode) => faqTopicsFor(mode).length)
    expect(new Set(sizes).size).toBe(1)
    expect(sizes[0]).toBe(10)
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

// 2026-11-10 웨딩 파일럿: "주문 과정에서 반입 위치 확인이 가능합니다"처럼 시설 정책을 주문 서비스가 확인해 주는 것으로 읽히는 FAQ가 나왔다.
describe("축하·기업 모드의 확인 주체 구분", () => {
  it.each(["celebration", "corporate-celebration"] as const)("%s 프롬프트는 시설 정책은 시설에, 제작·배송은 주문 과정에서 확인한다고 구분한다", (mode) => {
    const prompt = systemPromptForMode(mode)
    expect(prompt).toContain("시설에 직접 확인")
    expect(prompt).toContain("시설의 반입 허용이나 반입 위치 확인과 혼동하지 마세요")
    // 주문 변경 FAQ 주제("변경 가능 여부는 주문 과정에서 확인")와 충돌하지 않도록 주문 과정의 범위를 '뿐'으로 좁히지 않는다.
    expect(prompt).not.toContain("가능 여부뿐")
    expect(prompt).toContain("보낼 수 있다고 단정하지 마세요")
  })

  it("근조 모드 프롬프트에는 넣지 않는다", () => {
    expect(systemPromptForMode("condolence")).not.toContain("시설에 직접 확인")
  })

  it("행사장 반입 주제는 행사장에 직접 확인하도록 지시한다", () => {
    const topic = faqTopicsFor("celebration").find((entry) => entry.key === "venue-access")
    expect(topic?.instruction).toContain("행사장에 직접 확인")
    expect(topic?.instruction).toContain("주문 과정에서 확인된다고 쓰지 말 것")
  })
})
