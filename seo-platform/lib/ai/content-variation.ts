// 장소별 콘텐츠 다양화 — 장소 식별자 해시로 도입문/본문 구성/FAQ 조합을 결정한다.
// Math.random/Date를 쓰지 않는 결정적 선택이라 같은 장소는 같은 유형, 다른 장소는 고르게 분산된다.
//
// 모든 목록은 콘텐츠 모드별로 분리돼 있다. condolence 목록·순서는 도입 당시 그대로라
// 기존 장례식장 장소의 선택 결과가 바뀌지 않는다.
import type { ContentMode } from "./content-mode"

export type IntroVariationKey =
  // condolence
  | "order-check"
  | "address-identify"
  | "branch-distinguish"
  | "region-guide"
  | "room-input"
  // celebration
  | "event-schedule"
  | "venue-identify"
  | "celebration-region-guide"
  | "reception-point"
  | "ribbon-input"
  // corporate-celebration
  | "ceremony-schedule"
  | "site-identify"
  | "corporate-region-guide"
  | "gate-point"
  | "sender-input"

export type StructureVariationKey =
  // condolence
  | "place-room-order"
  | "region-address-check"
  | "info-place-detail"
  | "identify-recipient-order"
  // celebration
  | "venue-schedule-order"
  | "region-venue-check"
  | "info-venue-detail"
  | "identify-reception-order"
  // corporate-celebration
  | "site-ceremony-order"
  | "region-site-check"
  | "info-site-detail"
  | "identify-sender-order"

export type FaqTopicKey =
  // condolence
  | "pre-order-check"
  | "unknown-room"
  | "address-lookup"
  | "branch-lookup"
  | "recipient-input"
  | "delivery-availability"
  // celebration
  | "event-date"
  | "venue-access"
  | "ribbon-message"
  | "recipient-absent"
  | "venue-address-lookup"
  | "celebration-delivery-availability"
  // corporate-celebration
  | "gate-delivery"
  | "ceremony-time"
  | "sender-label"
  | "site-access"
  | "corporate-address-lookup"
  | "corporate-delivery-availability"

export type ContentVariation = {
  readonly intro: { readonly key: IntroVariationKey; readonly instruction: string }
  readonly structure: { readonly key: StructureVariationKey; readonly instruction: string }
  readonly faqTopics: readonly [{ readonly key: FaqTopicKey; readonly instruction: string }, { readonly key: FaqTopicKey; readonly instruction: string }]
}

const INTRO_VARIATION_SETS: Readonly<Record<ContentMode, readonly { key: IntroVariationKey; instruction: string }[]>> = {
  condolence: [
    { key: "order-check", instruction: "주문 전에 확인해야 할 정보(빈소명, 받는 분 성함)를 안내하는 문장으로 시작" },
    { key: "address-identify", instruction: "장소의 정확한 명칭과 주소를 먼저 짚어주는 문장으로 시작" },
    { key: "branch-distinguish", instruction: "비슷한 이름의 다른 장소와 혼동하지 않도록 정확한 장소 확인을 안내하는 문장으로 시작" },
    { key: "region-guide", instruction: "해당 지역에서 이 장소로 화환을 보내는 상황을 안내하는 문장으로 시작" },
    { key: "room-input", instruction: "주문 시 빈소 정보를 함께 입력해야 한다는 안내로 시작" },
  ],
  celebration: [
    { key: "event-schedule", instruction: "행사 일정에 맞춰 도착하도록 주문 시점을 확인하라는 문장으로 시작" },
    { key: "venue-identify", instruction: "행사장의 정확한 명칭과 주소를 먼저 짚어주는 문장으로 시작" },
    { key: "celebration-region-guide", instruction: "해당 지역에서 이 장소로 축하화환을 보내는 상황을 안내하는 문장으로 시작" },
    { key: "reception-point", instruction: "행사장 내 수령 위치(연회장·홀 이름)를 함께 확인해야 한다는 안내로 시작" },
    { key: "ribbon-input", instruction: "주문 시 리본 문구와 보내는 사람 표기를 함께 입력해야 한다는 안내로 시작" },
  ],
  "corporate-celebration": [
    { key: "ceremony-schedule", instruction: "개업식·준공식 일정에 맞춰 도착하도록 주문 시점을 확인하라는 문장으로 시작" },
    { key: "site-identify", instruction: "사업장의 정확한 명칭과 주소를 먼저 짚어주는 문장으로 시작" },
    { key: "corporate-region-guide", instruction: "해당 지역에서 이 사업장으로 축하화환을 보내는 상황을 안내하는 문장으로 시작" },
    { key: "gate-point", instruction: "사업장 수령 지점(정문·경비실·행사장)을 함께 확인해야 한다는 안내로 시작" },
    { key: "sender-input", instruction: "주문 시 보내는 회사명과 대표자 표기를 함께 입력해야 한다는 안내로 시작" },
  ],
}

