import { describe, expect, it } from "vitest"

import { evaluateGeneratedContent } from "@/lib/ai/content-quality"
import { hashSeed, faqTopicsFor, type FaqTopicKey } from "@/lib/ai/content-variation"
import { allowedFaqPairCount, detectFaqPair, detectFaqTopicKey, pickFaqTopicPair, type FaqPairKeys } from "@/lib/ai/faq-variation"
import { OpenAiSeoContentProvider } from "@/lib/ai/openai-provider"
import type { AiGeneratedSeoContent } from "@/lib/ai/types"

import { ALL_CONTENT_MODES, FAQ_QUESTIONS, faqQuestionsFor } from "./fixtures/faq-questions"

// 13호점 실운영 seed — 해시 기본 선택이 unknown-room+recipient-input(11호점 새통영과 동일 조합)이었던 실제 사례.
const MASAN_SEED = "c5c08102-61d8-4f2d-a89f-9b0cd74c5d70:마산의료원 장례식장"
const MASAN_NAME = "마산의료원 장례식장"

// 11호점 새통영 실제 게시 질문 — repeat:faq FAIL의 비교 대상이었던 문자열 그대로.
const SAETONGYEONG_QUESTIONS = ["빈소명을 모를 때는 어떻게 확인하나요?", "받는 분 정보를 어떻게 입력해야 하나요?"] as const

const keySet = (keys: FaqPairKeys): ReadonlySet<string> => new Set(keys)

const QUESTIONS = FAQ_QUESTIONS
const MODES = ALL_CONTENT_MODES

function questionsOf(pair: FaqPairKeys): string[] {
  return faqQuestionsFor("condolence", pair)
}

// 마산의료원의 해시 기본 pair — 풀 크기에 따라 달라지므로 고정값 대신 회피 없는 선택으로 구한다.
const MASAN_HASH_PICK = pickFaqTopicPair({ mode: "condolence", seed: MASAN_SEED, placeName: MASAN_NAME, recentPages: [] })

describe("FAQ 질문 → topic key 복원", () => {
  it("detects topic keys from real published question strings", () => {
    expect(detectFaqTopicKey("빈소명을 모를 때는 어떻게 확인하나요?", "condolence")).toBe("unknown-room")
    expect(detectFaqTopicKey("받는 분 정보를 어떻게 입력해야 하나요?", "condolence")).toBe("recipient-input")
    expect(detectFaqTopicKey("장례식장 주소는 어떻게 확인하나요?", "condolence")).toBe("address-lookup")
    expect(detectFaqTopicKey("비슷한 이름의 장소와 구분하는 방법은 무엇인가요?", "condolence")).toBe("branch-lookup")
    expect(detectFaqTopicKey("화환 주문 전에 확인해야 할 정보는 무엇인가요?", "condolence")).toBe("pre-order-check")
    expect(detectFaqTopicKey("전혀 관련 없는 질문입니다", "condolence")).toBeNull()
  })

  it("restores every topic of every mode, including the v2 topics", () => {
    // Given / When / Then: 모드별 10주제 전부에 대표 질문이 있고, 각 질문이 자기 주제로 복원된다.
    for (const mode of MODES) {
      const keys = faqTopicsFor(mode).map((topic) => topic.key)
      expect(Object.keys(QUESTIONS[mode]).sort()).toEqual([...keys].sort())
      for (const key of keys) {
        expect(detectFaqTopicKey(QUESTIONS[mode][key] ?? "", mode), `${mode}/${key}`).toBe(key)
      }
    }
  })

  it("does not let v2 detectors swallow neighbouring v1 questions", () => {
    // '배송 시간'은 도착 시간 확인, '배송 가능 여부'는 기존 배송 가능 여부 주제로 남는다.
    expect(detectFaqTopicKey("배송 시간은 어떻게 확인하나요?", "condolence")).toBe("arrival-time-check")
    expect(detectFaqTopicKey("배송이 되는 지역인지 어떻게 확인하나요?", "condolence")).toBe("delivery-availability")
    // 받는 분 정보 '변경'은 입력 방법이 아니라 주문 후 변경 주제다.
    expect(detectFaqTopicKey("주문 후 받는 분 정보를 변경할 수 있나요?", "condolence")).toBe("order-change-check")
    // 리본 '문구'는 리본 주제, 문구 없이 보내는 분 표기만 물으면 보내는 분 표기 주제.
    expect(detectFaqTopicKey("리본 문구와 보내는 사람 표기는 어떻게 하나요?", "celebration")).toBe("ribbon-message")
    expect(detectFaqTopicKey("리본에 회사명과 대표자는 어떻게 표기하나요?", "corporate-celebration")).toBe("sender-label")
    // '반입 절차'는 주문 순서 주제로 넘어가지 않는다.
    expect(detectFaqTopicKey("화환 주문 시 반입 절차는 어떻게 확인하나요?", "corporate-celebration")).toBe("site-access")
  })

  it("restores a pair only when both questions are detectable", () => {
    expect(detectFaqPair([...SAETONGYEONG_QUESTIONS], "condolence")).toEqual(["unknown-room", "recipient-input"])
    expect(detectFaqPair(["빈소명을 모를 때는 어떻게 확인하나요?", "판별 불가 질문"], "condolence")).toBeNull()
  })
})

