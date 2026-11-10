// 장소별 콘텐츠 다양화 — 장소 식별자 해시로 도입문/본문 구성/FAQ 조합을 결정한다.
// Math.random/Date를 쓰지 않는 결정적 선택이라 같은 장소는 같은 유형, 다른 장소는 고르게 분산된다.
//
// 모든 목록은 콘텐츠 모드별로 분리돼 있다.
//
// v2 (변형 풀 확장): 20곳 배치에서 FAQ 조합이 소진(faq:pool-exhausted)돼 풀을 늘렸다.
// - 도입문 5 → 12종, FAQ 주제 6 → 10종(조합 15 → 45쌍). 본문 구성 4종은 그대로다.
// - 기존 항목은 key·문구·순서를 유지하고 새 항목을 뒤에 덧붙였다. 다만 해시 기본 선택이
//   `hash % 풀 크기`라서 풀이 커지면 같은 장소라도 기본 선택이 달라질 수 있다 (이미 게시된
//   콘텐츠는 저장본이라 영향이 없고, 재생성할 때만 달라진다).
import type { ContentMode } from "./content-mode"

export type IntroVariationKey =
  // condolence
  | "order-check"
  | "address-identify"
  | "branch-distinguish"
  | "region-guide"
  | "room-input"
  | "address-road"
  | "absent-mourner"
  | "obituary-info"
  | "ribbon-first"
  | "funeral-schedule"
  | "group-sender"
  | "reader-question"
  // celebration
  | "event-schedule"
  | "venue-identify"
  | "celebration-region-guide"
  | "reception-point"
  | "ribbon-input"
  | "venue-address-road"
  | "invitation-info"
  | "absent-guest"
  | "shared-venue"
  | "celebration-group-sender"
  | "celebration-reader-question"
  | "honoree-name"
  // corporate-celebration
  | "ceremony-schedule"
  | "site-identify"
  | "corporate-region-guide"
  | "gate-point"
  | "sender-input"
  | "site-address-road"
  | "opening-notice"
  | "client-news"
  | "multi-site"
  | "recipient-department"
  | "corporate-reader-question"
  | "congratulation-wording"

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
  | "ribbon-wording"
  | "arrival-time-check"
  | "order-steps"
  | "order-change-check"
  // celebration
  | "event-date"
  | "venue-access"
  | "ribbon-message"
  | "recipient-absent"
  | "venue-address-lookup"
  | "celebration-delivery-availability"
  | "celebration-order-steps"
  | "celebration-recipient-input"
  | "celebration-sender-name"
  | "celebration-order-change"
  // corporate-celebration
  | "gate-delivery"
  | "ceremony-time"
  | "sender-label"
  | "site-access"
  | "corporate-address-lookup"
  | "corporate-delivery-availability"
  | "corporate-order-steps"
  | "corporate-ribbon-message"
  | "corporate-recipient-input"
  | "corporate-order-change"

export type ContentVariation = {
  readonly intro: { readonly key: IntroVariationKey; readonly instruction: string }
  readonly structure: { readonly key: StructureVariationKey; readonly instruction: string }
  readonly faqTopics: readonly [{ readonly key: FaqTopicKey; readonly instruction: string }, { readonly key: FaqTopicKey; readonly instruction: string }]
}

