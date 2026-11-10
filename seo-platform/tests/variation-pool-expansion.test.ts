// 변형 풀 확장 v2 — 20곳 배치에서 13곳이 needs_review로 빠진 원인(풀 소진)의 회귀 방지.
// 제목 16종·FAQ 10주제(45쌍)·도입문 12종이 실제 배치 조건에서 버티는지 본다.
import { describe, expect, it } from "vitest"

import type { ContentMode } from "@/lib/ai/content-mode"
import { scanBannedExpressions, type RecentContentSnapshot } from "@/lib/ai/content-quality"
import { faqTopicsFor, INTRO_VARIATION_SETS, pickContentVariation, type FaqTopicKey } from "@/lib/ai/content-variation"
import { allowedFaqPairCount, type FaqPairKeys } from "@/lib/ai/faq-variation"
import { buildKeywordPlan } from "@/lib/ai/keyword-variation"
import { MODE_VOCABULARY } from "@/lib/ai/mode-vocabulary"
import { generateAiPreview } from "@/lib/ai/service"
import { MAX_TITLE_LENGTH, pickTitlePattern, titlePatternsFor, titleRegionLabel, titleTraversalOrder, titleTraversalStride, type TitlePatternId } from "@/lib/ai/title-variation"
import type { AiGeneratedSeoContent, AiGenerationInput, AiProvider, AiRepository, GenerationVariationAudit, NewAiGeneration } from "@/lib/ai/types"
import { buildBatchAvoidance, type BatchAvoidanceSource } from "@/lib/batch/batch-avoidance"

import { ALL_CONTENT_MODES, faqQuestionsFor } from "./fixtures/faq-questions"

type TestPlace = { readonly id: string; readonly name: string; readonly category: string; readonly city: string; readonly district: string }

// 같은 지역의 장소 28곳씩 — 앞 8곳은 '이미 공개된 최근 페이지', 뒤 20곳이 한 배치다.
// 근조는 분원 신호(대학교·분원)가 있는 이름과 없는 이름을 섞었다.
const PLACE_NAMES: Readonly<Record<ContentMode, readonly string[]>> = {
  condolence: [
    "가람병원 장례식장", "나래의료원 장례식장", "다솜병원 장례식장", "라온요양병원 장례식장", "마루병원 장례식장", "바른병원 장례식장", "새봄병원 장례식장", "아름병원 장례식장",
    "한빛병원 장례식장", "늘푸른병원 장례식장", "창원중앙병원 장례식장", "마산제일병원 장례식장", "진해연세병원 장례식장", "한마음대학교병원 장례식장", "창원시민병원 장례식장", "합포의료원 장례식장",
    "동마산병원 장례식장", "창원한서병원 장례식장", "경남대학교병원 장례식장", "성산요양병원 장례식장", "의창병원 장례식장", "팔용병원 장례식장", "용원병원 분원 장례식장", "북면병원 장례식장",
    "상남병원 장례식장", "내서병원 장례식장", "진동병원 장례식장", "대방병원 장례식장",
  ],
  celebration: [
    "가람호텔", "나래컨벤션", "다솜웨딩홀", "라온아트홀", "마루호텔", "바른컨벤션센터", "새봄웨딩홀", "아름홀",
    "한빛호텔", "늘푸른컨벤션", "해운대센텀호텔", "광안웨딩홀", "마린시티컨벤션", "달맞이호텔", "센텀아트홀", "동백호텔",
    "송정비치호텔", "수영컨벤션센터", "해운대그랜드웨딩홀", "미포호텔", "청사포홀", "우동컨벤션", "재송웨딩홀", "반여아트센터",
    "좌동호텔", "중동컨벤션", "벡스코인근 연회장", "장산호텔",
  ],
  "corporate-celebration": [
    "가람산업", "나래정밀", "다솜건설", "라온테크", "마루화학", "바른중공업", "새봄전자", "아름기계",
    "한빛정밀 울산공장", "늘푸른산업", "온산화학 제2공장", "울주테크", "언양기계", "삼남정밀", "범서건설", "청량산업",
    "온양중공업", "웅촌전자", "두동화학", "상북테크 본사", "서생에너지", "삼동기계", "두서산업", "구영건설",
    "천상정밀", "굴화테크", "선바위산업", "반천일반산업단지 관리공단",
  ],
}

