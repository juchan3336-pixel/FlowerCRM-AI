// 게시된 페이지의 FAQ 답변 보정 — 순수 판정.
//
// ready 보정(correct-ready)은 draft 장소의 제목·본문·메타 설명만 다룬다. 이미 공개된 페이지의 FAQ 답변에서
// 사실과 다르게 읽히는 문장을 발견했을 때(2026-11-10: "주문 과정에서 반입 위치 확인이 가능합니다")
// 게시 상태를 되돌리지 않고 답변 한 개만 고치는 경로다.
//
// 범위는 일부러 좁다: 한 step이 FAQ 한 항목의 '답변'만 바꾼다. 질문은 바꾸지 않는다 —
// 질문은 FAQ 주제 선택·제목 정렬·감사 기록과 묶여 있다. FAQ 개수·순서, 다른 항목, 제목·본문·메타·키워드·링크는 불변이다.
import type { AiGeneratedSeoContent } from "@/lib/ai/types"

export const PUBLISHED_FAQ_ANSWER_MAX_LENGTH = 400
export const PUBLISHED_FAQ_REASON_MAX_LENGTH = 300
// FAQ 배열 길이의 상한이 아니라 step에 적을 수 있는 index의 형식 상한이다 (실제 범위는 실행 시 배열로 확인).
export const PUBLISHED_FAQ_INDEX_LIMIT = 50

export type PublishedFaqCorrectionStep = {
  readonly kind: "correct-published-faq"
  readonly placeId: string
  readonly generationId: string
  readonly expectedContentHash: string
  readonly faqIndex: number
  // 바꾸려는 항목의 질문 — 실행 시 그 index의 질문과 글자 그대로 같아야 한다 (index가 밀렸을 때의 오적용 방지).
  readonly expectedQuestion: string
  readonly answer: string
  readonly reason: string
}

const STEP_KEYS = ["kind", "placeId", "generationId", "expectedContentHash", "faqIndex", "expectedQuestion", "answer", "reason"] as const
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256_PATTERN = /^[0-9a-f]{64}$/

// 엄격 해석 — 정해진 키만, 정해진 형식만. 질문을 바꾸려는 입력(question 등 다른 키)은 통째로 거절한다.
export function parsePublishedFaqCorrectionStep(raw: Readonly<Record<string, unknown>>): PublishedFaqCorrectionStep | null {
  if (raw["kind"] !== "correct-published-faq") {
    return null
  }
  const keys = Object.keys(raw)
  if (keys.length !== STEP_KEYS.length || !keys.every((key) => (STEP_KEYS as readonly string[]).includes(key))) {
    return null
  }
  const { placeId, generationId, expectedContentHash, faqIndex, expectedQuestion, answer, reason } = raw
  if (typeof placeId !== "string" || !UUID_PATTERN.test(placeId) || typeof generationId !== "string" || !UUID_PATTERN.test(generationId)) {
    return null
  }
  if (typeof expectedContentHash !== "string" || !SHA256_PATTERN.test(expectedContentHash)) {
    return null
  }
  if (typeof faqIndex !== "number" || !Number.isInteger(faqIndex) || faqIndex < 0 || faqIndex >= PUBLISHED_FAQ_INDEX_LIMIT) {
    return null
  }
  if (typeof expectedQuestion !== "string" || expectedQuestion.trim().length === 0) {
    return null
  }
  if (typeof answer !== "string" || answer.trim().length === 0 || answer !== answer.trim() || answer.length > PUBLISHED_FAQ_ANSWER_MAX_LENGTH) {
    return null
  }
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > PUBLISHED_FAQ_REASON_MAX_LENGTH) {
    return null
  }
  return { kind: "correct-published-faq", placeId, generationId, expectedContentHash, faqIndex, expectedQuestion, answer, reason }
}

export type FaqAnswerEdit =
  | { readonly kind: "edited"; readonly content: AiGeneratedSeoContent; readonly before: string }
  | { readonly kind: "index-out-of-range" }
  | { readonly kind: "question-mismatch" }
  | { readonly kind: "no-changes" }

// 답변 한 개만 바꾼 새 콘텐츠를 만든다. 입력은 건드리지 않는다.
export function editFaqAnswer(content: AiGeneratedSeoContent, input: Readonly<{ faqIndex: number; expectedQuestion: string; answer: string }>): FaqAnswerEdit {
  const target = content.faq[input.faqIndex]
  if (target === undefined) {
    return { kind: "index-out-of-range" }
  }
  if (target.question !== input.expectedQuestion) {
    return { kind: "question-mismatch" }
  }
  if (target.answer === input.answer) {
    return { kind: "no-changes" }
  }
  const faq = content.faq.map((entry, index) => (index === input.faqIndex ? { ...entry, answer: input.answer } : entry))
  return { kind: "edited", content: { ...content, faq }, before: target.answer }
}

// 보정안이 '새로 만든' 문제만 고른다. 바꾸지 않은 제목·본문에 예전부터 있던 문제로 FAQ 안전 보정을 막지 않는다.
export function newIssueCodes(baseline: readonly string[], candidate: readonly string[]): readonly string[] {
  const known = new Set(baseline)
  return candidate.filter((code) => !known.has(code))
}
