// 자동 초안의 주제 목록 — 모드마다 "주문을 준비하는 사람이 실제로 궁금해하는 것"과,
// 그 글에 반드시 들어가야 하는 구체적인 내용(must)을 함께 정한다.
//
// 2026-11-11 운영 첫 초안은 규칙 위반 없이 통과했지만 쓸 만한 정보가 없었다 — "빈소 호실은 빈소가 위치한 구역을 의미하며"처럼
// 누구나 아는 말을 풀어 쓰고, "정확히 확인하라"를 반복하고, 마지막 문단에서 앞 내용을 다시 정리했다.
// 주제 한 줄만 주면 모델이 일반론으로 채운다. 그래서 주제마다 "독자가 이 글을 읽고 바로 써먹을 것"을 못 박는다.
//
// 같은 캠페인에서 덜 쓴 주제부터 고른다. 한 바퀴 돌면 같은 주제를 다른 제목·구성으로 다시 쓴다(이미 쓴 제목을 함께 넘긴다).
import type { ContentMode } from "@/lib/ai/content-mode"

export type DraftTopic = {
  // 생성 기록에 남기는 식별자 (영문/숫자/-)
  readonly key: string
  // 글의 주제 한 줄
  readonly prompt: string
  // 본문에 반드시 들어갈 구체적인 내용 — 2~4개
  readonly must: readonly string[]
  // must가 요구하는 "작은따옴표 인용 예시"의 개수 — 문장 검사가 이 수만큼 있는지 본다(없으면 0)
  readonly quotedExamples: number
}

