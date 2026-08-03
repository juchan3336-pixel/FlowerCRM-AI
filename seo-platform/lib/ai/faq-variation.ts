// FAQ 조합 다양화 v1 — 해시 최초 선택은 유지하되, 최근 공개 5건의 FAQ 조합과
// 동일한 pair를 결정적으로 회피한다 (제목 패턴 회피와 같은 원리).
// 모든 조합이 충돌할 때만 최소 중복 조합을 선택하고 faq_selection으로 표시해 WARN 근거를 남긴다.
import type { ContentMode } from "./content-mode"
import { FAQ_TOPIC_SETS, faqTopicsFor, hashSeed, type FaqTopicKey } from "./content-variation"

export type FaqTopic = { readonly key: FaqTopicKey; readonly instruction: string }

export type FaqPairKeys = readonly [FaqTopicKey, FaqTopicKey]

export type FaqSelectionKind = "hash" | "fallback" | "exhausted-min-overlap"

export type FaqTopicPick = {
  readonly topics: readonly [FaqTopic, FaqTopic]
  readonly keys: FaqPairKeys
  readonly selection: FaqSelectionKind
}

export type FaqTopicPickInput = {
  readonly seed: string
  readonly placeName: string
  readonly mode: ContentMode
  // 최근 공개 페이지 (최신순) — faqQuestions에서 topic pair를 복원해 회피 기준으로 쓴다.
  readonly recentPages: readonly { readonly faqQuestions: readonly string[] }[]
  // 추가 금지 pair (품질 FAIL 재시도 시 실패 generation의 pair 재사용 금지 등)
  readonly bannedPairs?: readonly FaqPairKeys[]
}

const RECENT_PAIR_WINDOW = 5

// 본원·분원 구분 FAQ는 혼동 가능한 명칭 구조(대학·본원·분원 등)가 있는 장소에만 적합하다.
const BRANCH_SIGNAL_PATTERN = /대학교|대학|본원|분원|캠퍼스/

// 질문 문구 → topic key 복원 규칙. 모드별로 따로 두어 다른 모드 키가 섞이지 않게 한다.
const DETECTORS: Readonly<Record<ContentMode, readonly { readonly key: FaqTopicKey; readonly match: (question: string) => boolean }[]>> = {
  condolence: [
    { key: "unknown-room", match: (q) => q.includes("빈소") && /(모를|확인)/.test(q) },
    { key: "recipient-input", match: (q) => /받는\s*분/.test(q) && /(정보|입력)/.test(q) },
    { key: "address-lookup", match: (q) => q.includes("주소") && q.includes("확인") },
    { key: "branch-lookup", match: (q) => /(비슷한\s*이름|본원|분원)/.test(q) },
    { key: "pre-order-check", match: (q) => /주문\s*(전|하기\s*전)/.test(q) && /(확인|정보)/.test(q) },
    { key: "delivery-availability", match: (q) => q.includes("배송") && /(가능|확인)/.test(q) },
  ],
  celebration: [
    { key: "event-date", match: (q) => /(행사|오픈|기념)\s*(날짜|일정|일)/.test(q) },
    { key: "venue-access", match: (q) => q.includes("반입") && /(위치|장소|어디)/.test(q) },
    { key: "ribbon-message", match: (q) => q.includes("리본") },
    { key: "recipient-absent", match: (q) => /수령\s*(담당자|자)/.test(q) },
    { key: "venue-address-lookup", match: (q) => /(행사장|호텔)/.test(q) && q.includes("주소") },
    { key: "celebration-delivery-availability", match: (q) => q.includes("배송") && /(가능|확인)/.test(q) },
  ],
  "corporate-celebration": [
    { key: "gate-delivery", match: (q) => /(경비실|정문)/.test(q) },
    { key: "ceremony-time", match: (q) => /(개업식|준공식|창립|취임)/.test(q) && /(시간|일정)/.test(q) },
    { key: "sender-label", match: (q) => /(회사명|보내는\s*사람|대표자)/.test(q) },
    { key: "site-access", match: (q) => /반입\s*절차/.test(q) },
    { key: "corporate-address-lookup", match: (q) => /(사업장|공장)/.test(q) && q.includes("주소") },
    { key: "corporate-delivery-availability", match: (q) => q.includes("배송") && /(가능|확인)/.test(q) },
  ],
}

// 실제 게시된 질문 문구에서 topic key를 복원한다 (판별 불가 시 null — 회피 기준에서 제외).
export function detectFaqTopicKey(question: string, mode: ContentMode): FaqTopicKey | null {
  return DETECTORS[mode].find((detector) => detector.match(question))?.key ?? null
}