const REGION: Readonly<Record<ContentMode, { readonly city: string; readonly district: string; readonly category: string }>> = {
  condolence: { city: "경남", district: "창원시", category: "funeral" },
  celebration: { city: "부산", district: "해운대구", category: "호텔" },
  "corporate-celebration": { city: "울산", district: "울주군", category: "제조" },
}

function placesFor(mode: ContentMode): readonly TestPlace[] {
  return PLACE_NAMES[mode].map((name, index) => ({ id: `${mode}-place-${String(index).padStart(2, "0")}`, name, ...REGION[mode] }))
}

// content_plan을 그대로 돌려주는 provider — 선택 계층(제목·FAQ·키워드)만 검증한다.
const echoProvider: AiProvider = {
  generateSeoContent: (input: AiGenerationInput) =>
    Promise.resolve({
      description: `${input.place.name} 안내 본문입니다. 두 번째 문장입니다.`,
      meta_title: input.content_plan?.title ?? "제목",
      meta_description: `${input.place.name} 메타 설명입니다.`,
      faq: [
        { question: "질문 하나는 무엇인가요?", answer: "답변 하나입니다." },
        { question: "질문 둘은 무엇인가요?", answer: "답변 둘입니다." },
      ],
      keywords: input.content_plan?.keywords ?? ["키워드"],
      internal_links: [],
    }),
}

function repositoryFor(places: readonly TestPlace[], created: NewAiGeneration[]): AiRepository {
  return {
    findPlaceById: (placeId) => {
      const place = places.find((candidate) => candidate.id === placeId)
      const row = place === undefined ? undefined : { ...place, address: null, homepage: null, phone: null, normalized_phone: null, email: null }
      return Promise.resolve(row as unknown as Awaited<ReturnType<AiRepository["findPlaceById"]>>)
    },
    createAiGeneration: (input) => {
      created.push(input)
      return Promise.resolve({ id: `gen-${String(created.length)}`, place_id: input.placeId, status: "preview", input: input.input, output: input.output, before: null, after: null, created_at: "", applied_at: null })
    },
    findAiGenerationById: () => Promise.resolve(undefined),
    applyAiGeneration: () => Promise.reject(new Error("not used")),
  }
}

type Generated = { readonly place: TestPlace; readonly audit: GenerationVariationAudit; readonly title: string; readonly keywords: readonly string[] }

async function generate(
  mode: ContentMode,
  place: TestPlace,
  options: { readonly recent: readonly RecentContentSnapshot[]; readonly sources?: readonly BatchAvoidanceSource[]; readonly bannedFaqPairs?: readonly FaqPairKeys[] },
): Promise<Generated> {
  const created: NewAiGeneration[] = []
  await generateAiPreview({
    placeId: place.id,
    provider: echoProvider,
    repository: repositoryFor(placesFor(mode), created),
    recentContent: options.recent,
    ...(options.sources === undefined ? {} : { batchAvoidance: buildBatchAvoidance(options.sources) }),
    ...(options.bannedFaqPairs === undefined ? {} : { retry: { of: "original-generation", reason: "quality-fail-repeat-faq", bannedFaqPairs: options.bannedFaqPairs } }),
  })
  const stored = created[0]
  if (stored?.audit === undefined) {
    throw new Error(`no generation stored for ${place.name}`)
  }
  return { place, audit: stored.audit, title: stored.output.meta_title, keywords: stored.output.keywords }
}

function pairOf(audit: GenerationVariationAudit): FaqPairKeys {
  return audit.faq_topic_keys as unknown as FaqPairKeys
}

function pairId(keys: readonly string[]): string {
  return [...keys].sort().join("+")
}

function snapshotOf(mode: ContentMode, generated: Generated): RecentContentSnapshot {
  return {
    placeName: generated.place.name,
    region: titleRegionLabel(generated.place.city, generated.place.district),
    title: generated.title,
    description: null,
    faqQuestions: faqQuestionsFor(mode, generated.audit.faq_topic_keys as readonly FaqTopicKey[]),
    keywords: generated.keywords,
  }
}

const BATCH_SIZE = 20
// 운영에서 최근 공개 스냅샷은 8건을 읽고(listRecentPublishedContentSnapshots), FAQ 회피는 그중 최근 5건만 쓴다.
const RECENT_PUBLISHED = 8
const FAQ_RECENT_WINDOW = 5