const TOPICS: Readonly<Record<ContentMode, readonly DraftTopic[]>> = {
  condolence: [
    {
      key: "order-checklist",
      prompt: "근조화환을 주문하기 전에 부고 문자에서 무엇을 옮겨 적으면 되는지",
      must: [
        "부고 문자에서 옮겨 적을 항목 3가지(장례식장 정식 명칭, 빈소 호실, 상주 성함)를 한 줄씩 나열",
        "같은 이름의 장례식장이 여러 지점이면 지점명까지 적어야 한다는 점",
        "발인 일시를 함께 확인하는 이유 한 문장",
      ],
      quotedExamples: 0,
    },
    {
      key: "ribbon-wording",
      prompt: "근조화환 리본 문구 쓰는 법",
      must: [
        "오른쪽 리본(조의 문구)과 왼쪽 리본(보내는 사람)의 역할",
        "조의 문구 예시 3개를 작은따옴표로 인용(예: '삼가 고인의 명복을 빕니다')",
        "보내는 사람 표기 예시 2개(개인, 회사)",
      ],
      quotedExamples: 3,
    },
    {
      key: "company-sender",
      prompt: "회사·단체 이름으로 근조화환을 보낼 때 리본 표기",
      must: [
        "회사명과 대표자 직함·성함을 적는 순서 예시를 작은따옴표로 인용",
        "부서·동기회 등 단체 이름으로 보낼 때의 표기 예시",
        "여러 명이 함께 보낼 때 '임직원 일동' 같은 표기를 쓰는 경우",
      ],
      quotedExamples: 1,
    },
    {
      key: "timing",
      prompt: "부고를 받은 뒤 근조화환을 언제 보내면 좋은지",
      must: ["조문 기간 안에 도착하도록 발인 일시를 기준으로 생각하는 방법", "발인 일시와, 장례식장이 화환을 받는 마감 시각을 미리 확인하는 방법", "늦게 소식을 들었을 때 화환 대신 할 수 있는 일 한 가지"],
      quotedExamples: 0,
    },
    {
      key: "wrong-address",
      prompt: "근조화환이 다른 빈소로 가는 실수를 막는 방법",
      must: ["실수가 생기는 대표적인 경우 2가지(비슷한 이름의 장례식장, 같은 장례식장의 다른 호실)", "주문서에 상주 성함과 호실을 함께 적는 이유", "부고 문자를 그대로 붙여 넣는 방법"],
      quotedExamples: 0,
    },
    {
      key: "far-away",
      prompt: "직접 조문하기 어려운 먼 지역의 장례에 근조화환으로 마음을 전하는 방법",
      must: ["화환과 함께 상주에게 보낼 짧은 문자 예시 1개를 작은따옴표로 인용", "리본의 보내는 사람에 소속을 함께 적으면 좋은 이유", "나중에 직접 인사할 때 덧붙일 말 한 가지"],
      quotedExamples: 1,
    },
  ],
  celebration: [
    {
      key: "ribbon-wording",
      prompt: "결혼식 축하화환 리본 문구 쓰는 법",
      must: ["축하 문구 예시 3개를 작은따옴표로 인용", "보내는 사람 표기 예시 2개(친구 모임, 회사)", "신랑 측·신부 측 어느 쪽 손님인지 리본에 드러내는 방법"],
      quotedExamples: 3,
    },
    {
      key: "order-checklist",
      prompt: "결혼식 축하화환을 주문하기 전에 청첩장에서 옮겨 적을 정보",
      must: ["청첩장에서 옮겨 적을 항목(예식 일시, 예식장 이름, 홀 이름, 신랑·신부 성함)을 한 줄씩 나열", "같은 날 같은 예식장에서 여러 예식이 열릴 때 홀 이름이 필요한 이유", "예식 시작 전에 놓여야 하는 이유 한 문장"],
      quotedExamples: 0,
    },
    {
      key: "group-sender",
      prompt: "친구 모임·동호회 이름으로 결혼식 축하화환을 보낼 때",
      must: ["모임 이름 표기 예시 2개를 작은따옴표로 인용", "대표자 이름을 함께 적을지 정하는 기준", "신랑·신부가 바로 알아볼 수 있는 이름을 고르는 요령"],
      quotedExamples: 2,
    },
    {
      key: "timing",
      prompt: "결혼식 축하화환은 예식 전 언제 도착하게 주문하면 좋은지",
      must: ["예식 시작 시각을 기준으로 생각하는 방법", "예식장마다 화환 반입 시간이 다를 수 있으니 확인하라는 점", "예식 당일 급하게 주문할 때 먼저 확인할 것"],
      quotedExamples: 0,
    },
    {
      key: "events",
      prompt: "돌잔치·공연·전시 등 행사에 축하화환을 보낼 때",
      must: ["행사 종류별 축하 문구 예시 3개(돌잔치, 공연, 전시)를 작은따옴표로 인용", "행사장에 화환을 둘 공간이 있는지 확인하는 이유", "받는 사람 이름을 무엇으로 적을지(아이 이름, 단체명 등)"],
      quotedExamples: 3,
    },
    {
      key: "same-venue",
      prompt: "같은 예식장에서 같은 날 여러 예식이 있을 때 화환이 제자리에 놓이게 하려면",
      must: ["주문서에 홀 이름과 예식 시각을 함께 적는 방법", "리본에 신랑·신부 이름을 넣는 예시를 작은따옴표로 인용", "청첩장 사진을 참고해 이름 철자를 맞추는 요령"],
      quotedExamples: 1,
    },
  ],
  "corporate-celebration": [
    {
      key: "order-checklist",
      prompt: "거래처 개업식에 축하화환을 보내기 전에 확인할 정보",
      must: ["확인할 항목(행사 일시, 건물명·층·호수, 정확한 상호)을 한 줄씩 나열", "새로 연 곳은 지도 검색에 아직 안 나올 수 있으니 주소를 직접 받아 두라는 점", "행사 시작 전에 놓여야 하는 이유 한 문장"],
      quotedExamples: 0,
    },
    {
      key: "ribbon-wording",
      prompt: "개업·이전·취임 축하화환 리본 문구 쓰는 법",
      must: ["행사별 축하 문구 예시 3개(개업, 이전, 취임)를 작은따옴표로 인용", "보내는 회사명과 대표자 표기 예시를 작은따옴표로 인용", "문구를 짧게 쓰는 것이 좋은 이유 한 문장"],
      quotedExamples: 4,
    },
    {
      key: "inauguration",
      prompt: "취임·승진 축하화환을 보낼 때 받는 분의 직함을 확인하는 방법",
      must: ["새 직함을 확인하는 방법 2가지(보도자료, 담당 비서실 등)", "리본에 받는 분 직함과 성함을 넣는 예시를 작은따옴표로 인용", "직함이 틀렸을 때 생기는 문제 한 문장"],
      quotedExamples: 1,
    },
    {
      key: "relocation",
      prompt: "사무실 이전·확장 축하화환을 보낼 때 새 주소를 확인하는 방법",
      must: ["새 주소를 받는 분이나 담당자에게 직접 받아 두라는 점", "건물명·층·호수까지 받아 두는 요령", "이전 축하 문구 예시 2개를 작은따옴표로 인용"],
      quotedExamples: 2,
    },
    {
      key: "anniversary",
      prompt: "창립기념·준공식 등 회사 행사에 축하화환을 보낼 때 담당자가 챙길 것",
      must: ["행사 종류별 축하 문구 예시 2개(창립기념, 준공)를 작은따옴표로 인용", "행사장 입구와 건물 출입 가능 시간을 확인하는 이유", "여러 계열사가 함께 보낼 때 리본 표기 방법"],
      quotedExamples: 2,
    },
    {
      key: "timing",
      prompt: "행사 시작 전에 축하화환이 놓이도록 일정을 잡는 방법",
      must: ["행사 시작 시각을 기준으로 생각하는 방법", "주말·이른 아침 행사는 건물 출입이 제한될 수 있으니 미리 확인하라는 점", "행사 당일 급하게 주문할 때 먼저 확인할 것"],
      quotedExamples: 0,
    },
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

// 생성 요청에 넣을 주제 문장 — 주제 한 줄과 반드시 넣을 내용
export function topicBrief(topic: DraftTopic): string {
  return `${topic.prompt}\n반드시 넣을 내용:\n${topic.must.map((item) => `- ${item}`).join("\n")}`
}