describe("FAQ 조합 최근 공개 회피", () => {
  it("keeps the hash pick when recent pages share no full pair (질문 1개 중복은 허용)", () => {
    // Given: 최근 페이지에 기본 pair의 질문 하나만 겹침 (pair 복원 불가).
    const [sharedQuestion] = questionsOf(MASAN_HASH_PICK.keys)
    const pick = pickFaqTopicPair({
      mode: "condolence",
      seed: MASAN_SEED,
      placeName: MASAN_NAME,
      recentPages: [{ faqQuestions: [sharedQuestion ?? "", "판별 불가 질문"] }],
    })

    // Then: 해시 기본 선택 유지.
    expect(MASAN_HASH_PICK.selection).toBe("hash")
    expect(pick.selection).toBe("hash")
    expect(keySet(pick.keys)).toEqual(keySet(MASAN_HASH_PICK.keys))
  })

  it("avoids the pair when both questions match a recent page (13호점 FAIL 사례 재현)", () => {
    // Given: 13호점 사례 — 해시 기본 pair와 같은 질문 2개가 최근 공개 5건 안에 있음.
    const pick = pickFaqTopicPair({
      mode: "condolence",
      seed: MASAN_SEED,
      placeName: MASAN_NAME,
      recentPages: [{ faqQuestions: questionsOf(MASAN_HASH_PICK.keys) }],
    })

    // Then: 동일 pair 회피 + 결정적 fallback.
    expect(pick.selection).toBe("fallback")
    expect(keySet(pick.keys)).not.toEqual(keySet(MASAN_HASH_PICK.keys))
    // 마산의료원은 branch 신호가 없으므로 fallback도 branch-lookup을 포함하지 않는다.
    expect(pick.keys).not.toContain("branch-lookup")
  })

  it("bans the pair restored from the real published questions of the 11호점 page", () => {
    // Given: 새통영 실제 게시 질문(unknown-room+recipient-input)이 최근 공개 5건 안에 있음.
    // When: 여러 seed로 선택해도
    for (let index = 0; index < 60; index += 1) {
      const pick = pickFaqTopicPair({
        mode: "condolence",
        seed: `seed-${String(index)}`,
        placeName: MASAN_NAME,
        recentPages: [{ faqQuestions: [...SAETONGYEONG_QUESTIONS] }],
      })
      // Then: 그 pair는 선택되지 않는다.
      expect(keySet(pick.keys)).not.toEqual(new Set(["unknown-room", "recipient-input"]))
    }
  })

  it("avoids a pair used twice in a row in recent pages", () => {
    // Given: 동일 pair가 2회 연속 사용됨 (문구는 달라도 topic이 같음).
    const pick = pickFaqTopicPair({
      mode: "condolence",
      seed: MASAN_SEED,
      placeName: MASAN_NAME,
      recentPages: [{ faqQuestions: questionsOf(MASAN_HASH_PICK.keys) }, { faqQuestions: questionsOf(MASAN_HASH_PICK.keys).map((question) => `혹시 ${question}`) }],
    })

    // Then: 해당 pair는 선택되지 않는다.
    expect(keySet(pick.keys)).not.toEqual(keySet(MASAN_HASH_PICK.keys))
  })

  it("only considers the five most recent pages", () => {
    // Given: 회피 대상 pair가 6번째(최근 5개 밖)에만 존재.
    const filler = { faqQuestions: ["판별 불가 질문 A", "판별 불가 질문 B"] }
    const pick = pickFaqTopicPair({
      mode: "condolence",
      seed: MASAN_SEED,
      placeName: MASAN_NAME,
      recentPages: [filler, filler, filler, filler, filler, { faqQuestions: questionsOf(MASAN_HASH_PICK.keys) }],
    })

    // Then: 윈도 밖이므로 해시 기본 선택 유지.
    expect(pick.selection).toBe("hash")
    expect(keySet(pick.keys)).toEqual(keySet(MASAN_HASH_PICK.keys))
  })

  it("excludes branch-lookup for places without a branch-like name", () => {
    // Given: 해시 기본 선택이 branch-lookup 조합인 seed를 결정적으로 찾는다 (분원 신호가 있는 장소명으로 판별).
    const BRANCH_NAME = "계명대학교 대구동산병원 장례식장"
    let branchSeed: string | null = null
    for (let index = 0; index < 500 && branchSeed === null; index += 1) {
      const seed = `seed-${String(index)}`
      if (pickFaqTopicPair({ mode: "condolence", seed, placeName: BRANCH_NAME, recentPages: [] }).keys.includes("branch-lookup")) {
        branchSeed = seed
      }
    }
    expect(branchSeed).not.toBeNull()

    // When: branch 신호 없는 장소명 vs 있는 장소명.
    const withoutSignal = pickFaqTopicPair({ mode: "condolence", seed: branchSeed ?? "", placeName: "마산의료원 장례식장", recentPages: [] })
    const withSignal = pickFaqTopicPair({ mode: "condolence", seed: branchSeed ?? "", placeName: "계명대학교 대구동산병원 장례식장", recentPages: [] })

    // Then: 신호 없는 장소는 branch 제외(fallback), 있는 장소는 해시 선택 유지.
    expect(withoutSignal.keys).not.toContain("branch-lookup")
    expect(withoutSignal.selection).toBe("fallback")
    expect(withSignal.keys).toContain("branch-lookup")
    expect(withSignal.selection).toBe("hash")
  })

  it("is deterministic for identical inputs, including fallback cases", () => {
    const input = {
      mode: "condolence" as const,
      seed: MASAN_SEED,
      placeName: MASAN_NAME,
      recentPages: [{ faqQuestions: [...SAETONGYEONG_QUESTIONS] }],
    }
    expect(pickFaqTopicPair(input)).toEqual(pickFaqTopicPair(input))
  })

  it("sizes the pool by mode and by branch signal", () => {
    // Given / When / Then: 모드별 10주제 = 45쌍. 분원 신호가 없는 근조 장소는 branch-lookup을 뺀 9주제 = 36쌍.
    for (const mode of MODES) {
      expect(faqTopicsFor(mode)).toHaveLength(10)
    }
    expect(allowedFaqPairCount("condolence", "계명대학교 대구동산병원 장례식장")).toBe(45)
    expect(allowedFaqPairCount("condolence", MASAN_NAME)).toBe(36)
    // 분원 주제는 근조 전용이라 다른 모드는 장소명과 무관하게 45쌍이다.
    expect(allowedFaqPairCount("celebration", "아이스퀘어호텔")).toBe(45)
    expect(allowedFaqPairCount("corporate-celebration", "KCC 울산공장")).toBe(45)
  })

  it("keeps the v1 pairs at the head of the pair order", () => {
    // Given: v1의 15쌍 순서(6주제의 a<b 나열).
    const legacyKeys = faqTopicsFor("condolence").slice(0, 6).map((topic) => topic.key)
    const legacyPairs: string[] = []
    for (let a = 0; a < legacyKeys.length; a += 1) {
      for (let b = a + 1; b < legacyKeys.length; b += 1) {
        legacyPairs.push(`${legacyKeys[a] ?? ""}+${legacyKeys[b] ?? ""}`)
      }
    }
    // When: 해시의 pair 인덱스가 15 미만이 되는 seed (= 풀 확장 전에도 같은 인덱스였던 장소).
    const topics = faqTopicsFor("condolence")
    let checked = 0
    for (let index = 0; index < 400; index += 1) {
      const seed = `seed-${String(index)}`
      const pairIndex = Math.floor(hashSeed(seed) / 31) % 45
      if (pairIndex >= 15) {
        continue
      }
      // Then: 기본 조합이 v1과 동일하다 (분원 신호가 있는 장소명으로 branch 제외를 끈다).
      const pick = pickFaqTopicPair({ mode: "condolence", seed, placeName: "계명대학교 대구동산병원 장례식장", recentPages: [] })
      expect(pick.keys.join("+")).toBe(legacyPairs[pairIndex])
      expect(pick.selection).toBe("hash")
      checked += 1
    }
    expect(checked).toBeGreaterThan(50)
    expect(topics.slice(0, 6).map((topic) => topic.key)).toEqual(["pre-order-check", "unknown-room", "address-lookup", "branch-lookup", "recipient-input", "delivery-availability"])
  })

  it("falls back to the minimum-overlap pair and flags exhaustion when every combination is banned", () => {
    // Given: branch 제외 후 허용되는 36개 조합 전부를 금지.
    const keys = faqTopicsFor("condolence").map((topic) => topic.key).filter((key) => key !== "branch-lookup")
    const bannedPairs: FaqPairKeys[] = []
    for (let a = 0; a < keys.length; a += 1) {
      for (let b = a + 1; b < keys.length; b += 1) {
        bannedPairs.push([keys[a] as FaqTopicKey, keys[b] as FaqTopicKey])
      }
    }

    // When
    const pick = pickFaqTopicPair({ mode: "condolence", seed: MASAN_SEED, placeName: MASAN_NAME, recentPages: [], bannedPairs })

    // Then: 최소 중복 조합을 결정적으로 선택하고 exhausted로 표시한다.
    expect(pick.selection).toBe("exhausted-min-overlap")
    expect(pick.keys).not.toContain("branch-lookup")
    expect(pickFaqTopicPair({ mode: "condolence", seed: MASAN_SEED, placeName: MASAN_NAME, recentPages: [], bannedPairs })).toEqual(pick)
  })
})

