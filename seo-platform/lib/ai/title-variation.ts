// SEO 제목 다양화 v1 — 5~10호점에서 "[장소명] 근조화환 주문 안내" 템플릿 6/6 수렴이 확인되어 도입.
// 장소 ID 해시로 결정적 선택하되, 최근 공개 제목의 패턴·접미사를 반영해 fallback 순환한다.
//
// 패턴은 콘텐츠 모드별 세트로 나뉜다. 회피 비교도 같은 모드 세트 안에서만 이뤄진다.
//
// v2 (변형 풀 확장): 20곳 배치에서 풀(근조 8·축하 4·기업 4)이 소진돼 모드별 16종으로 늘렸다.
// - 기존 패턴은 id·문구·순서를 그대로 두고 새 패턴을 뒤에 덧붙였다. 저장된 audit의 id와
//   기존 게시 제목의 패턴 감지(detectTitlePatternId)가 그대로 동작한다.
// - 모든 패턴은 장소명을 포함한다. 장소명이 없던 3종(celebration-venue-howto,
//   corporate-completion-delivery, corporate-site-info)은 같은 지역 장소끼리 제목이 완전히 같아지는
//   원인이어서 id는 유지하고 문구에 장소명을 넣었다.
import type { ContentMode } from "./content-mode"
import { hashSeed } from "./content-variation"

export type TitlePatternId =
  // condolence — 기존 8종
  | "order-guide" // A. [장소명] 근조화환 주문 안내
  | "pre-send-check" // B. [장소명] 화환 보내기 전 확인 정보
  | "region-checklist" // C. [지역] [장소명] 근조화환 주문 체크사항
  | "order-info" // D. [장소핵심명] 장례식장 화환 주문 정보
  | "directional" // E. [장소명]으로 보내는 근조화환 안내
  | "intake-check" // F. [장소명] 화환 접수 전 확인사항
  | "region-dash" // G. [지역] 장례식장 화환 주문 — [장소명]
  | "binso-guide" // H. [장소명] 빈소 화환 주문 가이드
  // condolence — v2 추가 8종
  | "ribbon-wording" // [장소명] 근조화환 리본 문구 작성법
  | "how-question" // [장소명] 근조화환, 어떻게 보내나요?
  | "when-sending" // [장소명]에 화환 보낼 때 확인할 것
  | "arrival-time" // [장소명] 화환 도착 시간 확인 방법
  | "wreath-first-dash" // 근조화환 주문 전 확인 — [장소명]
  | "region-receipt" // [지역] [장소명] 조문 화환 수령 확인
  | "receiver-name" // [장소명] 화환 받는 분 성함 표기법
  | "unknown-room-order" // [장소명] 빈소 모를 때 화환 주문
  // celebration — 기존 4종
  | "celebration-order-guide" // [지역] [장소명] 축하화환 주문 안내
  | "celebration-event-delivery" // [장소명] 행사·오픈 축하화환 배송
  | "celebration-venue-howto" // [지역] [장소명] 축하화환 보내는 방법
  | "celebration-anniversary-info" // [장소명] 기념행사 화환 주문 정보
  // celebration — v2 추가 12종
  | "celebration-ribbon-wording" // [장소명] 축하화환 리본 문구 작성법
  | "celebration-how-question" // [장소명] 축하화환, 어떻게 보내나요?
  | "celebration-when-sending" // [장소명]에 화환 보낼 때 확인할 것
  | "celebration-event-time" // [장소명] 행사 시간 확인 후 화환 주문
  | "celebration-wreath-first-dash" // 축하화환 주문 전 확인 — [장소명]
  | "celebration-receipt-point" // [장소명] 행사장 화환 수령 위치 확인
  | "celebration-checklist" // [장소명] 축하화환 주문 체크리스트
  | "celebration-sender-name" // [장소명] 화환 보내는 분 이름 표기법
  | "celebration-region-dash" // [지역] 축하화환 주문 — [장소명]
  | "celebration-directional" // [장소명]으로 보내는 축하화환 준비
  | "celebration-pre-event-check" // [장소명] 행사 전 화환 주문 점검 사항
  | "celebration-receiver-guide" // [장소명] 화환 받는 분·행사명 확인 가이드
  // corporate-celebration — 기존 4종
  | "corporate-opening-guide" // [장소명] 개업·이전 축하화환 주문 안내
  | "corporate-completion-delivery" // [지역] [장소명] 준공 축하화환 배송
  | "corporate-founding-howto" // [장소명] 창립·취임 축하화환 보내는 방법
  | "corporate-site-info" // [지역] [장소명] 행사 화환 주문 정보
  // corporate-celebration — v2 추가 12종
  | "corporate-ribbon-label" // [장소명] 축하화환 리본·회사명 표기법
  | "corporate-how-question" // [장소명] 축하화환, 어떻게 보내나요?
  | "corporate-when-sending" // [장소명]에 화환 보낼 때 확인할 것
  | "corporate-ceremony-time" // [장소명] 행사 시간 확인 후 화환 주문
  | "corporate-wreath-first-dash" // 개업·준공 축하화환 주문 전 확인 — [장소명]
  | "corporate-gate-receipt" // [장소명] 정문·경비실 화환 수령 확인
  | "corporate-checklist" // [장소명] 축하화환 주문 체크리스트
  | "corporate-recipient-dept" // [장소명] 화환 받는 부서·담당자 확인법
  | "corporate-region-dash" // [지역] 사업장 축하화환 주문 — [장소명]
  | "corporate-directional" // [장소명]으로 보내는 축하화환 준비
  | "corporate-pre-event-check" // [장소명] 행사 전 화환 주문 점검 사항
  | "corporate-promotion-guide" // [장소명] 승진·취임 축하화환 주문 가이드

