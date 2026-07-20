// SEO 제목 다양화 v1 — 5~10호점에서 "[장소명] 근조화환 주문 안내" 템플릿 6/6 수렴이 확인되어 도입.
// 장소 ID 해시로 결정적 선택하되, 최근 공개 제목의 패턴·접미사를 반영해 fallback 순환한다.
import { hashSeed } from "./content-variation"

export type TitlePatternId =
  | "order-guide" // A. [장소명] 근조화환 주문 안내
  | "pre-send-check" // B. [장소명] 화환 보내기 전 확인 정보
  | "region-checklist" // C. [지역] [장소명] 근조화환 주문 체크사항
  | "order-info" // D. [장소핵심명] 장례식장 화환 주문 정보
  | "directional" // E. [장소명]으로 보내는 근조화환 안내
  | "intake-check" // F. [장소명] 화환 접수 전 확인사항
  | "region-dash" // G. [지역] 장례식장 화환 주문 — [장소명]
  | "binso-guide" // H. [장소명] 빈소 화환 주문 가이드

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

export const TITLE_PATTERNS: readonly TitlePattern[] = [
  { id: "order-guide", suffixKey: "안내", build: (place) => `${place} 근조화환 주문 안내` },
  { id: "pre-send-check", suffixKey: "정보", build: (place) => `${place} 화환 보내기 전 확인 정보` },
  { id: "region-checklist", suffixKey: "체크사항", build: (place, region) => `${region} ${place} 근조화환 주문 체크사항` },
  { id: "order-info", suffixKey: "정보", build: (place) => `${placeCoreName(place)} 장례식장 화환 주문 정보` },
  { id: "directional", suffixKey: "안내", build: (place) => `${place}${directionalSuffix(place)} 보내는 근조화환 안내` },
  { id: "intake-check", suffixKey: "확인사항", build: (place) => `${place} 화환 접수 전 확인사항` },
  { id: "region-dash", suffixKey: "장소명", build: (place, region) => `${region} 장례식장 화환 주문 — ${place}` },
  { id: "binso-guide", suffixKey: "가이드", build: (place) => `${place} 빈소 화환 주문 가이드` },
]

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
}

export type RecentTitleContext = {
  readonly patternIds: readonly (TitlePatternId | null)[]
  readonly suffixKeys: readonly (string | null)[]
}

// 해시 기본 선택 → 제약 위반 시 결정적 순환(fallback): ①최근 5건과 동일 패턴 금지 ②동일 접미사 3연속 금지 ③40자 초과 금지.
export function pickTitlePattern(seed: string, placeName: string, regionLabel: string, recent: RecentTitleContext): TitlePick {
  const base = hashSeed(`${seed}:title`) % TITLE_PATTERNS.length
  const recentPatterns = recent.patternIds.slice(0, 5)
  const lastTwoSuffixes = recent.suffixKeys.slice(0, 2)

  let fallback: TitlePick | null = null
  for (let step = 0; step < TITLE_PATTERNS.length; step += 1) {
    const pattern = TITLE_PATTERNS[(base + step * 3) % TITLE_PATTERNS.length]
    if (pattern === undefined) {
      continue
    }
    const title = pattern.build(placeName, regionLabel)
    const pick: TitlePick = { patternId: pattern.id, title, suffixKey: pattern.suffixKey }
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
    return fallback
  }
  // 전 패턴이 40자 초과인 극단 케이스 — 가장 짧은 패턴으로라도 반환한다.
  const shortest = [...TITLE_PATTERNS].sort((a, b) => a.build(placeName, regionLabel).length - b.build(placeName, regionLabel).length)[0] ?? TITLE_PATTERNS[0]
  if (shortest === undefined) {
    throw new Error("no title patterns defined")
  }
  return { patternId: shortest.id, title: shortest.build(placeName, regionLabel), suffixKey: shortest.suffixKey }
}

// 기존 제목이 어떤 패턴인지 추정 — 장소명·지역 라벨 후보를 대입해 정확 일치하는 패턴을 찾는다 (구 데이터 호환).
export function detectTitlePatternId(title: string | null, placeName: string, regionLabels: readonly (string | null)[]): TitlePatternId | null {
  if (title === null || title.length === 0) {
    return null
  }
  const labels = [...new Set([...regionLabels.filter((label): label is string => label !== null && label.length > 0), ""])]
  for (const pattern of TITLE_PATTERNS) {
    for (const label of labels) {
      if (pattern.build(placeName, label) === title) {
        return pattern.id
      }
    }
  }
  return null
}

export function titleSuffixKeyOf(title: string | null, placeName: string, regionLabels: readonly (string | null)[]): string | null {
  const patternId = detectTitlePatternId(title, placeName, regionLabels)
  if (patternId !== null) {
    return TITLE_PATTERNS.find((pattern) => pattern.id === patternId)?.suffixKey ?? null
  }
  if (title === null) {
    return null
  }
  const lastWord = title.trim().split(/\s+/).at(-1)
  return lastWord ?? null
}