describe("faq_selection 고갈 WARN 안전망", () => {
  const CONTENT: AiGeneratedSeoContent = {
    meta_title: "창원시 장례식장 화환 주문 — 마산의료원 장례식장",
    meta_description: "마산의료원 장례식장 근조화환 주문 안내.",
    description: "마산의료원 장례식장에 근조화환을 보내실 때 확인할 정보를 안내합니다.",
    faq: [
      { question: "장례식장 주소는 어떻게 확인하나요?", answer: "공식 안내를 확인하세요." },
      { question: "배송 가능 여부는 어떻게 확인하나요?", answer: "주문 과정에서 확인할 수 있습니다." },
    ],
    keywords: ["마산의료원 장례식장"],
    internal_links: [],
  }

  it("adds a warn issue when the plan says the pool was exhausted", () => {
    const report = evaluateGeneratedContent({
      content: CONTENT,
      placeName: MASAN_NAME,
      regionTokens: ["경남", "창원시"],
      mode: "condolence",
      verifiedInternalPaths: new Set(),
      recentPages: [],
      faqSelection: "exhausted-min-overlap",
    })
    expect(report.status).toBe("warn")
    expect(report.issues.some((issue) => issue.code === "faq:pool-exhausted" && issue.level === "warn")).toBe(true)
  })

  it("does not add the warn for hash/fallback selections", () => {
    for (const selection of ["hash", "fallback", null]) {
      const report = evaluateGeneratedContent({
        content: CONTENT,
        placeName: MASAN_NAME,
        regionTokens: ["경남", "창원시"],
        mode: "condolence",
      verifiedInternalPaths: new Set(),
        recentPages: [],
        faqSelection: selection,
      })
      expect(report.issues.some((issue) => issue.code === "faq:pool-exhausted")).toBe(false)
    }
  })
})