export type TitlePattern = {
  readonly id: TitlePatternId
  readonly suffixKey: string
  readonly build: (placeName: string, regionLabel: string) => string
}

export const MAX_TITLE_LENGTH = 40

// 장소명이 이미 '장례식장'으로 끝나므로 D 유형은 핵심명으로 중복을 피한다. 임의 약칭은 만들지 않는다(공식명 절단만).
function placeCoreName(placeName: string): string {
  return placeName.replace(/\s*장례식장$/, "")
}

const RIEUL_JONGSEONG = 8

// 받침 유무에 따른 으로/로 — 받침이 없거나 ㄹ 받침이면 '로'(호텔로·홀로), 그 외 받침은 '으로'.
// 한글 외 문자로 끝나면 안전하게 '으로'.
export function directionalSuffix(word: string): "으로" | "로" {
  const last = word.charCodeAt(word.length - 1)
  if (last < 0xac00 || last > 0xd7a3) {
    return "으로"
  }
  const jongseong = (last - 0xac00) % 28
  return jongseong === 0 || jongseong === RIEUL_JONGSEONG ? "로" : "으로"
}

// 모드별 16종. 기존 패턴(각 세트의 앞쪽)은 순서를 바꾸지 않는다 — 해시 기본 선택이 `hash % 길이`라
// 순서가 바뀌면 기존 장소의 선택이 전부 흔들린다. 새 패턴은 반드시 뒤에 덧붙인다.
// 규칙: ①모든 패턴에 장소명 포함 ②동의어 치환이 아니라 구조(어순·문형·초점)가 서로 다를 것
// ③해당 모드의 금지 어휘(mode-vocabulary)·품질 금지 표현(content-quality)에 걸리지 않을 것.
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
    { id: "ribbon-wording", suffixKey: "작성법", build: (place) => `${place} 근조화환 리본 문구 작성법` },
    { id: "how-question", suffixKey: "질문", build: (place) => `${place} 근조화환, 어떻게 보내나요?` },
    { id: "when-sending", suffixKey: "확인할 것", build: (place) => `${place}에 화환 보낼 때 확인할 것` },
    { id: "arrival-time", suffixKey: "방법", build: (place) => `${place} 화환 도착 시간 확인 방법` },
    { id: "wreath-first-dash", suffixKey: "장소명", build: (place) => `근조화환 주문 전 확인 — ${place}` },
    { id: "region-receipt", suffixKey: "확인", build: (place, region) => `${region} ${place} 조문 화환 수령 확인` },
    { id: "receiver-name", suffixKey: "표기법", build: (place) => `${place} 화환 받는 분 성함 표기법` },
    { id: "unknown-room-order", suffixKey: "주문", build: (place) => `${place} 빈소 모를 때 화환 주문` },
  ],
  celebration: [
    { id: "celebration-order-guide", suffixKey: "안내", build: (place, region) => `${region} ${place} 축하화환 주문 안내` },
    { id: "celebration-event-delivery", suffixKey: "배송", build: (place) => `${place} 행사·오픈 축하화환 배송` },
    { id: "celebration-venue-howto", suffixKey: "방법", build: (place, region) => `${region} ${place} 축하화환 보내는 방법` },
    { id: "celebration-anniversary-info", suffixKey: "정보", build: (place) => `${place} 기념행사 화환 주문 정보` },
    { id: "celebration-ribbon-wording", suffixKey: "작성법", build: (place) => `${place} 축하화환 리본 문구 작성법` },
    { id: "celebration-how-question", suffixKey: "질문", build: (place) => `${place} 축하화환, 어떻게 보내나요?` },
    { id: "celebration-when-sending", suffixKey: "확인할 것", build: (place) => `${place}에 화환 보낼 때 확인할 것` },
    { id: "celebration-event-time", suffixKey: "주문", build: (place) => `${place} 행사 시간 확인 후 화환 주문` },
    { id: "celebration-wreath-first-dash", suffixKey: "장소명", build: (place) => `축하화환 주문 전 확인 — ${place}` },
    { id: "celebration-receipt-point", suffixKey: "확인", build: (place) => `${place} 행사장 화환 수령 위치 확인` },
    { id: "celebration-checklist", suffixKey: "체크리스트", build: (place) => `${place} 축하화환 주문 체크리스트` },
    { id: "celebration-sender-name", suffixKey: "표기법", build: (place) => `${place} 화환 보내는 분 이름 표기법` },
    { id: "celebration-region-dash", suffixKey: "장소명", build: (place, region) => `${region} 축하화환 주문 — ${place}` },
    { id: "celebration-directional", suffixKey: "준비", build: (place) => `${place}${directionalSuffix(place)} 보내는 축하화환 준비` },
    { id: "celebration-pre-event-check", suffixKey: "점검 사항", build: (place) => `${place} 행사 전 화환 주문 점검 사항` },
    { id: "celebration-receiver-guide", suffixKey: "가이드", build: (place) => `${place} 화환 받는 분·행사명 확인 가이드` },
  ],
  "corporate-celebration": [
    { id: "corporate-opening-guide", suffixKey: "안내", build: (place) => `${place} 개업·이전 축하화환 주문 안내` },
    { id: "corporate-completion-delivery", suffixKey: "배송", build: (place, region) => `${region} ${place} 준공 축하화환 배송` },
    { id: "corporate-founding-howto", suffixKey: "방법", build: (place) => `${place} 창립·취임 축하화환 보내는 방법` },
    { id: "corporate-site-info", suffixKey: "정보", build: (place, region) => `${region} ${place} 행사 화환 주문 정보` },
    { id: "corporate-ribbon-label", suffixKey: "표기법", build: (place) => `${place} 축하화환 리본·회사명 표기법` },
    { id: "corporate-how-question", suffixKey: "질문", build: (place) => `${place} 축하화환, 어떻게 보내나요?` },
    { id: "corporate-when-sending", suffixKey: "확인할 것", build: (place) => `${place}에 화환 보낼 때 확인할 것` },
    { id: "corporate-ceremony-time", suffixKey: "주문", build: (place) => `${place} 행사 시간 확인 후 화환 주문` },
    { id: "corporate-wreath-first-dash", suffixKey: "장소명", build: (place) => `개업·준공 축하화환 주문 전 확인 — ${place}` },
    { id: "corporate-gate-receipt", suffixKey: "확인", build: (place) => `${place} 정문·경비실 화환 수령 확인` },
    { id: "corporate-checklist", suffixKey: "체크리스트", build: (place) => `${place} 축하화환 주문 체크리스트` },
    { id: "corporate-recipient-dept", suffixKey: "확인법", build: (place) => `${place} 화환 받는 부서·담당자 확인법` },
    { id: "corporate-region-dash", suffixKey: "장소명", build: (place, region) => `${region} 사업장 축하화환 주문 — ${place}` },
    { id: "corporate-directional", suffixKey: "준비", build: (place) => `${place}${directionalSuffix(place)} 보내는 축하화환 준비` },
    { id: "corporate-pre-event-check", suffixKey: "점검 사항", build: (place) => `${place} 행사 전 화환 주문 점검 사항` },
    { id: "corporate-promotion-guide", suffixKey: "가이드", build: (place) => `${place} 승진·취임 축하화환 주문 가이드` },
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

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b)
}