// 저장된 audit·content_plan의 키를 되돌릴 때 쓴다 — 키는 모드 간 고유하므로 전 세트를 본다.
export function faqTopicByKey(key: string): FaqTopic | null {
  for (const topics of Object.values(FAQ_TOPIC_SETS)) {
    const found = topics.find((topic) => topic.key === key)
    if (found !== undefined) {
      return found
    }
  }
  return null
}

function pairId(a: FaqTopicKey, b: FaqTopicKey): string {
  return [a, b].sort().join("+")
}

// 페이지의 질문 목록에서 pair를 복원한다 — 두 질문 모두 판별될 때만 pair로 인정 (규칙 4: 1개 중복은 허용).
export function detectFaqPair(faqQuestions: readonly string[], mode: ContentMode): FaqPairKeys | null {
  const keys = faqQuestions.map((question) => detectFaqTopicKey(question, mode)).filter((key): key is FaqTopicKey => key !== null)
  const [first, second] = keys
  return first !== undefined && second !== undefined && first !== second ? [first, second] : null
}

// C(6,2)=15 전체 조합을 기존 pickContentVariation과 같은 순서로 나열한다 (해시 호환).
function allPairs(mode: ContentMode): readonly FaqPairKeys[] {
  const topics = faqTopicsFor(mode)
  const pairs: FaqPairKeys[] = []
  for (let a = 0; a < topics.length; a += 1) {
    for (let b = a + 1; b < topics.length; b += 1) {
      const first = topics[a]
      const second = topics[b]
      if (first !== undefined && second !== undefined) {
        pairs.push([first.key, second.key])
      }
    }
  }
  return pairs
}

export function pickFaqTopicPair(input: FaqTopicPickInput): FaqTopicPick {
  const pairs = allPairs(input.mode)
  const hash = hashSeed(input.seed)
  // 최초 선택 인덱스는 기존 pickContentVariation과 동일한 식 — 충돌 없으면 결과도 동일하다.
  const initialIndex = Math.floor(hash / 31) % pairs.length

  const bannedIds = new Set<string>()
  for (const page of input.recentPages.slice(0, RECENT_PAIR_WINDOW)) {
    const pair = detectFaqPair(page.faqQuestions, input.mode)
    if (pair !== null) {
      bannedIds.add(pairId(pair[0], pair[1]))
    }
  }
  for (const pair of input.bannedPairs ?? []) {
    bannedIds.add(pairId(pair[0], pair[1]))
  }

  const allowsBranch = BRANCH_SIGNAL_PATTERN.test(input.placeName)
  const isAllowed = (pair: FaqPairKeys): boolean => allowsBranch || (pair[0] !== "branch-lookup" && pair[1] !== "branch-lookup")

  // 해시 시작점에서 결정적으로 순회 — 허용되고 금지되지 않은 첫 조합을 채택한다.
  for (let step = 0; step < pairs.length; step += 1) {
    const pair = pairs[(initialIndex + step) % pairs.length]
    if (pair === undefined || !isAllowed(pair) || bannedIds.has(pairId(pair[0], pair[1]))) {
      continue
    }
    return toPick(pair, step === 0 ? "hash" : "fallback")
  }

  // 모든 허용 조합이 금지된 경우에만: 최근 pair에 등장한 topic 수가 가장 적은 조합을 결정적으로 선택.
  const bannedTopicCounts = new Map<FaqTopicKey, number>()
  for (const id of bannedIds) {
    for (const key of id.split("+")) {
      bannedTopicCounts.set(key as FaqTopicKey, (bannedTopicCounts.get(key as FaqTopicKey) ?? 0) + 1)
    }
  }
  let best: { pair: FaqPairKeys; score: number } | null = null
  for (let step = 0; step < pairs.length; step += 1) {
    const pair = pairs[(initialIndex + step) % pairs.length]
    if (pair === undefined || !isAllowed(pair)) {
      continue
    }
    const score = (bannedTopicCounts.get(pair[0]) ?? 0) + (bannedTopicCounts.get(pair[1]) ?? 0)
    if (best === null || score < best.score) {
      best = { pair, score }
    }
  }
  if (best === null) {
    // 이론상 도달 불가(허용 조합이 항상 존재) — 방어적으로 해시 기본 조합을 반환한다.
    const fallback = pairs[initialIndex] ?? pairs[0]
    if (fallback === undefined) {
      throw new Error("faq topic pool is empty")
    }
    return toPick(fallback, "exhausted-min-overlap")
  }
  return toPick(best.pair, "exhausted-min-overlap")
}

function toPick(pair: FaqPairKeys, selection: FaqSelectionKind): FaqTopicPick {
  const first = faqTopicByKey(pair[0])
  const second = faqTopicByKey(pair[1])
  if (first === null || second === null) {
    throw new Error(`unknown faq topic key: ${pair.join(", ")}`)
  }
  return { topics: [first, second], keys: pair, selection }
}