async function simulateBatch(mode: ContentMode): Promise<{ readonly recent: readonly RecentContentSnapshot[]; readonly recentPairIds: readonly string[]; readonly batch: readonly Generated[] }> {
  const places = placesFor(mode)
  // 1) 이미 공개된 최근 페이지 — 하나씩 생성해 최신순으로 쌓는다.
  const recent: RecentContentSnapshot[] = []
  const recentPairIds: string[] = []
  for (const place of places.slice(0, RECENT_PUBLISHED)) {
    const published = await generate(mode, place, { recent })
    recent.unshift(snapshotOf(mode, published))
    recentPairIds.unshift(pairId(published.audit.faq_topic_keys))
  }
  // 2) 20곳 배치 — 각 item은 품질 FAIL로 1회 재시도되는 최악의 경우로 돌린다.
  //    마지막 item의 금지쌍 = 앞선 19건 + 최근 공개 5건 + 재시도 1건(자기 첫 시도).
  const sources: BatchAvoidanceSource[] = []
  const batch: Generated[] = []
  for (const place of places.slice(RECENT_PUBLISHED, RECENT_PUBLISHED + BATCH_SIZE)) {
    const firstAttempt = await generate(mode, place, { recent, sources })
    const retried = await generate(mode, place, { recent, sources, bannedFaqPairs: [pairOf(firstAttempt.audit)] })
    expect(pairId(retried.audit.faq_topic_keys), `${place.name}: 재시도는 실패한 pair를 다시 쓰지 않는다`).not.toBe(pairId(firstAttempt.audit.faq_topic_keys))
    batch.push(retried)
    sources.push({ audit: retried.audit, placeName: place.name, region: titleRegionLabel(place.city, place.district), keywords: retried.keywords })
  }
  return { recent, recentPairIds, batch }
}

describe("(a) 같은 지역 20곳 연속 배치 시뮬레이션", () => {
  for (const mode of ALL_CONTENT_MODES) {
    it(`${mode}: FAQ 조합이 소진되지 않고 서로 겹치지 않는다`, async () => {
      const { recentPairIds, batch } = await simulateBatch(mode)
      expect(batch).toHaveLength(BATCH_SIZE)

      // 소진 경로(faq:pool-exhausted WARN의 원인)가 한 번도 나오지 않는다.
      expect(batch.map((item) => item.audit.faq_selection)).not.toContain("exhausted-min-overlap")
      // 20건의 pair가 전부 다르고, 최근 공개 5건의 pair와도 겹치지 않는다.
      const batchPairIds = batch.map((item) => pairId(item.audit.faq_topic_keys))
      expect(new Set(batchPairIds).size).toBe(BATCH_SIZE)
      const bannedByRecent = new Set(recentPairIds.slice(0, FAQ_RECENT_WINDOW))
      expect(batchPairIds.filter((id) => bannedByRecent.has(id))).toEqual([])
      // 모든 pair는 해당 모드의 주제로만 구성된다.
      const modeKeys = new Set<string>(faqTopicsFor(mode).map((topic) => topic.key))
      for (const item of batch) {
        expect(item.audit.faq_topic_keys.every((key) => modeKeys.has(key)), item.place.name).toBe(true)
      }
    })

    it(`${mode}: 제목 패턴 중복이 최소화되고 제목이 서로 겹치지 않는다`, async () => {
      const { batch } = await simulateBatch(mode)
      const patternIds = batch.map((item) => item.audit.title_pattern_id)
      const usage = new Map<string, number>()
      for (const id of patternIds) {
        usage.set(id, (usage.get(id) ?? 0) + 1)
      }
      // 20곳 ÷ 16패턴 → 이론상 최소 중복은 '어떤 패턴도 2회 이하'. 풀 대부분이 실제로 쓰인다.
      expect(Math.max(...usage.values())).toBeLessThanOrEqual(2)
      expect(usage.size).toBeGreaterThanOrEqual(15)
      // 강한 제약: 직전 5건과 같은 패턴은 없다.
      for (const [index, id] of patternIds.entries()) {
        expect(patternIds.slice(Math.max(0, index - 5), index), `${String(index + 1)}번째 ${id}`).not.toContain(id)
      }
      // 제목 문자열은 전부 다르고, 장소명을 담고, 길이 규칙을 지킨다.
      const titles = batch.map((item) => item.title)
      expect(new Set(titles).size).toBe(BATCH_SIZE)
      for (const item of batch) {
        expect(item.title, item.place.name).toContain(item.place.name)
        expect(item.title.length, item.title).toBeLessThanOrEqual(MAX_TITLE_LENGTH)
      }
    })
  }

  it("is deterministic — 같은 입력의 배치는 같은 결과를 낸다 (재개·새로고침 동등성)", async () => {
    const first = await simulateBatch("celebration")
    const second = await simulateBatch("celebration")
    expect(second.batch.map((item) => [item.title, item.audit.faq_topic_keys])).toEqual(first.batch.map((item) => [item.title, item.audit.faq_topic_keys]))
  })
})

