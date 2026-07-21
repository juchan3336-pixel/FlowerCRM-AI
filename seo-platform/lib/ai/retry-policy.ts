// 품질 FAIL 복구 재시도 정책 — Quality FAIL인 preview에 한해, 원본당 최대 1회의 제어된 재시도만 허용한다.
// 일반 사용자의 AI 생성 재클릭(generatePlaceAiPreviewAction)과 달리 원본 generation id·사유가 감사 기록된다.
import type { StoredQualityReport } from "./generation-mapping"
import { detectFaqPair, type FaqPairKeys } from "./faq-variation"
import type { FaqTopicKey } from "./content-variation"

export const QUALITY_FAIL_RETRY_MAX = 1

export type QualityFailRetryDecision =
  | { readonly allowed: true; readonly reason: string }
  | { readonly allowed: false; readonly blockedBy: "no-quality" | "not-fail" | "retry-exhausted" | "is-retry" }

export type QualityFailRetryDecisionInput = {
  readonly quality: StoredQualityReport | null
  // 이 원본을 참조하는 기존 재시도 수 (output.retry.of 기준)
  readonly existingRetryCount: number
  // 원본 자체가 재시도 generation이면 추가 재시도 금지 (재시도 실패 시 즉시 중단·보고)
  readonly isRetryGeneration: boolean
}

export function decideQualityFailRetry(input: QualityFailRetryDecisionInput): QualityFailRetryDecision {
  if (input.quality === null) {
    return { allowed: false, blockedBy: "no-quality" }
  }
  if (input.quality.status !== "fail") {
    return { allowed: false, blockedBy: "not-fail" }
  }
  if (input.isRetryGeneration) {
    return { allowed: false, blockedBy: "is-retry" }
  }
  if (input.existingRetryCount >= QUALITY_FAIL_RETRY_MAX) {
    return { allowed: false, blockedBy: "retry-exhausted" }
  }
  const firstFailCode = input.quality.issues.find((issue) => issue.level === "fail")?.code ?? "unknown"
  return { allowed: true, reason: `quality-fail-${firstFailCode.replace(/:/g, "-")}` }
}

// 실패 generation이 사용한 FAQ pair — content_plan.faq_topic_keys 우선, 구 레코드는 생성 질문에서 복원한다.
// pair를 복원하지 못하면 null (최근 공개 회피만으로 진행).
export function faqPairOfFailedGeneration(input: Readonly<{ contentPlanFaqKeys: readonly string[] | null; faqQuestions: readonly string[] }>): FaqPairKeys | null {
  const keys = (input.contentPlanFaqKeys ?? []).filter((key): key is FaqTopicKey => isFaqTopicKey(key))
  const [first, second] = keys
  if (first !== undefined && second !== undefined && first !== second) {
    return [first, second]
  }
  return detectFaqPair(input.faqQuestions)
}

const FAQ_TOPIC_KEYS: readonly string[] = ["pre-order-check", "unknown-room", "address-lookup", "branch-lookup", "recipient-input", "delivery-availability"]

function isFaqTopicKey(value: string): value is FaqTopicKey {
  return FAQ_TOPIC_KEYS.includes(value)
}
