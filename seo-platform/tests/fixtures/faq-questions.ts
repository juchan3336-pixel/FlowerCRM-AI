import type { ContentMode } from "@/lib/ai/content-mode"
import type { FaqTopicKey } from "@/lib/ai/content-variation"

// 주제별 대표 질문 — v1 6주제는 실제 게시 문구, v2 주제는 전형적인 질문.
// detector가 이 문구를 정확히 해당 주제로 복원해야 최근 공개 회피가 동작한다.
export const FAQ_QUESTIONS: Readonly<Record<ContentMode, Readonly<Partial<Record<FaqTopicKey, string>>>>> = {
  condolence: {
    "pre-order-check": "화환 주문 전에 확인해야 할 정보는 무엇인가요?",
    "unknown-room": "빈소명을 모를 때는 어떻게 확인하나요?",
    "address-lookup": "장례식장 주소는 어떻게 확인하나요?",
    "branch-lookup": "비슷한 이름의 장소와 구분하는 방법은 무엇인가요?",
    "recipient-input": "받는 분 정보를 어떻게 입력해야 하나요?",
    "delivery-availability": "배송 가능 여부는 어떻게 확인하나요?",
    "ribbon-wording": "근조화환 리본 문구는 어떻게 작성하나요?",
    "arrival-time-check": "화환 도착 시간은 어떻게 확인하나요?",
    "order-steps": "화환 주문은 어떤 순서로 진행되나요?",
    "order-change-check": "주문 후 빈소가 바뀌면 어떻게 확인하나요?",
  },
  celebration: {
    "event-date": "행사 날짜에 맞추려면 언제 주문해야 하나요?",
    "venue-access": "화환 반입 위치는 어디에서 확인하나요?",
    "ribbon-message": "리본 문구는 어떻게 작성하나요?",
    "recipient-absent": "수령 담당자가 없으면 어떻게 확인하나요?",
    "venue-address-lookup": "행사장 주소는 어떻게 확인하나요?",
    "celebration-delivery-availability": "배송 가능 여부는 어떻게 확인하나요?",
    "celebration-order-steps": "축하화환 주문 절차는 어떻게 되나요?",
    "celebration-recipient-input": "행사명과 받는 분 성함은 어떻게 입력하나요?",
    "celebration-sender-name": "보내는 분 이름이나 단체명은 어떻게 표기하나요?",
    "celebration-order-change": "주문 후 행사 시간이 변경되면 어떻게 확인하나요?",
  },
  "corporate-celebration": {
    "gate-delivery": "정문이나 경비실에서 수령이 가능한지 어떻게 확인하나요?",
    "ceremony-time": "개업식 시간에 맞추려면 무엇을 확인해야 하나요?",
    "sender-label": "보내는 회사명과 대표자 표기는 어떻게 작성하나요?",
    "site-access": "대형 사업장 반입 절차는 어떻게 확인하나요?",
    "corporate-address-lookup": "사업장 주소는 어떻게 확인하나요?",
    "corporate-delivery-availability": "배송 가능 여부는 어떻게 확인하나요?",
    "corporate-order-steps": "축하화환 주문 순서는 어떻게 되나요?",
    "corporate-ribbon-message": "리본 축하 문구는 어떻게 작성하나요?",
    "corporate-recipient-input": "받는 부서와 받는 분 성함은 어떻게 입력하나요?",
    "corporate-order-change": "주문 후 수령 위치가 바뀌면 어떻게 확인하나요?",
  },
}

export const ALL_CONTENT_MODES: readonly ContentMode[] = ["condolence", "celebration", "corporate-celebration"]

export function faqQuestionsFor(mode: ContentMode, keys: readonly FaqTopicKey[]): string[] {
  return keys.map((key) => FAQ_QUESTIONS[mode][key] ?? "")
}
