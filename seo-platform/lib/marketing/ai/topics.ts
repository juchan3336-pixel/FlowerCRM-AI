// 자동 초안의 주제 목록 — 모드마다 "주문을 준비하는 사람이 실제로 궁금해하는 것"을 한 줄씩.
// 같은 캠페인에서 덜 쓴 주제부터 고른다. 주제가 한 바퀴 돌면 같은 주제를 다른 제목·구성으로 다시 쓴다
// (이미 쓴 제목은 생성 요청에 함께 넘긴다).
import type { ContentMode } from "@/lib/ai/content-mode"

export type DraftTopic = {
  // 생성 기록에 남기는 식별자 (영문/숫자/-)
  readonly key: string
  readonly prompt: string
}

const TOPICS: Readonly<Record<ContentMode, readonly DraftTopic[]>> = {
  condolence: [
    { key: "order-checklist", prompt: "근조화환을 주문하기 전에 확인할 정보(장례식장 정식 명칭, 빈소 호실, 상주 성함)" },
    { key: "ribbon-wording", prompt: "근조화환 리본 문구를 쓰는 방법(조의 문구와 보내는 사람 표기, 개인과 회사의 차이)" },
    { key: "company-sender", prompt: "회사·단체 이름으로 근조화환을 보낼 때 리본에 적는 순서와 주의할 점" },
    { key: "timing", prompt: "부고를 받은 뒤 근조화환을 언제 보내는 것이 좋은지와 발인 일정 확인" },
    { key: "wrong-address", prompt: "근조화환이 다른 빈소로 가는 실수를 막으려면 주문할 때 무엇을 정확히 적어야 하는지" },
    { key: "far-away", prompt: "직접 조문하기 어려운 먼 지역의 장례에 근조화환으로 마음을 전하는 방법" },
  ],
  celebration: [
    { key: "ribbon-wording", prompt: "결혼식 축하화환 리본 문구를 쓰는 방법(축하 문구와 보내는 사람 표기)" },
    { key: "order-checklist", prompt: "결혼식 축하화환을 주문하기 전에 확인할 정보(예식 날짜와 시간, 예식장과 홀 이름, 신랑·신부 성함)" },
    { key: "group-sender", prompt: "친구 모임·동호회 이름으로 결혼식 축하화환을 보낼 때 리본에 적는 방법" },
    { key: "timing", prompt: "결혼식 축하화환은 예식 전 언제 도착하도록 주문하는 것이 좋은지" },
    { key: "events", prompt: "돌잔치·공연·전시 등 행사에 축하화환을 보낼 때 확인할 것" },
    { key: "same-venue", prompt: "같은 예식장에서 같은 날 여러 예식이 있을 때 화환이 제자리에 놓이게 하려면" },
  ],
  "corporate-celebration": [
    { key: "order-checklist", prompt: "거래처 개업식에 축하화환을 보내기 전에 확인할 정보(행사 일시, 정확한 주소, 상호)" },
    { key: "ribbon-wording", prompt: "개업·이전·취임 축하화환 리본 문구를 쓰는 방법과 회사명·대표자 표기" },
    { key: "inauguration", prompt: "취임·승진 축하화환을 보낼 때 받는 분의 직함을 정확히 확인해야 하는 이유" },
    { key: "relocation", prompt: "사무실 이전·확장 축하화환을 보낼 때 새 주소와 층·호수를 확인하는 방법" },
    { key: "anniversary", prompt: "창립기념·준공식 등 회사 행사에 축하화환을 보낼 때 담당자가 챙길 것" },
    { key: "timing", prompt: "행사 시작 전에 축하화환이 놓이도록 일정을 잡는 방법" },
  ],
}

export function listDraftTopics(mode: ContentMode): readonly DraftTopic[] {
  return TOPICS[mode]
}

// 덜 쓴 주제부터. 사용 횟수가 같으면 목록 순서대로.
export function pickDraftTopic(mode: ContentMode, usedKeys: readonly string[]): DraftTopic {
  const topics = TOPICS[mode]
  const count = (key: string): number => usedKeys.filter((used) => used === key).length
  const [first, ...rest] = topics
  if (first === undefined) {
    throw new Error(`no draft topics for mode: ${mode}`)
  }
  return rest.reduce((best, topic) => (count(topic.key) < count(best.key) ? topic : best), first)
}
