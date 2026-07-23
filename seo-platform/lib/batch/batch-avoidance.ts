// 같은 Batch 내 다양성 회피 (PR-S3) — 앞선 item의 generation output.audit를 후속 생성의 회피 입력으로 되돌린다.
// 순수 로직만 담는다 (DB 접근 없음). 결정성: 입력(앞선 item들의 audit·키워드)이 같으면 결과도 같다.
import type { FaqPairKeys } from "@/lib/ai/faq-variation"
import { faqTopicByKey } from "@/lib/ai/faq-variation"
import { titlePatternIdOf, type TitlePatternId } from "@/lib/ai/title-variation"
import type { GenerationVariationAudit } from "@/lib/ai/types"
import type { BatchItemStatus } from "@/types/database"

export type BatchAvoidanceContext = {
  readonly titlePatterns: readonly { readonly patternId: TitlePatternId | null; readonly suffixKey: string | null }[]
  readonly faqPairs: readonly FaqPairKeys[]
  readonly keywordSets: readonly { readonly placeName: string; readonly region: string | null; readonly keywords: readonly string[] }[]
}

export const EMPTY_BATCH_AVOIDANCE: BatchAvoidanceContext = { titlePatterns: [], faqPairs: [], keywordSets: [] }

// 회피 기준 포함 정책: 콘텐츠가 확정 산출된 종료 상태만 포함한다.
// - ready/warn_ready: apply된 콘텐츠 — 게시 예정이므로 반드시 회피
// - needs_review: preview가 보존되어 검토 후 적용될 수 있으므로 포함 (회피해도 손해가 없다)
// - failed/skipped: 유효 콘텐츠 없음 — 제외 · processing/queued/interrupted: 미확정 — 제외
//   (순차 처리 특성상 후속 item 생성 시점에 앞선 item은 전부 종료 상태라 재개 시에도 결정적이다)
const AVOIDANCE_SOURCE_STATUSES: readonly BatchItemStatus[] = ["ready", "warn_ready", "needs_review"]

export function isAvoidanceSourceItem(item: Readonly<{ sequence: number; status: BatchItemStatus; generationId: string | null }>, currentSequence: number): boolean {
  return item.sequence < currentSequence && AVOIDANCE_SOURCE_STATUSES.includes(item.status) && item.generationId !== null
}

export type BatchAvoidanceSource = {
  // audit 없는 generation(구 레코드·파싱 실패)은 null — 안전하게 무시된다.
  readonly audit: GenerationVariationAudit | null
  readonly placeName: string
  readonly region: string | null
  readonly keywords: readonly string[]
}

// sequence 오름차순 입력을 최신 우선(내림차순) 회피 창으로 뒤집는다 — 직전 item이 가장 강한 회피 대상.
export function buildBatchAvoidance(sources: readonly BatchAvoidanceSource[]): BatchAvoidanceContext {
  const titlePatterns: { patternId: TitlePatternId | null; suffixKey: string | null }[] = []
  const faqPairs: FaqPairKeys[] = []
  const keywordSets: { placeName: string; region: string | null; keywords: readonly string[] }[] = []

  for (const source of [...sources].reverse()) {
    if (source.audit !== null) {
      titlePatterns.push({ patternId: titlePatternIdOf(source.audit.title_pattern_id), suffixKey: source.audit.title_suffix_key })
      const pair = toFaqPair(source.audit.faq_topic_keys)
      if (pair !== null) {
        faqPairs.push(pair)
      }
    }
    if (source.keywords.length > 0) {
      keywordSets.push({ placeName: source.placeName, region: source.region, keywords: source.keywords })
    }
  }
  return { titlePatterns, faqPairs, keywordSets }
}

function toFaqPair(keys: readonly string[]): FaqPairKeys | null {
  const [first, second] = keys
  if (first === undefined || second === undefined || first === second) {
    return null
  }
  if (faqTopicByKey(first) === null || faqTopicByKey(second) === null) {
    return null
  }
  return [first, second] as unknown as FaqPairKeys
}
