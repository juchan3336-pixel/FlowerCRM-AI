import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { FakeDeterministicAiProvider } from "@/lib/ai/fake-provider"
import { pickFaqTopicPair, type FaqPairKeys } from "@/lib/ai/faq-variation"
import { generateAiPreview } from "@/lib/ai/service"
import { buildTitleKeywordRevision } from "@/lib/ai/title-keyword-revision"
import { titlePatternIdOf, type TitlePatternId } from "@/lib/ai/title-variation"
import type { GenerationVariationAudit, NewAiGeneration } from "@/lib/ai/types"
import { buildBatchAvoidance, EMPTY_BATCH_AVOIDANCE, isAvoidanceSourceItem, type BatchAvoidanceSource } from "@/lib/batch/batch-avoidance"
import { InMemorySyncRepository } from "@/lib/sync/in-memory-repository"
import { syncSheetRows } from "@/lib/sync/service"

const fixturePath = resolve("tests/fixtures/sheet-rows.json")

async function seededRepository(): Promise<InMemorySyncRepository> {
  const rows: unknown = JSON.parse(await readFile(fixturePath, "utf8"))
  const repository = new InMemorySyncRepository()
  await syncSheetRows({ repository, rows, sheetName: "기업 DB" })
  return repository
}

const AUDIT: GenerationVariationAudit = {
  title_pattern_id: "order-guide",
  title_suffix_key: "order-guide",
  title_fallback: false,
  keyword_roles: ["official-name", "region-wreath", "place-flower", "faq-intent", "delivery"],
  keywords_rebuilt: false,
  faq_topic_keys: ["pre-order-check", "unknown-room"],
  faq_selection: "hash",
  fallback: false,
}

const REVISION_BASE = {
  placeId: "place-1",
  placeName: "가상병원 장례식장",
  city: "경남",
  district: "진주시",
  mode: "condolence",
  recentPages: [],
} as const

describe("배치 내 회피 컨텍스트 빌더", () => {
  it("keeps only sequence-smaller terminal items with a generation as avoidance sources", () => {
    expect(isAvoidanceSourceItem({ sequence: 1, status: "ready", generationId: "g1" }, 3)).toBe(true)
    expect(isAvoidanceSourceItem({ sequence: 2, status: "warn_ready", generationId: "g2" }, 3)).toBe(true)
    expect(isAvoidanceSourceItem({ sequence: 2, status: "needs_review", generationId: "g2" }, 3)).toBe(true)
    // 제외: 이후 sequence·미확정·콘텐츠 없음·generation 없음
    expect(isAvoidanceSourceItem({ sequence: 3, status: "ready", generationId: "g3" }, 3)).toBe(false)
    expect(isAvoidanceSourceItem({ sequence: 1, status: "processing", generationId: "g1" }, 3)).toBe(false)
    expect(isAvoidanceSourceItem({ sequence: 1, status: "failed", generationId: "g1" }, 3)).toBe(false)
    expect(isAvoidanceSourceItem({ sequence: 1, status: "skipped", generationId: null }, 3)).toBe(false)
    expect(isAvoidanceSourceItem({ sequence: 1, status: "ready", generationId: null }, 3)).toBe(false)
  })

  it("maps audits to patterns/pairs newest-first and safely ignores audit-less priors", () => {
    const sources: BatchAvoidanceSource[] = [
      { audit: AUDIT, placeName: "A병원 장례식장", region: null, keywords: ["A병원 장례식장", "진주 근조화환"] },
      { audit: null, placeName: "B병원 장례식장", region: null, keywords: ["B병원 장례식장"] },
    ]
    const context = buildBatchAvoidance(sources)
    // audit 없는 B는 패턴·pair에 기여하지 않지만 키워드 세트는 남는다. 최신(B) 우선 순서.
    expect(context.titlePatterns).toEqual([{ patternId: "order-guide", suffixKey: "order-guide" }])
    expect(context.faqPairs).toEqual([["pre-order-check", "unknown-room"]])
    expect(context.keywordSets.map((set) => set.placeName)).toEqual(["B병원 장례식장", "A병원 장례식장"])
  })

  it("drops malformed faq keys and unknown pattern ids without throwing", () => {
    const context = buildBatchAvoidance([
      { audit: { ...AUDIT, title_pattern_id: "not-a-pattern", faq_topic_keys: ["pre-order-check"] }, placeName: "C", region: null, keywords: [] },
    ])
    expect(context.titlePatterns).toEqual([{ patternId: null, suffixKey: "order-guide" }])
    expect(context.faqPairs).toEqual([])
    expect(buildBatchAvoidance([])).toEqual(EMPTY_BATCH_AVOIDANCE)
  })
})