describe("(b) 모든 제목 패턴에 장소명이 들어간다", () => {
  const SAMPLE_NAME: Readonly<Record<ContentMode, readonly [string, string]>> = {
    condolence: ["가람병원 장례식장", "나래의료원 장례식장"],
    celebration: ["가람호텔", "나래컨벤션"],
    "corporate-celebration": ["가람산업", "나래정밀 제2공장"],
  }

  for (const mode of ALL_CONTENT_MODES) {
    it(`${mode}: 16종 전부 장소명을 포함하고, 같은 지역의 다른 장소와 제목이 갈린다`, () => {
      const patterns = titlePatternsFor(mode)
      expect(patterns).toHaveLength(16)
      expect(new Set(patterns.map((pattern) => pattern.id)).size).toBe(16)
      const [nameA, nameB] = SAMPLE_NAME[mode]
      for (const pattern of patterns) {
        for (const region of ["김해시", "대구 남구", ""]) {
          expect(pattern.build(nameA, region), `${pattern.id} (${region})`).toContain(nameA)
        }
        // 장소명이 빠진 패턴은 같은 지역에서 제목이 완전히 같아진다 — 반드시 달라야 한다.
        expect(pattern.build(nameA, "김해시"), pattern.id).not.toBe(pattern.build(nameB, "김해시"))
      }
      // 한 장소에서 16종의 문장이 모두 다르다 (패턴 감지가 모호해지지 않는다).
      expect(new Set(patterns.map((pattern) => pattern.build(nameA, "김해시"))).size).toBe(16)
    })

    it(`${mode}: 제목이 모드 금지 어휘·품질 금지 표현에 걸리지 않는다`, () => {
      const [nameA] = SAMPLE_NAME[mode]
      const forbidden = [...MODE_VOCABULARY[mode].forbiddenTerms, ...(MODE_VOCABULARY[mode].forbiddenPhrases ?? [])]
      for (const pattern of titlePatternsFor(mode)) {
        const title = pattern.build(nameA, "김해시")
        // 장소명 자체(예: '…장례식장')는 고유명사라 제외하고 패턴이 덧붙인 문구만 본다.
        const added = title.split(nameA).join(" ")
        if (mode !== "condolence") {
          expect(forbidden.filter((term) => added.includes(term)), `${pattern.id}: ${title}`).toEqual([])
        } else {
          expect(forbidden.filter((term) => title.includes(term)), `${pattern.id}: ${title}`).toEqual([])
        }
        const content: AiGeneratedSeoContent = { description: "", meta_title: title, meta_description: "", faq: [], keywords: [], internal_links: [] }
        expect(scanBannedExpressions(content), `${pattern.id}: ${title}`).toEqual([])
      }
    })
  }
})