const STRUCTURE_VARIATION_SETS: Readonly<Record<ContentMode, readonly { key: StructureVariationKey; instruction: string }[]>> = {
  condolence: [
    { key: "place-room-order", instruction: "장소명 확인 → 빈소명 확인 → 주문 방법 순서로 구성" },
    { key: "region-address-check", instruction: "지역 → 주소 → 주문 전 확인사항 순서로 구성" },
    { key: "info-place-detail", instruction: "주문 전 필요한 정보 → 장소 정보 → 세부 조건 확인 안내 순서로 구성" },
    { key: "identify-recipient-order", instruction: "장소 식별 → 받는 분 정보 → 주문 과정 안내 순서로 구성" },
  ],
  celebration: [
    { key: "venue-schedule-order", instruction: "행사장 확인 → 행사 일정 확인 → 주문 방법 순서로 구성" },
    { key: "region-venue-check", instruction: "지역 → 주소 → 주문 전 확인사항 순서로 구성" },
    { key: "info-venue-detail", instruction: "주문 전 필요한 정보 → 행사장 정보 → 세부 조건 확인 안내 순서로 구성" },
    { key: "identify-reception-order", instruction: "행사장 식별 → 수령 위치·담당자 → 주문 과정 안내 순서로 구성" },
  ],
  "corporate-celebration": [
    { key: "site-ceremony-order", instruction: "사업장 확인 → 행사 일정 확인 → 주문 방법 순서로 구성" },
    { key: "region-site-check", instruction: "지역 → 주소 → 주문 전 확인사항 순서로 구성" },
    { key: "info-site-detail", instruction: "주문 전 필요한 정보 → 사업장 정보 → 세부 조건 확인 안내 순서로 구성" },
    { key: "identify-sender-order", instruction: "사업장 식별 → 보내는 사람 표기 → 주문 과정 안내 순서로 구성" },
  ],
}

// FAQ 주제는 모드마다 6개로 맞춘다 — pair 조합 수(C(6,2)=15)가 같아야 해시 분산 폭이 유지된다.
export const FAQ_TOPIC_SETS: Readonly<Record<ContentMode, readonly { key: FaqTopicKey; instruction: string }[]>> = {
  condolence: [
    { key: "pre-order-check", instruction: "화환 주문 전에 확인해야 할 정보" },
    { key: "unknown-room", instruction: "빈소명을 모를 때 확인하는 방법" },
    { key: "address-lookup", instruction: "장례식장 주소를 확인하는 방법" },
    { key: "branch-lookup", instruction: "비슷한 이름의 장소(본원·분원 등)와 구분하는 방법" },
    { key: "recipient-input", instruction: "받는 분 정보를 입력하는 방법" },
    { key: "delivery-availability", instruction: "배송 가능 여부를 확인하는 방법 (주문 과정에서 확인된다고 안내)" },
  ],
  celebration: [
    { key: "event-date", instruction: "행사 날짜에 맞춰 도착하도록 주문 시점을 확인하는 방법" },
    { key: "venue-access", instruction: "호텔·행사장 반입 위치를 확인하는 방법" },
    { key: "ribbon-message", instruction: "리본 문구를 작성하는 방법" },
    { key: "recipient-absent", instruction: "수령 담당자가 없을 때 확인하는 방법" },
    { key: "venue-address-lookup", instruction: "행사장 주소를 확인하는 방법" },
    { key: "celebration-delivery-availability", instruction: "배송 가능 여부를 확인하는 방법 (주문 과정에서 확인된다고 안내)" },
  ],
  "corporate-celebration": [
    { key: "gate-delivery", instruction: "사업장 정문·경비실 수령이 가능한지 확인하는 방법" },
    { key: "ceremony-time", instruction: "개업식·준공식 시간에 맞춰 도착하도록 확인하는 방법" },
    { key: "sender-label", instruction: "보내는 회사명과 대표자 표기를 작성하는 방법" },
    { key: "site-access", instruction: "대형 사업장 반입 절차를 확인하는 방법" },
    { key: "corporate-address-lookup", instruction: "사업장 주소를 확인하는 방법" },
    { key: "corporate-delivery-availability", instruction: "배송 가능 여부를 확인하는 방법 (주문 과정에서 확인된다고 안내)" },
  ],
}

export function faqTopicsFor(mode: ContentMode): readonly { key: FaqTopicKey; instruction: string }[] {
  return FAQ_TOPIC_SETS[mode]
}

// FNV-1a 32비트 해시 — 결정적 분산용.
export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function pickFrom<T>(items: readonly T[], index: number): T {
  const item = items[index % items.length]
  if (item === undefined) {
    throw new Error("variation list is empty")
  }
  return item
}

export function pickContentVariation(seed: string, mode: ContentMode): ContentVariation {
  const hash = hashSeed(seed)
  const topics = faqTopicsFor(mode)
  const intro = pickFrom(INTRO_VARIATION_SETS[mode], hash)
  const structure = pickFrom(STRUCTURE_VARIATION_SETS[mode], Math.floor(hash / 7))
  // FAQ 2개 조합: C(6,2)=15가지 중 해시로 선택
  const pairCount = (topics.length * (topics.length - 1)) / 2
  const pairIndex = Math.floor(hash / 31) % pairCount
  let counter = 0
  let first = 0
  let second = 1
  for (let a = 0; a < topics.length; a += 1) {
    for (let b = a + 1; b < topics.length; b += 1) {
      if (counter === pairIndex) {
        first = a
        second = b
      }
      counter += 1
    }
  }
  return {
    intro,
    structure,
    faqTopics: [pickFrom(topics, first), pickFrom(topics, second)],
  }
}