describe("후속 item 회피 동작 (결정적)", () => {
  it("첫 item과 동일 조건(회피 없음)은 기존 공개 데이터 기준 결과와 동일하다", () => {
    const plain = buildTitleKeywordRevision(REVISION_BASE)
    const emptyAvoidance = buildTitleKeywordRevision({ ...REVISION_BASE, pendingPatterns: [], pendingKeywordSets: [] })
    expect(emptyAvoidance).toEqual(plain)
  })

  it("avoids the sibling's title pattern and marks the fallback path", () => {
    const first = buildTitleKeywordRevision(REVISION_BASE)
    const second = buildTitleKeywordRevision({
      ...REVISION_BASE,
      pendingPatterns: [{ patternId: first.titlePatternId, suffixKey: first.titleSuffixKey }],
    })
    expect(second.titlePatternId).not.toBe(first.titlePatternId)
    expect(second.titleFallbackApplied).toBe(true)
  })

  it("avoids the sibling's FAQ pair and exhausts to min-overlap with WARN grounds when everything collides", () => {
    const seed = "place-1:가상병원 장례식장"
    const first = pickFaqTopicPair({ seed, mode: "condolence", placeName: "가상병원 장례식장", recentPages: [] })
    const second = pickFaqTopicPair({ seed, mode: "condolence", placeName: "가상병원 장례식장", recentPages: [], bannedPairs: [first.keys] })
    expect(second.keys).not.toEqual(first.keys)
    expect(second.selection).toBe("fallback")

    // 모든 조합 충돌 → 최소 중복 선택 + exhausted-min-overlap (content-quality가 faq:pool-exhausted WARN으로 표시)
    const topicKeys = ["pre-order-check", "unknown-room", "address-lookup", "branch-lookup", "recipient-input", "delivery-availability"]
    const allPairs: FaqPairKeys[] = []
    for (let a = 0; a < topicKeys.length; a += 1) {
      for (let b = a + 1; b < topicKeys.length; b += 1) {
        allPairs.push([topicKeys[a], topicKeys[b]] as unknown as FaqPairKeys)
      }
    }
    const exhausted = pickFaqTopicPair({ seed, mode: "condolence", placeName: "가상병원 장례식장", recentPages: [], bannedPairs: allPairs })
    expect(exhausted.selection).toBe("exhausted-min-overlap")
  })

  it("relaxes keyword-role duplication against the sibling's keyword set", () => {
    // faq-intent 후보가 2개인 pair를 고정해 재구성 조합이 존재하게 한다 (후보 1개 topic이면 조합이 소진되는 기존 한계 회피).
    const base = { ...REVISION_BASE, faqTopicKeys: ["pre-order-check", "unknown-room"] as const }
    const first = buildTitleKeywordRevision(base)
    // 형제 세트를 동일한 마스킹 조건(같은 장소명, region null)으로 넣으면 5/5 겹침 → 결정적 재구성.
    const second = buildTitleKeywordRevision({
      ...base,
      pendingKeywordSets: [{ placeName: REVISION_BASE.placeName, region: null, keywords: first.keywords }],
    })
    expect(second.keywordsRebuilt).toBe(true)
    expect(second.keywords).not.toEqual(first.keywords)
  })

  it("is deterministic for identical inputs (재개·새로고침 동등성) and order-sensitive when the window changes", () => {
    const first = buildTitleKeywordRevision(REVISION_BASE)
    // 필러는 기본(해시) 패턴을 제외한 나머지에서 5개 — 창 구성만으로 회피 여부가 갈리게 한다.
    const fillers: TitlePatternId[] = ["order-guide", "pre-send-check", "region-checklist", "order-info", "directional", "intake-check", "region-dash", "binso-guide"]
      .map((id) => titlePatternIdOf(id))
      .filter((id): id is TitlePatternId => id !== null && id !== first.titlePatternId)
      .slice(0, 5)
    const windowIncludesBase = [{ patternId: first.titlePatternId, suffixKey: first.titleSuffixKey }, ...fillers.slice(0, 4).map((id) => ({ patternId: id, suffixKey: id })), { patternId: fillers[4] ?? first.titlePatternId, suffixKey: "x" }]
    const windowExcludesBase = [...windowIncludesBase.slice(1), windowIncludesBase[0]] as typeof windowIncludesBase

    const withBase = buildTitleKeywordRevision({ ...REVISION_BASE, pendingPatterns: windowIncludesBase })
    const withBaseAgain = buildTitleKeywordRevision({ ...REVISION_BASE, pendingPatterns: windowIncludesBase })
    const withoutBase = buildTitleKeywordRevision({ ...REVISION_BASE, pendingPatterns: windowExcludesBase })

    expect(withBaseAgain).toEqual(withBase)
    // 회피 창(최근 5)에 기본 패턴이 들어있는 순서에서는 회피, 밀려난 순서에서는 기본 패턴 선택 — 순서가 결과를 결정한다.
    expect(withBase.titlePatternId).not.toBe(first.titlePatternId)
    expect(withoutBase.titlePatternId).toBe(first.titlePatternId)
  })
})