describe("(c) 긴 장소명에서도 길이 규칙을 지킨다", () => {
  const LONG: Readonly<Record<ContentMode, { readonly name: string; readonly region: string }>> = {
    condolence: { name: "성균관대학교 삼성창원병원 장례식장", region: "창원시 마산회원구" },
    celebration: { name: "그랜드머큐어앰배서더창원 컨벤션홀", region: "창원시 마산회원구" },
    "corporate-celebration": { name: "현대위아 창원1공장 기술지원센터", region: "창원시 마산회원구" },
  }

  for (const mode of ALL_CONTENT_MODES) {
    it(`${mode}: 긴 장소명·긴 지역 라벨에서도 40자 이내 제목만 고른다`, () => {
      const { name, region } = LONG[mode]
      expect(name.length).toBeGreaterThanOrEqual(17)
      const patterns = titlePatternsFor(mode)
      const fitting = patterns.filter((pattern) => pattern.build(name, region).length <= MAX_TITLE_LENGTH)
      // 긴 이름에서도 풀이 4종 수준으로 쪼그라들지 않는다.
      expect(fitting.length).toBeGreaterThanOrEqual(12)

      // 회피 컨텍스트를 20건까지 쌓아가며 골라도 매번 길이 규칙을 지키고 장소명을 담는다.
      const patternIds: TitlePatternId[] = []
      const suffixKeys: string[] = []
      for (let index = 0; index < 20; index += 1) {
        const pick = pickTitlePattern(`long-seed-${String(index)}`, name, region, { patternIds, suffixKeys }, mode)
        expect(pick.title.length, pick.title).toBeLessThanOrEqual(MAX_TITLE_LENGTH)
        expect(pick.title).toContain(name)
        expect(patternIds.slice(0, 5)).not.toContain(pick.patternId)
        patternIds.unshift(pick.patternId)
        suffixKeys.unshift(pick.suffixKey)
      }
    })
  }

  it("falls back to the shortest pattern when nothing fits, still carrying the place name", () => {
    const name = "가나다라마바사아자차카타파하 가나다라마바사아자차카타파하 컨벤션센터"
    const pick = pickTitlePattern("seed", name, "창원시", { patternIds: [], suffixKeys: [] }, "celebration")
    expect(pick.title).toContain(name)
    expect(pick.fallbackApplied).toBe(true)
    const lengths = titlePatternsFor("celebration").map((pattern) => pattern.build(name, "창원시").length)
    expect(pick.title.length).toBe(Math.min(...lengths))
  })
})

describe("(d) 패턴 순회가 풀 전체를 방문한다", () => {
  it("visits every index exactly once for any pool size and any base", () => {
    // 예전 보폭 3 고정은 풀 크기가 3의 배수면 1/3만 돌았다 — 어떤 크기에서도 순열이어야 한다.
    for (let poolSize = 1; poolSize <= 48; poolSize += 1) {
      for (let base = 0; base < poolSize; base += 1) {
        const order = titleTraversalOrder(base, poolSize)
        expect(order[0]).toBe(base)
        expect([...order].sort((a, b) => a - b), `size ${String(poolSize)} base ${String(base)}`).toEqual(Array.from({ length: poolSize }, (_, index) => index))
      }
    }
  })

  it("keeps the original stride of 3 for the current pool size and leaves it when 3 would skip", () => {
    expect(titleTraversalStride(16)).toBe(3)
    expect(titleTraversalStride(8)).toBe(3)
    // 3의 배수 크기에서는 3을 쓰지 않는다.
    for (const poolSize of [6, 9, 12, 15, 18]) {
      expect(titleTraversalStride(poolSize) % 3, `size ${String(poolSize)}`).not.toBe(0)
    }
  })

  for (const mode of ALL_CONTENT_MODES) {
    it(`${mode}: 회피만으로 16종 전부에 도달한다`, () => {
      // Given: 같은 seed로 계속 고르되 앞선 선택을 전부 회피 컨텍스트에 넣는다 (접미사 규칙은 고유 키로 무력화).
      const patternIds: TitlePatternId[] = []
      const suffixKeys: string[] = []
      for (let index = 0; index < 16; index += 1) {
        const pick = pickTitlePattern("same-seed", "가람홀", "김해시", { patternIds, suffixKeys }, mode)
        patternIds.unshift(pick.patternId)
        suffixKeys.unshift(`unique-${String(index)}`)
      }
      // Then: 16번 만에 풀 전체를 한 번씩 방문한다.
      expect(new Set(patternIds)).toEqual(new Set(titlePatternsFor(mode).map((pattern) => pattern.id)))
    })
  }
})

