// SEO 제목 다양화 v1 — 5~10호점에서 "[장소명] 근조화환 주문 안내" 템플릿 6/6 수렴이 확인되어 도입.
// 장소 ID 해시로 결정적 선택하되, 최근 공개 제목의 패턴·접미사를 반영해 fallback 순환한다.
//
// 패턴은 콘텐츠 모드별 세트로 나뉜다. condolence 8종은 도입 당시 순서·문구 그대로라
// 기존 장례식장 장소의 제목이 바뀌지 않는다. 회피 비교도 같은 모드 세트 안에서만 이뤄진다.
import type { ContentMode } from "./content-mode"
import { hashSeed } from "./content-variation"

export type TitlePatternId =
  // condolence
  | "order-guide" // A. [장소명] 근조화환 주문 안내
  | "pre-send-check" // B. [장소명] 화환 보내기 전 확인 정보
  | "region-checklist" // C. [지역] [장소명] 근조화환 주문 체크사항
  | "order-info" // D. [장소핵심명] 장례식장 화환 주문 정보
  | "directional" // E. [장소명]으로 보내는 근조화환 안내
  | "intake-check" // F. [장소명] 화환 접수 전 확인사항
  | "region-dash" // G. [지역] 장례식장 화환 주문 — [장소명]
  | "binso-guide" // H. [장소명] 빈소 화환 주문 가이드
  // celebration
  | "celebration-order-guide" // [지역] [장소명] 축하화환 주문 안내
  | "celebration-event-delivery" // [장소명] 행사·오픈 축하화환 배송
  | "celebration-venue-howto" // [지역] 호텔·행사장 축하화환 보내는 방법
  | "celebration-anniversary-info" // [장소명] 기념행사 화환 주문 정보
  // corporate-celebration
  | "corporate-opening-guide" // [장소명] 개업·이전 축하화환 주문 안내
  | "corporate-completion-delivery" // [지역] 기업·공장 준공 축하화환 배송
  | "corporate-founding-howto" // [장소명] 창립·취임 축하화환 보내는 방법
  | "corporate-site-info" // [지역] 사업장 행사 화환 주문 정보

export type TitlePattern = {
  readonly id: TitlePatternId
  readonly suffixKey: string
  readonly build: (placeName: string, regionLabel: string) => string
}

const MAX_TITLE_LENGTH = 40

// 장소명이 이미 '장례식장'으로 끝나므로 D 유형은 핵심명으로 중복을 피한다. 임의 약칭은 만들지 않는다(공식명 절단만).
function placeCoreName(placeName: string): string {
  return placeName.replace(/\s*장례식장$/, "")
}

// 받침 유무에 따른 으로/로 — 한글 외 문자로 끝나면 안전하게 '으로'.
export function directionalSuffix(word: string): "으로" | "로" {
  const last = word.charCodeAt(word.length - 1)
  if (last < 0xac00 || last > 0xd7a3) {
    return "으로"
  }
  return (last - 0xac00) % 28 === 0 ? "로" : "으로"
}

export const TITLE_PATTERN_SETS: Readonly<Record<ContentMode, readonly TitlePattern[]>> = {
  condolence: [
    { id: "order-guide", suffixKey: "안내", build: (place) => `${place} 근조화환 주문 안내` },
    { id: "pre-send-check", suffixKey: "정보", build: (place) => `${place} 화환 보내기 전 확인 정보` },
    { id: "region-checklist", suffixKey: "체크사항", build: (place, region) => `${region} ${place} 근조화환 주문 체크사항` },
    { id: "order-info", suffixKey: "정보", build: (place) => `${placeCoreName(place)} 장례식장 화환 주문 정보` },
    { id: "directional", suffixKey: "안내", build: (place) => `${place}${directionalSuffix(place)} 보내는 근조화환 안내` },
    { id: "intake-check", suffixKey: "확인사항", build: (place) => `${place} 화환 접수 전 확인사항` },
    { id: "region-dash", suffixKey: "장소명", build: (place, region) => `${region} 장례식장 화환 주문 — ${place}` },
    { id: "binso-guide", suffixKey: "가이드", build: (place) => `${place} 빈소 화환 주문 가이드` },
  ],
  celebration: [
    { id: "celebration-order-guide", suffixKey: "안내", build: (place, region) => `${region} ${place} 축하화환 주문 안내` },
    { id: "celebration-event-delivery", suffixKey: "배송", build: (place) => `${place} 행사·오픈 축하화환 배송` },
    { id: "celebration-venue-howto", suffixKey: "방법", build: (_place, region) => `${region} 호텔·행사장 축하화환 보내는 방법` },
    { id: "celebration-anniversary-info", suffixKey: "정보", build: (place) => `${place} 기념행사 화환 주문 정보` },
  ],
  "corporate-celebration": [
    { id: "corporate-opening-guide", suffixKey: "안내", build: (place) => `${place} 개업·이전 축하화환 주문 안내` },
    { id: "corporate-completion-delivery", suffixKey: "배송", build: (_place, region) => `${region} 기업·공장 준공 축하화환 배송` },
    { id: "corporate-founding-howto", suffixKey: "방법", build: (place) => `${place} 창립·취임 축하화환 보내는 방법` },
    { id: "corporate-site-info", suffixKey: "정보", build: (_place, region) => `${region} 사업장 행사 화환 주문 정보` },
  ],
}