describe("service 통합 — batchAvoidance가 신규 생성에 반영된다", () => {
  function withCaptor(repository: InMemorySyncRepository, captured: NewAiGeneration[]) {
    return {
      findPlaceById: (placeId: string) => repository.findPlaceById(placeId),
      findAiGenerationById: (generationId: string) => repository.findAiGenerationById(generationId),
      applyAiGeneration: (input: Parameters<InMemorySyncRepository["applyAiGeneration"]>[0]) => repository.applyAiGeneration(input),
      createAiGeneration: (input: NewAiGeneration) => {
        captured.push(input)
        return repository.createAiGeneration(input)
      },
    }
  }

  it("applies title/faq avoidance to the next generation and keeps prior data untouched", async () => {
    const repository = await seededRepository()
    // 생성은 장례식장(funeral)만 지원한다 — fixture 첫 행은 병원이라 funeral 장소를 고른다.
    const place = repository.places().find((row) => row.category === "funeral")
    expect(place).toBeDefined()
    if (place === undefined) {
      return
    }
    const baseline: NewAiGeneration[] = []
    await generateAiPreview({ placeId: place.id, provider: new FakeDeterministicAiProvider(), repository: withCaptor(repository, baseline) })
    const baseAudit = baseline[0]?.audit
    expect(baseAudit).toBeDefined()
    if (baseAudit === undefined) {
      return
    }

    // 같은 장소를 "형제 item의 audit"으로 회피 — 회피가 없었다면 동일 결과였을 것이므로 차이는 회피 효과다.
    const avoidance = buildBatchAvoidance([{ audit: baseAudit, placeName: place.name, region: null, keywords: baseline[0]?.output.keywords ?? [] }])
    const avoided: NewAiGeneration[] = []
    await generateAiPreview({ placeId: place.id, provider: new FakeDeterministicAiProvider(), repository: withCaptor(repository, avoided), batchAvoidance: avoidance })
    const avoidedAudit = avoided[0]?.audit
    expect(avoidedAudit).toBeDefined()
    expect(avoidedAudit?.title_pattern_id).not.toBe(baseAudit.title_pattern_id)
    expect(avoidedAudit?.title_fallback).toBe(true)
    expect(avoidedAudit?.faq_topic_keys).not.toEqual(baseAudit.faq_topic_keys)
    expect(avoidedAudit?.faq_selection).toBe("fallback")
    // 앞선 generation 기록은 변경되지 않는다.
    expect(baseline[0]?.audit).toEqual(baseAudit)
  })
})
