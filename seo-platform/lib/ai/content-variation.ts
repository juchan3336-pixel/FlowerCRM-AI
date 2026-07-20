// 장소별 콘텐츠 다양화 — 장소 식별자 해시로 도입문/본문 구성/FAQ 조합을 결정한다.
// Math.random/Date를 쓰지 않는 결정적 선택이라 같은 장소는 같은 유형, 다른 장소는 고르게 분산된다.

export type IntroVariationKey = "order-check" | "address-identify" | "branch-distinguish" | "region-guide" | "room-input"
export type StructureVariationKey = "place-room-order" | "region-address-check" | "info-place-detail" | "identify-recipient-order"
export type FaqTopicKey = "pre-order-check" | "unknown-room" | "address-lookup" | "branch-lookup" | "recipient-input" | "delivery-availability"

export type ContentVariation = {
  readonly intro: { readonly key: IntroVariationKey; readonly instruction: string }
  readonly structure: { readonly key: StructureVariationKey; readonly instruction: string }
  readonly faqTopics: readonly [{ readonly key: FaqTopicKey; readonly instruction: string }, { readonly key: FaqTopicKey; readonly instruction: string }]
}

const INTRO_VARIATIONS: readonly { key: IntroVariationKey; instruction: string }[] = [
  { key: "order-check", instruction: "주문 전에 확인해야 할 정보(빈소명, 받는 분 성함)를 안내하는 문장으로 시작" },
  { key: "address-identify", instruction: "장소의 정확한 명칭과 주소를 먼저 짚어주는 문장으로 시작" },
  { key: "branch-distinguish", instruction: "비슷한 이름의 다른 장소와 혼동하지 않도록 정확한 장소 확인을 안내하는 문장으로 시작" },
  { key: "region-guide", instruction: "해당 지역에서 이 장소로 화환을 보내는 상황을 안내하는 문장으로 시작" },
  { key: "room-input", instruction: "주문 시 빈소 정보를 함께 입력해야 한다는 안내로 시작" },
]

const STRUCTURE_VARIATIONS: readonly { key: StructureVariationKey; instruction: string }[] = [
  { key: "place-room-order", instruction: "장소명 확인 → 빈소명 확인 → 주문 방법 순서로 구성" },
  { key: "region-address-check", instruction: "지역 → 주소 → 주문 전 확인사항 순서로 구성" },
  { key: "info-place-detail", instruction: "주문 전 필요한 정보 → 장소 정보 → 세부 조건 확인 안내 순서로 구성" },
  { key: "identify-recipient-order", instruction: "장소 식별 → 받는 분 정보 → 주문 과정 안내 순서로 구성" },
]

const FAQ_TOPICS: readonly { key: FaqTopicKey; instruction: string }[] = [
  { key: "pre-order-check", instruction: "화환 주문 전에 확인해야 할 정보" },
  { key: "unknown-room", instruction: "빈소명을 모를 때 확인하는 방법" },
  { key: "address-lookup", instruction: "장례식장 주소를 확인하는 방법" },
  { key: "branch-lookup", instruction: "비슷한 이름의 장소(본원·분원 등)와 구분하는 방법" },
  { key: "recipient-input", instruction: "받는 분 정보를 입력하는 방법" },
  { key: "delivery-availability", instruction: "배송 가능 여부를 확인하는 방법 (주문 과정에서 확인된다고 안내)" },
]

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

export function pickContentVariation(seed: string): ContentVariation {
  const hash = hashSeed(seed)
  const intro = pickFrom(INTRO_VARIATIONS, hash)
  const structure = pickFrom(STRUCTURE_VARIATIONS, Math.floor(hash / 7))
  // FAQ 2개 조합: C(6,2)=15가지 중 해시로 선택
  const pairIndex = Math.floor(hash / 31) % 15
  let counter = 0
  let first = 0
  let second = 1
  for (let a = 0; a < FAQ_TOPICS.length; a += 1) {
    for (let b = a + 1; b < FAQ_TOPICS.length; b += 1) {
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
    faqTopics: [pickFrom(FAQ_TOPICS, first), pickFrom(FAQ_TOPICS, second)],
  }
}
