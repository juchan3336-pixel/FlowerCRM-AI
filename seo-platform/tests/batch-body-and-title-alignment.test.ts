// 2026-11-10 근조 20곳 파일럿에서 나온 결함의 회귀 방어.
//  1) 같은 배치 안에서 장소명만 다른 같은 첫 문장이 둘 다 pass (#7 건국대학교병원 / #14 원병원)
//  2) 제목이 약속한 주제를 본문·FAQ가 다루지 않음 (#1 "화환 도착 시간 확인 방법")
//  3) 주소 원문의 "(지번) …" 꼬리가 문장에 그대로 인용됨
import { describe, expect, it } from "vitest"

import { formatAddressForContent } from "@/lib/ai/address-format"
import type { ContentMode } from "@/lib/ai/content-mode"
import { evaluateGeneratedContent, type PendingBodySnapshot, type QualityEvaluationInput } from "@/lib/ai/content-quality"
import { faqTopicsFor } from "@/lib/ai/content-variation"
import { buildTitleKeywordRevision } from "@/lib/ai/title-keyword-revision"
import { isTitlePatternCoveredByFaq, pickTitlePattern, TITLE_PATTERN_REQUIRED_FAQ_TOPICS, titlePatternsFor, type TitlePatternId } from "@/lib/ai/title-variation"
import type { AiGeneratedSeoContent } from "@/lib/ai/types"
import { buildBatchAvoidance } from "@/lib/batch/batch-avoidance"

const MODES: readonly ContentMode[] = ["condolence", "celebration", "corporate-celebration"]

function content(placeName: string, description: string): AiGeneratedSeoContent {
  return {
    meta_title: `${placeName} 근조화환 주문 안내`,
    meta_description: `${placeName} 근조화환 주문 안내입니다.`,
    description,
    faq: [
      { question: "빈소명을 모를 때 어떻게 확인하나요?", answer: "주문 과정에서 확인할 수 있습니다." },
      { question: "받는 분 정보를 어떻게 입력해야 하나요?", answer: "주문 과정 안내에 따라 입력합니다." },
    ],
    keywords: [placeName, "근조화환", "화환 주문", "조문 화환", "꽃배달"],
    internal_links: [],
  }
}

function input(placeName: string, description: string, pendingBodies: readonly PendingBodySnapshot[]): QualityEvaluationInput {
  return { content: content(placeName, description), placeName, regionTokens: ["경기", "남양주시"], mode: "condolence", verifiedInternalPaths: new Set(), recentPages: [], pendingBodies }
}

describe("같은 배치의 앞선 본문과 비교", () => {
  // 파일럿 실제 문장.
  const konkuk: PendingBodySnapshot = {
    placeName: "건국대학교병원 장례식장",
    region: "서울",
    description: "건국대학교병원 장례식장에 근조화환을 보내실 때는 빈소 정보를 정확히 입력해 주셔야 합니다. 주문 과정에서 빈소 확인과 주소 정보를 확인할 수 있습니다.",
  }
  const wonDescription = "원병원 장례식장에 근조화환을 보내실 때는 빈소 정보를 정확히 입력해 주셔야 합니다. 주문 과정에서 배송 가능 여부와 세부 사항을 확인할 수 있습니다."

  it("장소명만 다른 같은 첫 문장은 fail이다", () => {
    const report = evaluateGeneratedContent(input("원병원 장례식장", wonDescription, [konkuk]))
    expect(report.status).toBe("fail")
    expect(report.issues.some((issue) => issue.code === "repeat:first-sentence" && issue.message.includes("같은 배치"))).toBe(true)
  })

  it("앞선 본문이 없으면(지금까지의 동작) 같은 글이 통과한다 — 이 검사가 실제로 차이를 만든다", () => {
    const report = evaluateGeneratedContent(input("원병원 장례식장", wonDescription, []))
    expect(report.issues.some((issue) => issue.code === "repeat:first-sentence")).toBe(false)
  })

  it("첫 문장이 다르면 통과한다", () => {
    const different = "부고 문자에 적힌 장례식장명과 빈소 호실을 먼저 확인한 뒤 원병원 장례식장으로 근조화환을 주문하세요. 세부 조건은 주문 과정에서 확인할 수 있습니다."
    const report = evaluateGeneratedContent(input("원병원 장례식장", different, [konkuk]))
    expect(report.issues.some((issue) => issue.code.startsWith("repeat:first-sentence") || issue.code === "repeat:sentences")).toBe(false)
  })

  it("같은 장소의 본문(원본과 재시도, 보정 전후)은 자기 자신과 비교하지 않는다", () => {
    const self: PendingBodySnapshot = { placeName: "원병원 장례식장", region: "경기", description: wonDescription }
    const report = evaluateGeneratedContent(input("원병원 장례식장", wonDescription, [self]))
    expect(report.issues.some((issue) => issue.code === "repeat:first-sentence")).toBe(false)
  })

  it("문장 2개가 통째로 같으면 fail이다", () => {
    const twin = "주문 전 장례식장 이름을 먼저 확인하세요. 원병원 장례식장에 근조화환을 보내실 때는 빈소 정보를 정확히 입력해 주셔야 합니다. 주문 과정에서 빈소 확인과 주소 정보를 확인할 수 있습니다."
    const report = evaluateGeneratedContent(input("원병원 장례식장", twin, [konkuk]))
    expect(report.issues.some((issue) => issue.code === "repeat:sentences")).toBe(true)
  })

  it("배치 회피 문맥은 앞선 item의 본문을 싣는다 (본문 없는 item은 빠진다)", () => {
    const context = buildBatchAvoidance([
      { audit: null, placeName: "A 장례식장", region: null, keywords: [], description: "A 본문입니다." },
      { audit: null, placeName: "B 장례식장", region: null, keywords: [], description: null },
      { audit: null, placeName: "C 장례식장", region: null, keywords: [] },
    ])
    expect(context.bodies).toEqual([{ placeName: "A 장례식장", region: null, description: "A 본문입니다." }])
  })
})