// 도입문 유형 — 모드별 12종. 단어만 바꾼 변형이 아니라 '무엇에서 출발하는가'가 달라야 한다:
// 장소의 검증된 사실(명칭·주소·시군구), 주문자가 손에 쥔 정보(부고·초대장), 주문자의 상황,
// 주문 시 입력 항목. 제공되지 않은 사실(시설·행사 종류·일정)을 단정하게 만드는 지시는 넣지 않는다.
export const INTRO_VARIATION_SETS: Readonly<Record<ContentMode, readonly { key: IntroVariationKey; instruction: string }[]>> = {
  condolence: [
    { key: "order-check", instruction: "주문 전에 확인해야 할 정보(빈소명, 받는 분 성함)를 안내하는 문장으로 시작" },
    { key: "address-identify", instruction: "장소의 정확한 명칭과 주소를 먼저 짚어주는 문장으로 시작" },
    { key: "branch-distinguish", instruction: "비슷한 이름의 다른 장소와 혼동하지 않도록 정확한 장소 확인을 안내하는 문장으로 시작" },
    { key: "region-guide", instruction: "해당 지역에서 이 장소로 화환을 보내는 상황을 안내하는 문장으로 시작" },
    { key: "room-input", instruction: "주문 시 빈소 정보를 함께 입력해야 한다는 안내로 시작" },
    { key: "address-road", instruction: "제공된 address의 도로명 주소를 그대로 인용해 화환이 향할 위치를 짚는 문장으로 시작 (address가 없으면 시·군·구까지만 언급)" },
    { key: "absent-mourner", instruction: "직접 조문하기 어려워 화환으로 마음을 전하려는 사람의 상황에서 출발하는 문장으로 시작" },
    { key: "obituary-info", instruction: "부고 문자에서 확인할 수 있는 정보(장례식장명, 빈소 호실, 상주 성함)를 주문 정보와 연결하는 문장으로 시작" },
    { key: "ribbon-first", instruction: "근조화환 리본에 들어갈 문구와 보내는 분 이름을 먼저 정해야 한다는 문장으로 시작" },
    { key: "funeral-schedule", instruction: "부고에 적힌 발인 일시를 먼저 확인하고 주문 시점을 정하라는 문장으로 시작 (도착 시각을 약속하는 표현 금지)" },
    { key: "group-sender", instruction: "회사·모임 이름으로 함께 보낼 때 단체명 표기를 미리 정리하라는 문장으로 시작" },
    { key: "reader-question", instruction: "이 장소에 화환을 보내려면 무엇부터 확인해야 하는지 독자의 질문을 받아 곧바로 답하는 문장으로 시작" },
  ],
  celebration: [
    { key: "event-schedule", instruction: "행사 일정에 맞춰 도착하도록 주문 시점을 확인하라는 문장으로 시작" },
    { key: "venue-identify", instruction: "행사장의 정확한 명칭과 주소를 먼저 짚어주는 문장으로 시작" },
    { key: "celebration-region-guide", instruction: "해당 지역에서 이 장소로 축하화환을 보내는 상황을 안내하는 문장으로 시작" },
    { key: "reception-point", instruction: "행사장 내 수령 위치(연회장·홀 이름)를 함께 확인해야 한다는 안내로 시작" },
    { key: "ribbon-input", instruction: "주문 시 리본 문구와 보내는 사람 표기를 함께 입력해야 한다는 안내로 시작" },
    { key: "venue-address-road", instruction: "제공된 address의 도로명 주소를 그대로 인용해 화환이 향할 위치를 짚는 문장으로 시작 (address가 없으면 시·군·구까지만 언급)" },
    { key: "invitation-info", instruction: "초대장·행사 안내문에서 확인할 수 있는 정보(행사명, 홀 이름, 시작 시간)를 주문 정보와 연결하는 문장으로 시작" },
    { key: "absent-guest", instruction: "행사에 직접 참석하기 어려워 화환으로 축하를 전하려는 사람의 상황에서 출발하는 문장으로 시작" },
    { key: "shared-venue", instruction: "같은 건물에서 다른 행사가 함께 열릴 수 있으니 행사명으로 구분해 주문해야 한다는 문장으로 시작 (실제 행사 유무를 단정하지 말 것)" },
    { key: "celebration-group-sender", instruction: "회사·모임 이름으로 함께 보낼 때 단체명 표기를 미리 정리하라는 문장으로 시작" },
    { key: "celebration-reader-question", instruction: "이 장소에 축하화환을 보내려면 무엇부터 확인해야 하는지 독자의 질문을 받아 곧바로 답하는 문장으로 시작" },
    { key: "honoree-name", instruction: "축하받는 분의 성함과 행사명을 정확히 확인해야 한다는 문장으로 시작" },
  ],
  "corporate-celebration": [
    { key: "ceremony-schedule", instruction: "개업식·준공식 일정에 맞춰 도착하도록 주문 시점을 확인하라는 문장으로 시작" },
    { key: "site-identify", instruction: "사업장의 정확한 명칭과 주소를 먼저 짚어주는 문장으로 시작" },
    { key: "corporate-region-guide", instruction: "해당 지역에서 이 사업장으로 축하화환을 보내는 상황을 안내하는 문장으로 시작" },
    { key: "gate-point", instruction: "사업장 수령 지점(정문·경비실·행사장)을 함께 확인해야 한다는 안내로 시작" },
    { key: "sender-input", instruction: "주문 시 보내는 회사명과 대표자 표기를 함께 입력해야 한다는 안내로 시작" },
    { key: "site-address-road", instruction: "제공된 address의 도로명 주소를 그대로 인용해 화환이 향할 위치를 짚는 문장으로 시작 (address가 없으면 시·군·구까지만 언급)" },
    { key: "opening-notice", instruction: "개업·이전 안내장이나 초청장에서 확인할 수 있는 정보(상호, 행사 일시, 주소)를 주문 정보와 연결하는 문장으로 시작" },
    { key: "client-news", instruction: "거래처의 개업·이전·준공 소식을 듣고 화환을 준비하는 담당자의 상황에서 출발하는 문장으로 시작" },
    { key: "multi-site", instruction: "같은 회사에 본사·공장·지점이 따로 있을 수 있으니 화환이 갈 사업장을 정확히 구분해야 한다는 문장으로 시작 (실제 사업장 수를 단정하지 말 것)" },
    { key: "recipient-department", instruction: "화환을 받을 부서명과 담당자를 먼저 확인해야 한다는 문장으로 시작" },
    { key: "corporate-reader-question", instruction: "이 사업장에 축하화환을 보내려면 무엇부터 확인해야 하는지 독자의 질문을 받아 곧바로 답하는 문장으로 시작" },
    { key: "congratulation-wording", instruction: "행사 종류(개업·이전·준공·창립·취임)에 맞는 리본 축하 문구를 먼저 정해야 한다는 문장으로 시작" },
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

// FAQ 주제는 모드마다 10개로 맞춘다 — pair 조합 수(C(10,2)=45)가 같아야 해시 분산 폭이 유지된다.
// 20곳 배치의 금지쌍은 최대 25개(앞선 19건 + 최근 공개 5건 + 재시도 1건)라 45쌍이면 소진되지 않는다.
// 일반 근조(분원 주제 제외)는 9주제 = 36쌍이다.
//
// 새 주제의 조건: 고객이 실제로 묻고, 주문 과정에서 '확인 가능한' 질문일 것.
// 가격, 배송 보장, 시설의 화환 정책처럼 이 페이지가 알 수 없는 사실을 답하게 만드는 주제는 넣지 않는다.
// 각 세트의 앞 6개(LEGACY_FAQ_TOPIC_COUNT)는 순서를 바꾸지 않는다 — faqPairIndexes가 그 순서에 의존한다.
export const FAQ_TOPIC_SETS: Readonly<Record<ContentMode, readonly { key: FaqTopicKey; instruction: string }[]>> = {
  condolence: [
    { key: "pre-order-check", instruction: "화환 주문 전에 확인해야 할 정보" },
    { key: "unknown-room", instruction: "빈소명을 모를 때 확인하는 방법" },
    { key: "address-lookup", instruction: "장례식장 주소를 확인하는 방법" },
    { key: "branch-lookup", instruction: "비슷한 이름의 장소(본원·분원 등)와 구분하는 방법" },
    { key: "recipient-input", instruction: "받는 분 정보를 입력하는 방법" },
    { key: "delivery-availability", instruction: "배송 가능 여부를 확인하는 방법 (주문 과정에서 확인된다고 안내)" },
    { key: "ribbon-wording", instruction: "근조화환 리본 문구와 보내는 분 이름을 작성하는 방법" },
    { key: "arrival-time-check", instruction: "화환 도착 시간을 확인하는 방법 (주문 과정에서 확인된다고 안내, 도착 시각을 약속하지 말 것)" },
    { key: "order-steps", instruction: "'화환 주문하기' 버튼으로 주문할 때 입력하는 정보와 진행 순서" },
    { key: "order-change-check", instruction: "주문 후 빈소나 리본 문구가 바뀌었을 때 변경 가능 여부를 확인하는 방법 (주문 과정에서 확인된다고 안내, 변경 정책을 단정하지 말 것)" },
  ],
  celebration: [
    { key: "event-date", instruction: "행사 날짜에 맞춰 도착하도록 주문 시점을 확인하는 방법" },
    { key: "venue-access", instruction: "호텔·행사장 반입 가능 여부와 반입 위치를 확인하는 방법 (행사장에 직접 확인하도록 안내, 주문 과정에서 확인된다고 쓰지 말 것)" },
    { key: "ribbon-message", instruction: "리본 문구를 작성하는 방법" },
    { key: "recipient-absent", instruction: "수령 담당자가 없을 때 확인하는 방법" },
    { key: "venue-address-lookup", instruction: "행사장 주소를 확인하는 방법" },
    { key: "celebration-delivery-availability", instruction: "배송 가능 여부를 확인하는 방법 (주문 과정에서 확인된다고 안내)" },
    { key: "celebration-order-steps", instruction: "'화환 주문하기' 버튼으로 주문할 때 입력하는 정보와 진행 순서" },
    { key: "celebration-recipient-input", instruction: "주문 시 행사명과 받는 분 성함을 입력하는 방법" },
    { key: "celebration-sender-name", instruction: "보내는 분 이름이나 단체명을 표기하는 방법" },
    { key: "celebration-order-change", instruction: "주문 후 행사 시간이나 장소가 바뀌었을 때 변경 가능 여부를 확인하는 방법 (주문 과정에서 확인된다고 안내, 변경 정책을 단정하지 말 것)" },
  ],
  "corporate-celebration": [
    { key: "gate-delivery", instruction: "사업장 정문·경비실 수령이 가능한지 확인하는 방법" },
    { key: "ceremony-time", instruction: "개업식·준공식 시간에 맞춰 도착하도록 확인하는 방법" },
    { key: "sender-label", instruction: "보내는 회사명과 대표자 표기를 작성하는 방법" },
    { key: "site-access", instruction: "대형 사업장 반입 절차를 확인하는 방법" },
    { key: "corporate-address-lookup", instruction: "사업장 주소를 확인하는 방법" },
    { key: "corporate-delivery-availability", instruction: "배송 가능 여부를 확인하는 방법 (주문 과정에서 확인된다고 안내)" },
    { key: "corporate-order-steps", instruction: "'화환 주문하기' 버튼으로 주문할 때 입력하는 정보와 진행 순서" },
    { key: "corporate-ribbon-message", instruction: "행사 종류에 맞는 리본 축하 문구를 작성하는 방법" },
    { key: "corporate-recipient-input", instruction: "주문 시 받는 부서와 받는 분 성함을 입력하는 방법" },
    { key: "corporate-order-change", instruction: "주문 후 행사 시간이나 수령 위치가 바뀌었을 때 변경 가능 여부를 확인하는 방법 (주문 과정에서 확인된다고 안내, 변경 정책을 단정하지 말 것)" },
  ],
}

export function faqTopicsFor(mode: ContentMode): readonly { key: FaqTopicKey; instruction: string }[] {
  return FAQ_TOPIC_SETS[mode]
}

// v1 풀의 주제 수 — 각 세트의 앞 6개가 v1 주제다.
export const LEGACY_FAQ_TOPIC_COUNT = 6

// FAQ pair를 (주제 인덱스 a < b) 쌍으로 나열한다. pickContentVariation과 faq-variation이 같은 순서를 써야
// 해시 기본 선택이 서로 일치한다.
// v1 주제끼리의 15쌍을 v1과 같은 순서로 먼저 두고 새 주제가 낀 쌍을 뒤에 둔다 — 그래야
// `index % 45`가 15 미만인 장소(약 1/3)는 풀 확장 전과 같은 기본 조합을 유지한다.
export function faqPairIndexes(topicCount: number): readonly (readonly [number, number])[] {
  const legacy: (readonly [number, number])[] = []
  const added: (readonly [number, number])[] = []
  for (let a = 0; a < topicCount; a += 1) {
    for (let b = a + 1; b < topicCount; b += 1) {
      const target = b < LEGACY_FAQ_TOPIC_COUNT ? legacy : added
      target.push([a, b])
    }
  }
  return [...legacy, ...added]
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
  // FAQ 2개 조합: 전체 pair 중 해시로 선택 (나열 순서는 faqPairIndexes가 정한다)
  const pairs = faqPairIndexes(topics.length)
  const [first, second] = pairs[Math.floor(hash / 31) % pairs.length] ?? [0, 1]
  return {
    intro,
    structure,
    faqTopics: [pickFrom(topics, first), pickFrom(topics, second)],
  }
}