describe("(e) 풀 크기", () => {
  it("has 10 FAQ topics per mode — 45 pairs, or 36 for condolence places without a branch signal", () => {
    for (const mode of ALL_CONTENT_MODES) {
      const keys = faqTopicsFor(mode).map((topic) => topic.key)
      expect(keys).toHaveLength(10)
      expect(new Set(keys).size).toBe(10)
    }
    // 분원 신호(대학교·본원·분원·캠퍼스)가 있는 근조 장소만 branch-lookup을 쓴다.
    expect(allowedFaqPairCount("condolence", "경남대학교병원 장례식장")).toBe(45)
    expect(allowedFaqPairCount("condolence", "용원병원 분원 장례식장")).toBe(45)
    expect(allowedFaqPairCount("condolence", "가람병원 장례식장")).toBe(36)
    expect(allowedFaqPairCount("celebration", "가람호텔")).toBe(45)
    expect(allowedFaqPairCount("corporate-celebration", "가람산업")).toBe(45)
    // 일반 근조의 36쌍도 배치 최악 금지쌍(19 + 5 + 1 = 25)보다 크다.
    expect(allowedFaqPairCount("condolence", "가람병원 장례식장")).toBeGreaterThan(BATCH_SIZE - 1 + FAQ_RECENT_WINDOW + 1)
  })

  it("never offers branch-lookup to a place without a branch signal, across a whole batch", async () => {
    const { batch } = await simulateBatch("condolence")
    for (const item of batch) {
      const hasSignal = /대학교|대학|본원|분원|캠퍼스/.test(item.place.name)
      if (!hasSignal) {
        expect(item.audit.faq_topic_keys, item.place.name).not.toContain("branch-lookup")
      }
    }
  })

  it("has 12 intro variations per mode, all distinct and reachable by hash", () => {
    for (const mode of ALL_CONTENT_MODES) {
      const intros = INTRO_VARIATION_SETS[mode]
      expect(intros).toHaveLength(12)
      expect(new Set(intros.map((intro) => intro.key)).size).toBe(12)
      expect(new Set(intros.map((intro) => intro.instruction)).size).toBe(12)
      // seed에 같은 숫자를 두 번 넣으면 FNV-1a의 최하위 비트가 상쇄돼 짝수 인덱스만 나온다 — 숫자는 한 번만 넣는다.
      const picked = new Set(Array.from({ length: 400 }, (_, index) => pickContentVariation(`place-${String(index)}:장소`, mode).intro.key))
      expect(picked.size).toBe(12)
    }
    // 도입문 key는 모드 간에도 고유하다.
    const allKeys = ALL_CONTENT_MODES.flatMap((mode) => INTRO_VARIATION_SETS[mode].map((intro) => intro.key))
    expect(new Set(allKeys).size).toBe(allKeys.length)
  })

  it("keeps mode-forbidden vocabulary out of intro and FAQ instructions", () => {
    for (const mode of ALL_CONTENT_MODES) {
      const forbidden = [...MODE_VOCABULARY[mode].forbiddenTerms, ...(MODE_VOCABULARY[mode].forbiddenPhrases ?? [])]
      const instructions = [...INTRO_VARIATION_SETS[mode].map((intro) => intro.instruction), ...faqTopicsFor(mode).map((topic) => topic.instruction)]
      for (const instruction of instructions) {
        expect(forbidden.filter((term) => instruction.includes(term)), `${mode}: ${instruction}`).toEqual([])
      }
    }
  })

  it("does not steer any instruction toward price, guarantee, or facility-policy claims", () => {
    // 지시문 자체가 금지 표현(가격·배송 보장·후기 등)을 담으면 모델이 그 표현을 따라 쓴다.
    for (const mode of ALL_CONTENT_MODES) {
      const instructions = [...INTRO_VARIATION_SETS[mode].map((intro) => intro.instruction), ...faqTopicsFor(mode).map((topic) => topic.instruction)]
      for (const instruction of instructions) {
        const content: AiGeneratedSeoContent = { description: instruction, meta_title: "", meta_description: "", faq: [], keywords: [], internal_links: [] }
        expect(scanBannedExpressions(content).map((issue) => issue.code), `${mode}: ${instruction}`).toEqual([])
      }
    }
  })

  it("builds a mode-clean keyword plan for every FAQ topic, including the v2 topics", () => {
    for (const mode of ALL_CONTENT_MODES) {
      const forbidden = [...MODE_VOCABULARY[mode].forbiddenTerms, ...(MODE_VOCABULARY[mode].forbiddenPhrases ?? [])]
      const placeName = mode === "condolence" ? "가람병원 장례식장" : "가람홀"
      for (const topic of faqTopicsFor(mode)) {
        for (let seedIndex = 0; seedIndex < 10; seedIndex += 1) {
          const plan = buildKeywordPlan({ seed: `seed-${String(seedIndex)}`, placeName, city: "경남", district: "김해시", mode, faqTopicKeys: [topic.key], recentSets: [] })
          expect(plan.keywords).toHaveLength(5)
          const added = plan.keywords.map((keyword) => (mode === "condolence" ? keyword : keyword.split(placeName).join(" ")))
          expect(added.filter((keyword) => forbidden.some((term) => keyword.includes(term))), `${mode}/${topic.key}`).toEqual([])
        }
      }
    }
  })
})
