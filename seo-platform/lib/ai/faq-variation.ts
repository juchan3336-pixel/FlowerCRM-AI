// FAQ 조합 다양화 v1 — 해시 최초 선택은 유지하되, 최근 공개 5건의 FAQ 조합과
// 동일한 pair를 결정적으로 회피한다 (제목 패턴 회피와 같은 원리).
// 모든 조합이 충돌할 때만 최소 중복 조합을 선택하고 faq_selection으로 표시해 WARN 근거를 남긴다.
import { FAQ_TOPICS, hashSeed, type FaqTopicKey } from "./content-variation"

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
  // 최근 공개 페이지 (최신순) — faqQuestions에서 topic pair를 복원해 회피 기준으로 쓴다.
  readonly recentPages: readonly { readonly faqQuestions: readonly string[] }[]
  // 추가 금지 pair (품질 FAIL 재시도 시 실패 generation의 pair 재사용 금지 등)
  readonly bannedPairs?: readonly FaqPairKeys[]
}

const RECENT_PAIR_WINDOW = 5

// 본원·분원 구분 FAQ는 혼동 가능한 명칭 구조(대학·본원·분원 등)가 있는 장소에만 적합하다.
const BRANCH_SIGNAL_PATTERN = /대학교|대학|본원|분원|캠퍼스/

// 실제 게시된 질문 문구에서 topic key를 복원한다 (판별 불가 시 null — 회피 기준에서 제외).
export function detectFaqTopicKey(question: string): FaqTopicKey | null {
  if (question.includes("빈소") && /(모를|확인)/.test(question)) {
    return "unknown-room"
  }
  if (/받는\s*분/.test(question) && /(정보|입력)/.test(question)) {
    return "recipient-input"
  }
  if (question.includes("주소") && question.includes("확인")) {
    return "address-lookup"
  }
  if (/(비슷한\s*이름|본원|분원)/.test(question)) {
    return "branch-lookup"
  }
  if (/주문\s*(전|하기\s*전)/.test(question) && /(확인|정보)/.test(question)) {
    return "pre-order-check"
  }
  if (question.includes("배송") && /(가능|확인)/.test(question)) {
    return "delivery-availability"
  }
  return null
}

export function faqTopicByKey(key: string): FaqTopic | null {
  return FAQ_TOPICS.find((topic) => topic.key === key) ?? null
}

function pairId(a: FaqTopicKey, b: FaqTopicKey): string {
  return [a, b].sort().join("+")
}

// 페이지의 질문 목록에서 pair를 복원한다 — 두 질문 모두 판별될 때만 pair로 인정 (규칙 4: 1개 중복은 허용).
export function detectFaqPair(faqQuestions: readonly string[]): FaqPairKeys | null {
  const keys = faqQuestions.map((question) => detectFaqTopicKey(question)).filter((key): key is FaqTopicKey => key !== null)
  const [first, second] = keys
  return first !== undefined && second !== undefined && first !== second ? [first, second] : null
}

// C(6,2)=15 전체 조합을 기존 pickContentVariation과 같은 순서로 나열한다 (해시 호환).
function allPairs(): readonly FaqPairKeys[] {
  const pairs: FaqPairKeys[] = []
  for (let a = 0; a < FAQ_TOPICS.length; a += 1) {
    for (let b = a + 1; b < FAQ_TOPICS.length; b += 1) {
      const first = FAQ_TOPICS[a]
      const second = FAQ_TOPICS[b]
      if (first !== undefined && second !== undefined) {
        pairs.push([first.key, second.key])
      }
    }
  }
  return pairs
}

export function pickFaqTopicPair(input: FaqTopicPickInput): FaqTopicPick {
  const pairs = allPairs()
  const hash = hashSeed(input.seed)
  // 최초 선택 인덱스는 기존 pickContentVariation과 동일한 식 — 충돌 없으면 결과도 동일하다.
  const initialIndex = Math.floor(hash / 31) % pairs.length

  const bannedIds = new Set<string>()
  for (const page of input.recentPages.slice(0, RECENT_PAIR_WINDOW)) {
    const pair = detectFaqPair(page.faqQuestions)
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