describe("OpenAI 프롬프트가 content_plan FAQ pair를 사용", () => {
  it("sends the planned faq topic instructions instead of the hash pick", async () => {
    // Given: content_plan이 address-lookup+delivery-availability를 확정.
    let requestBody: Record<string, unknown> | null = null
    const fetchImpl: typeof fetch = (_url, init) => {
      requestBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 }),
      )
    }
    const provider = new OpenAiSeoContentProvider({ apiKey: "test-key", model: "test-model", fetchImpl })

    // When
    await provider.generateSeoContent({
      content_mode: "condolence",
      place: { id: "c5c08102-61d8-4f2d-a89f-9b0cd74c5d70", name: MASAN_NAME, category: "funeral", city: "경남", district: "창원시", address: null, homepage: null },
      guardrails: [],
      content_plan: {
        title: "제목",
        title_pattern_id: "region-dash",
        keywords: ["k1"],
        keyword_roles: ["official-name"],
        faq_topic_keys: ["address-lookup", "delivery-availability"],
        faq_selection: "fallback",
      },
    })

    // Then: variation.faq_topics가 계획 pair의 instruction과 일치한다 (해시 기본 unknown-room+recipient-input이 아님).
    const messages = (requestBody as unknown as { messages: { content: string }[] }).messages
    const userPayload = JSON.parse(messages[1]?.content ?? "{}") as { variation: { faq_topics: string[] } }
    const instructionOf = (key: string): string => faqTopicsFor("condolence").find((topic) => topic.key === key)?.instruction ?? ""
    expect(userPayload.variation.faq_topics).toEqual([instructionOf("address-lookup"), instructionOf("delivery-availability")])
  })
})