describe("제목 주제와 FAQ 주제 정렬", () => {
  it("파일럿 #1: 빈소명·리본 FAQ에는 '도착 시간 확인 방법' 제목을 붙이지 않는다", () => {
    const revision = buildTitleKeywordRevision({
      placeId: "05c107f8-197b-4be9-972d-ec6dc4d7d206",
      placeName: "뉴타운장례식장",
      city: "서울",
      district: "성북구",
      mode: "condolence",
      recentPages: [],
      faqTopicKeys: ["unknown-room", "ribbon-wording"],
    })
    expect(revision.titlePatternId).not.toBe("arrival-time")
    expect(isTitlePatternCoveredByFaq(revision.titlePatternId, ["unknown-room", "ribbon-wording"])).toBe(true)
  })

  it("주제를 약속하는 패턴은 해당 FAQ 주제가 있을 때만 후보가 된다", () => {
    expect(isTitlePatternCoveredByFaq("arrival-time", ["unknown-room", "ribbon-wording"])).toBe(false)
    expect(isTitlePatternCoveredByFaq("arrival-time", ["arrival-time-check", "unknown-room"])).toBe(true)
    expect(isTitlePatternCoveredByFaq("order-guide", ["unknown-room", "ribbon-wording"])).toBe(true)
    // 구 호출부(FAQ 주제 미전달)는 제한하지 않는다.
    expect(isTitlePatternCoveredByFaq("arrival-time", undefined)).toBe(true)
  })

  it.each(MODES)("%s: 모든 FAQ 주제 쌍 × 여러 장소에서 고른 제목이 그 FAQ로 뒷받침된다", (mode) => {
    const keys = faqTopicsFor(mode).map((topic) => topic.key)
    for (let first = 0; first < keys.length; first += 1) {
      for (let second = first + 1; second < keys.length; second += 1) {
        const pair = [keys[first] ?? "", keys[second] ?? ""]
        for (let place = 0; place < 12; place += 1) {
          const pick = pickTitlePattern(`seed-${String(place)}`, `테스트 장소 ${String(place)}`, "서울", { patternIds: [], suffixKeys: [] }, mode, pair)
          expect(isTitlePatternCoveredByFaq(pick.patternId, pair), `${pick.patternId} with ${pair.join("+")}`).toBe(true)
        }
      }
    }
  })

  it.each(MODES)("%s: 회피 창이 가득 차도(최근 5건 + 배치 누적) 주제가 맞지 않는 제목으로 물러나지 않는다", (mode) => {
    const pair = faqTopicsFor(mode).slice(0, 2).map((topic) => topic.key)
    const used: (TitlePatternId | null)[] = []
    for (let place = 0; place < 40; place += 1) {
      const pick = pickTitlePattern(`seed-${String(place)}`, `테스트 장소 ${String(place)}`, "서울", { patternIds: used, suffixKeys: [] }, mode, pair)
      expect(isTitlePatternCoveredByFaq(pick.patternId, pair), pick.patternId).toBe(true)
      used.unshift(pick.patternId)
    }
  })

  // 위 전수 검사는 production 매핑 함수를 정답으로 쓴다 — 매핑 자체가 느슨하면 잡지 못한다.
  // 그래서 "이 제목은 이 FAQ 조합으로는 뒷받침되지 않는다"를 사람이 정한 기대값으로 따로 고정한다.
  it.each([
    // "수령 위치 확인" — 수령 담당자 부재·리본 문구만으로는 위치를 다루지 않는다.
    ["celebration", "celebration-receipt-point", ["recipient-absent", "ribbon-message"], false],
    ["celebration", "celebration-receipt-point", ["venue-access", "ribbon-message"], true],
    // "리본·회사명 표기법" — 축하 문구·정문 수령만으로는 회사명 표기를 다루지 않는다.
    ["corporate-celebration", "corporate-ribbon-label", ["corporate-ribbon-message", "gate-delivery"], false],
    ["corporate-celebration", "corporate-ribbon-label", ["sender-label", "gate-delivery"], true],
    // "도착 시간 확인 방법" — 배송 가능 여부만으로는 도착 시간을 다루지 않는다.
    ["condolence", "arrival-time", ["delivery-availability", "pre-order-check"], false],
    // "받는 분 성함 표기법" — 리본 문구만으로는 받는 분 표기를 다루지 않는다.
    ["condolence", "receiver-name", ["ribbon-wording", "address-lookup"], false],
    // "행사 시간 확인 후 주문" — 반입 위치만으로는 시간을 다루지 않는다.
    ["celebration", "celebration-event-time", ["venue-access", "ribbon-message"], false],
    // "정문·경비실 수령 확인" — 반입 절차만으로는 정문 수령을 다루지 않는다.
    ["corporate-celebration", "corporate-gate-receipt", ["site-access", "sender-label"], false],
  ] as const)("%s: %s 제목은 FAQ %j로 뒷받침되는가 → %s", (mode, patternId, faqTopics, expected) => {
    expect(isTitlePatternCoveredByFaq(patternId, faqTopics)).toBe(expected)
    if (!expected) {
      for (let place = 0; place < 30; place += 1) {
        const pick = pickTitlePattern(`seed-${String(place)}`, `테스트 장소 ${String(place)}`, "서울", { patternIds: [], suffixKeys: [] }, mode, faqTopics)
        expect(pick.patternId, `place ${String(place)}`).not.toBe(patternId)
      }
    }
  })

  it("매핑된 패턴 id와 FAQ 주제 key는 전부 실재한다 (오타 방지)", () => {
    const patternIds = new Set(MODES.flatMap((mode) => titlePatternsFor(mode).map((pattern) => pattern.id)))
    const topicKeys = new Set<string>(MODES.flatMap((mode) => faqTopicsFor(mode).map((topic) => topic.key)))
    for (const [patternId, topics] of Object.entries(TITLE_PATTERN_REQUIRED_FAQ_TOPICS)) {
      expect(patternIds.has(patternId as TitlePatternId), patternId).toBe(true)
      for (const topic of topics) {
        expect(topicKeys.has(topic), `${patternId} → ${topic}`).toBe(true)
      }
    }
  })

  it.each(MODES)("%s: 매핑된 패턴은 같은 모드의 FAQ 주제만 요구한다", (mode) => {
    const topicKeys = new Set<string>(faqTopicsFor(mode).map((topic) => topic.key))
    for (const pattern of titlePatternsFor(mode)) {
      for (const topic of TITLE_PATTERN_REQUIRED_FAQ_TOPICS[pattern.id] ?? []) {
        expect(topicKeys.has(topic), `${pattern.id} → ${topic}`).toBe(true)
      }
    }
  })
})