export function titlePatternsFor(mode: ContentMode): readonly TitlePattern[] {
  return TITLE_PATTERN_SETS[mode]
}

const METRO_CITIES = new Set(["서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종"])

// 표시용 지역 라벨: 광역시는 "대구 남구"처럼 시+구, 도는 시·군명만 (예: "김해시").
export function titleRegionLabel(city: string | null, district: string | null): string {
  if (district === null || district.length === 0) {
    return city ?? ""
  }
  if (city !== null && METRO_CITIES.has(city)) {
    return `${city} ${district}`
  }
  return district
}

export type TitlePick = {
  readonly patternId: TitlePatternId
  readonly title: string
  readonly suffixKey: string
  // 감사용 — 해시 기본 선택(step 0)이 아니라 제약 회피 순환·최소 대안으로 선택됐는지 (선택 로직 자체는 불변)
  readonly fallbackApplied: boolean
}

export type RecentTitleContext = {
  readonly patternIds: readonly (TitlePatternId | null)[]
  readonly suffixKeys: readonly (string | null)[]
}

// 해시 기본 선택 → 제약 위반 시 결정적 순환(fallback): ①최근 5건과 동일 패턴 금지 ②동일 접미사 3연속 금지 ③40자 초과 금지.
export function pickTitlePattern(seed: string, placeName: string, regionLabel: string, recent: RecentTitleContext, mode: ContentMode): TitlePick {
  const patterns = titlePatternsFor(mode)
  const base = hashSeed(`${seed}:title`) % patterns.length
  const recentPatterns = recent.patternIds.slice(0, 5)
  const lastTwoSuffixes = recent.suffixKeys.slice(0, 2)

  let fallback: TitlePick | null = null
  for (let step = 0; step < patterns.length; step += 1) {
    const pattern = patterns[(base + step * 3) % patterns.length]
    if (pattern === undefined) {
      continue
    }
    const title = pattern.build(placeName, regionLabel)
    const pick: TitlePick = { patternId: pattern.id, title, suffixKey: pattern.suffixKey, fallbackApplied: step > 0 }
    if (title.length > MAX_TITLE_LENGTH) {
      continue
    }
    fallback ??= pick
    if (recentPatterns.includes(pattern.id)) {
      continue
    }
    if (lastTwoSuffixes.length === 2 && lastTwoSuffixes.every((suffix) => suffix === pattern.suffixKey)) {
      continue
    }
    return pick
  }
  if (fallback !== null) {
    return { ...fallback, fallbackApplied: true }
  }
  // 전 패턴이 40자 초과인 극단 케이스 — 가장 짧은 패턴으로라도 반환한다.
  const shortest = [...patterns].sort((a, b) => a.build(placeName, regionLabel).length - b.build(placeName, regionLabel).length)[0] ?? patterns[0]
  if (shortest === undefined) {
    throw new Error("no title patterns defined")
  }
  return { patternId: shortest.id, title: shortest.build(placeName, regionLabel), suffixKey: shortest.suffixKey, fallbackApplied: true }
}

// 문자열이 유효한 패턴 id인지 검증한다 — audit 등 저장된 값을 회피 컨텍스트로 되돌릴 때 사용 (미상 값은 null).
// 저장된 audit에는 모드가 없으므로 전 세트를 대상으로 본다 (id는 세트 간 고유하다).
export function titlePatternIdOf(value: string | null): TitlePatternId | null {
  if (value === null) {
    return null
  }
  return Object.values(TITLE_PATTERN_SETS).some((patterns) => patterns.some((pattern) => pattern.id === value)) ? (value as TitlePatternId) : null
}

// 기존 제목이 어떤 패턴인지 추정 — 장소명·지역 라벨 후보를 대입해 정확 일치하는 패턴을 찾는다 (구 데이터 호환).
// 같은 모드 세트 안에서만 대조한다 — 모드가 다른 페이지끼리 "같은 제목 유형"으로 묶이지 않게.
export function detectTitlePatternId(title: string | null, placeName: string, regionLabels: readonly (string | null)[], mode: ContentMode): TitlePatternId | null {
  if (title === null || title.length === 0) {
    return null
  }
  const labels = [...new Set([...regionLabels.filter((label): label is string => label !== null && label.length > 0), ""])]
  for (const pattern of titlePatternsFor(mode)) {
    for (const label of labels) {
      if (pattern.build(placeName, label) === title) {
        return pattern.id
      }
    }
  }
  return null
}

export function titleSuffixKeyOf(title: string | null, placeName: string, regionLabels: readonly (string | null)[], mode: ContentMode): string | null {
  const patternId = detectTitlePatternId(title, placeName, regionLabels, mode)
  if (patternId !== null) {
    return titlePatternsFor(mode).find((pattern) => pattern.id === patternId)?.suffixKey ?? null
  }
  if (title === null) {
    return null
  }
  const lastWord = title.trim().split(/\s+/).at(-1)
  return lastWord ?? null
}