const DEFAULT_TRAVERSAL_STRIDE = 3

// 순환 보폭 — 풀 크기와 서로소여야 전 패턴을 한 번씩 방문한다.
// 예전 코드는 보폭 3 고정이라 풀 크기가 3의 배수(6·9·12·15…)가 되면 1/3만 돌고 나머지는
// 영영 후보가 되지 못했다 (8·16에서는 우연히 서로소). 3이 서로소가 아니면 다음 서로소 값을 쓴다.
export function titleTraversalStride(poolSize: number): number {
  for (let stride = DEFAULT_TRAVERSAL_STRIDE; stride < poolSize; stride += 1) {
    if (greatestCommonDivisor(stride, poolSize) === 1) {
      return stride
    }
  }
  return 1
}

// base에서 시작해 풀 전체를 정확히 한 번씩 방문하는 인덱스 순서.
export function titleTraversalOrder(base: number, poolSize: number): readonly number[] {
  const stride = titleTraversalStride(poolSize)
  return Array.from({ length: poolSize }, (_, step) => (base + step * stride) % poolSize)
}

const RECENT_PATTERN_WINDOW = 5

// 해시 기본 선택 → 제약 위반 시 결정적 순환(fallback).
// 강한 제약: ①최근 5건과 동일 패턴 금지 ②동일 접미사 3연속 금지 ③40자 초과 금지.
// 약한 선호: 강한 제약을 통과한 후보 중 회피 컨텍스트 전체(같은 배치의 앞선 item 포함)에서
// 아직 쓰이지 않은 패턴을 먼저 고른다. 전부 쓰였다면 가장 오래전에 쓰인 패턴을 고른다.
// 컨텍스트가 5건 이하면 약한 선호는 강한 제약과 같아져 결과가 예전 규칙과 동일하다.
export function pickTitlePattern(seed: string, placeName: string, regionLabel: string, recent: RecentTitleContext, mode: ContentMode): TitlePick {
  const patterns = titlePatternsFor(mode)
  const base = hashSeed(`${seed}:title`) % patterns.length
  const recentPatterns = recent.patternIds.slice(0, RECENT_PATTERN_WINDOW)
  const lastTwoSuffixes = recent.suffixKeys.slice(0, 2)

  let fallback: TitlePick | null = null
  let leastRecent: { readonly pick: TitlePick; readonly usedAt: number } | null = null
  for (const [step, index] of titleTraversalOrder(base, patterns.length).entries()) {
    const pattern = patterns[index]
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
    const usedAt = recent.patternIds.indexOf(pattern.id)
    if (usedAt === -1) {
      // 컨텍스트 어디에도 없는 패턴 — 순회 순서상 첫 번째를 바로 채택한다.
      return pick
    }
    // 최신순 배열이므로 인덱스가 클수록 오래전에 쓰인 패턴이다.
    if (leastRecent === null || usedAt > leastRecent.usedAt) {
      leastRecent = { pick, usedAt }
    }
  }
  if (leastRecent !== null) {
    return leastRecent.pick
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
  // 문구가 바뀌기 전에 게시된 제목 — 같은 패턴 id로 복원해 회피·품질 검사에서 빠지지 않게 한다.
  for (const legacy of LEGACY_TITLE_BUILDS[mode]) {
    for (const label of labels) {
      if (legacy.build(placeName, label) === title) {
        return legacy.id
      }
    }
  }
  return null
}

// 감지 전용 — 생성에는 쓰지 않는다. 풀 확장(2026-11) 전의 문구를 원래 패턴 id에 매핑한다.
//  - 장소명 없이 지역만 쓰던 3종 (같은 지역의 다른 장소가 같은 제목으로 수렴해 문구를 바꿨다)
//  - ㄹ 받침 뒤 조사를 "으로"로 붙이던 directional (호텔으로 → 호텔로)
const LEGACY_TITLE_BUILDS: Readonly<Record<ContentMode, readonly { readonly id: TitlePatternId; readonly build: (place: string, region: string) => string }[]>> = {
  condolence: [{ id: "directional", build: (place) => `${place}${legacyDirectionalSuffix(place)} 보내는 근조화환 안내` }],
  celebration: [{ id: "celebration-venue-howto", build: (_place, region) => `${region} 호텔·행사장 축하화환 보내는 방법` }],
  "corporate-celebration": [
    { id: "corporate-completion-delivery", build: (_place, region) => `${region} 기업·공장 준공 축하화환 배송` },
    { id: "corporate-site-info", build: (_place, region) => `${region} 사업장 행사 화환 주문 정보` },
  ],
}

// 수정 전 규칙: 받침이 있으면 무조건 "으로".
function legacyDirectionalSuffix(place: string): string {
  const code = place.charCodeAt(place.length - 1)
  if (code < 0xac00 || code > 0xd7a3) {
    return "으로"
  }
  return (code - 0xac00) % 28 === 0 ? "로" : "으로"
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