describe("생성 입력용 주소 표기", () => {
  it.each([
    ["서울 송파구 올림픽로43길 88 (지번) 풍납동 388-1", "서울 송파구 올림픽로43길 88"],
    ["경기 안성시 남파로 169 (우)17584", "경기 안성시 남파로 169"],
    ["경기 포천시 소흘읍 호국로 661 (우) 11174", "경기 포천시 소흘읍 호국로 661"],
    ["경기 성남시 수정구 성남대로 1219 태평서울병원 지하1층 (지번) 수진동 4553", "경기 성남시 수정구 성남대로 1219 태평서울병원 지하1층"],
    // 건물명·층 괄호는 건드리지 않는다.
    ["대구 수성구 달구벌대로 2200 (범어동) 3층", "대구 수성구 달구벌대로 2200 (범어동) 3층"],
    ["경남 진주시 강남로 79", "경남 진주시 강남로 79"],
    ["  경남 진주시 강남로 79  ", "경남 진주시 강남로 79"],
  ])("%s → %s", (raw, expected) => {
    expect(formatAddressForContent(raw)).toBe(expected)
  })

  it("도로명 없이 지번만 있으면 빈 값으로 만들지 않고 지번 주소를 남긴다", () => {
    expect(formatAddressForContent("(지번) 풍납동 388-1")).toBe("풍납동 388-1")
  })

  it("없는 주소는 없는 채로 둔다", () => {
    expect(formatAddressForContent(null)).toBeNull()
    expect(formatAddressForContent("   ")).toBeNull()
    expect(formatAddressForContent("(우)")).toBeNull()
  })
})
