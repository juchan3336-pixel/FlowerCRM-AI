// 키워드 다양화 v1 — 역할별 5슬롯 구성으로 "근조화환 주문/장례식장 화환/화환 주문 안내" 고정 세트 수렴을 차단한다.
// 장소 ID 해시로 결정적 선택하고, 최근 공개 세트와 4/5 이상(마스킹 기준) 겹치면 결정적으로 재구성한다.
import { maskPlaceTokens } from "./content-quality"
import { hashSeed, type FaqTopicKey } from "./content-variation"

export type KeywordRole = "official-name" | "region-wreath" | "place-flower" | "faq-intent" | "delivery"

export type KeywordPlan = {
  readonly keywords: readonly string[]
  readonly roles: readonly KeywordRole[]
  readonly rebuilt: boolean
}

// 실서비스 범위를 벗어나거나 금지된 표현 — 슬롯 후보에 절대 포함하지 않고 최종 가드로도 거른다.
const BANNED_KEYWORD_PATTERNS = [/조문\s*서비스/, /장례\s*시설/, /장례\s*서비스/, /공식/, /제휴/, /후기/]

// 5~10호점에서 수렴이 확인된 고정 3종 — 세 개가 동시에 포함되는 세트는 만들지 않는다.
export const STOCK_KEYWORD_TRIO = ["근조화환 주문", "장례식장 화환", "화환 주문 안내"] as const

const PROVINCES = new Set(["경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주"])

// 검색어용 축약 지역: 도 소속이면 시·군 접미사를 뗀 시군명(김해시→김해), 광역시면 광역시명(대구).
export function keywordRegionLabel(city: string | null, district: string | null): string {
  if (city !== null && PROVINCES.has(city) && district !== null) {
    return district.replace(/(시|군)$/, "")
  }
  if (city !== null && !PROVINCES.has(city)) {
    return city
  }
  return district ?? city ?? ""
}

const FAQ_INTENT_CANDIDATES: Record<FaqTopicKey, readonly string[]> = {
  "pre-order-check": ["화환 주문 확인사항", "화환 보내기 전 확인"],
  "unknown-room": ["빈소명 확인", "빈소 확인 방법"],
  "address-lookup": ["장례식장 주소 확인"],
  "branch-lookup": ["장례식장 위치 확인"],
  "recipient-input": ["화환 받는 분 정보"],
  "delivery-availability": ["근조화환 배송 확인"],
}

function deliveryCandidates(region: string): readonly string[] {
  return [`${region} 장례식장 꽃배달`, "근조화환 배송", `${region} 꽃배달`]
}

export type KeywordPlanInput = {
  readonly seed: string
  readonly placeName: string
  readonly city: string | null
  readonly district: string | null
  readonly faqTopicKeys: readonly FaqTopicKey[]
  // 최근 공개 페이지 키워드 세트 (중복 회피 비교용) — {placeName, region, keywords}
  readonly recentSets: readonly { readonly placeName: string; readonly region: string | null; readonly keywords: readonly string[] }[]
}

export function buildKeywordPlan(input: KeywordPlanInput): KeywordPlan {
  const region = keywordRegionLabel(input.city, input.district)
  const core = input.placeName.replace(/\s*장례식장$/, "")
  const hash = hashSeed(`${input.seed}:keywords`)

  const faqKey = input.faqTopicKeys[hash % Math.max(input.faqTopicKeys.length, 1)] ?? "pre-order-check"
  const faqCandidates = FAQ_INTENT_CANDIDATES[faqKey]
  const delivery = deliveryCandidates(region)

  const compose = (faqShift: number, deliveryShift: number): readonly string[] => {
    const slot4 = faqCandidates[(Math.floor(hash / 13) + faqShift) % faqCandidates.length] ?? "화환 주문 확인사항"
    const slot5 = delivery[(Math.floor(hash / 7) + deliveryShift) % delivery.length] ?? "근조화환 배송"
    return dedupeKeywords([input.placeName, `${region} 근조화환`, `${core} 화환`, slot4, slot5])
  }

  // 마스킹 기준 4/5 이상 겹치면 slot5→slot4 순으로 결정적 재구성한다.
  const maskMine = (keyword: string) => maskPlaceTokens(keyword, input.placeName, [input.city, input.district])
  const overlapsRecent = (keywords: readonly string[]): boolean => {
    const mine = keywords.map(maskMine)
    return input.recentSets.some((recent) => {
      const theirs = new Set(recent.keywords.map((keyword) => maskPlaceTokens(keyword, recent.placeName, [recent.region])))
      return mine.filter((keyword) => theirs.has(keyword)).length >= 4
    })
  }

  let rebuilt = false
  let keywords = compose(0, 0)
  outer: for (let deliveryShift = 0; deliveryShift < delivery.length; deliveryShift += 1) {
    for (let faqShift = 0; faqShift < faqCandidates.length; faqShift += 1) {
      const candidate = compose(faqShift, deliveryShift)
      if (!overlapsRecent(candidate) && candidate.length === 5) {
        keywords = candidate
        rebuilt = faqShift !== 0 || deliveryShift !== 0
        break outer
      }
    }
  }

  const banned = keywords.filter((keyword) => BANNED_KEYWORD_PATTERNS.some((pattern) => pattern.test(keyword)))
  if (banned.length > 0) {
    throw new Error(`banned keyword produced: ${banned.join(", ")}`)
  }
  const stockHits = keywords.filter((keyword) => (STOCK_KEYWORD_TRIO as readonly string[]).includes(keyword))
  if (stockHits.length >= 3) {
    throw new Error("stock keyword trio produced")
  }

  return { keywords, roles: ["official-name", "region-wreath", "place-flower", "faq-intent", "delivery"], rebuilt }
}

function dedupeKeywords(keywords: readonly string[]): readonly string[] {
  return [...new Set(keywords.map((keyword) => keyword.trim()).filter((keyword) => keyword.length > 0))]
}

// 동일 3개 공통 키워드(마스킹 기준)가 최근 3회 연속 반복되는지 — 경고용 유틸.
export function hasCommonTrioStreak(recentSets: readonly { readonly placeName: string; readonly region: string | null; readonly keywords: readonly string[] }[], streak = 3): boolean {
  if (recentSets.length < streak) {
    return false
  }
  const masked = recentSets.slice(0, streak).map((set) => new Set(set.keywords.map((keyword) => maskPlaceTokens(keyword, set.placeName, [set.region]))))
  const [first, ...rest] = masked
  if (first === undefined) {
    return false
  }
  const common = [...first].filter((keyword) => rest.every((set) => set.has(keyword)))
  return common.length >= 3
}
