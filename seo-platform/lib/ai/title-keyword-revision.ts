// 제목·키워드 보정 helper — 기존 generation 원문(본문·FAQ)을 유지한 채 새 다양화 규칙으로
// 제목·키워드 후보를 결정한다. 신규 생성(prompt 주입)과 기존 레코드 보정이 같은 규칙을 쓴다.
import type { RecentContentSnapshot } from "./content-quality"
import { pickContentVariation, type FaqTopicKey } from "./content-variation"
import { buildKeywordPlan, type KeywordRole } from "./keyword-variation"
import { detectTitlePatternId, pickTitlePattern, titleRegionLabel, titleSuffixKeyOf, type TitlePatternId } from "./title-variation"

export type TitleKeywordRevision = {
  readonly title: string
  readonly titlePatternId: TitlePatternId
  readonly titleSuffixKey: string
  readonly keywords: readonly string[]
  readonly keywordRoles: readonly KeywordRole[]
  readonly keywordsRebuilt: boolean
}

export type TitleKeywordRevisionInput = {
  readonly placeId: string
  readonly placeName: string
  readonly city: string | null
  readonly district: string | null
  // 최근 공개 페이지 (최신순) — 제목 패턴·키워드 중복 회피 기준
  readonly recentPages: readonly RecentContentSnapshot[]
  // 같은 배치에서 앞서 확정된 제목들 (예: 8→9→10 순차 보정 시 서로 다른 구조 보장)
  readonly pendingTitles?: readonly { readonly title: string; readonly placeName: string; readonly region: string | null }[]
  // FAQ 다양화 v1이 확정한 topic pair — 제공되면 faq-intent 키워드가 이 pair와 연동된다 (미제공 시 기존 해시 선택).
  readonly faqTopicKeys?: readonly FaqTopicKey[]
}

export function buildTitleKeywordRevision(input: TitleKeywordRevisionInput): TitleKeywordRevision {
  const seed = `${input.placeId}:${input.placeName}`
  const regionLabel = titleRegionLabel(input.city, input.district)

  const recentTitleSources = [
    ...(input.pendingTitles ?? []),
    ...input.recentPages.map((page) => ({ title: page.title ?? "", placeName: page.placeName, region: page.region })),
  ]
  const recentContext = {
    patternIds: recentTitleSources.map((source) => detectTitlePatternId(source.title, source.placeName, [source.region])),
    suffixKeys: recentTitleSources.map((source) => titleSuffixKeyOf(source.title, source.placeName, [source.region])),
  }
  const titlePick = pickTitlePattern(seed, input.placeName, regionLabel, recentContext)

  const faqTopicKeys = input.faqTopicKeys ?? pickContentVariation(seed).faqTopics.map((topic) => topic.key)
  const keywordPlan = buildKeywordPlan({
    seed,
    placeName: input.placeName,
    city: input.city,
    district: input.district,
    faqTopicKeys,
    recentSets: input.recentPages.map((page) => ({ placeName: page.placeName, region: page.region, keywords: page.keywords })),
  })

  return {
    title: titlePick.title,
    titlePatternId: titlePick.patternId,
    titleSuffixKey: titlePick.suffixKey,
    keywords: keywordPlan.keywords,
    keywordRoles: keywordPlan.roles,
    keywordsRebuilt: keywordPlan.rebuilt,
  }
}
