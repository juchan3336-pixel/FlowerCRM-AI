// 품질 FAIL 복구 재시도 정책 — Quality FAIL인 preview에 한해, 원본당 최대 1회의 제어된 재시도만 허용한다.
// 일반 사용자의 AI 생성 재클릭(generatePlaceAiPreviewAction)과 달리 원본 generation id·사유가 감사 기록된다.
import type { StoredQualityReport } from "./generation-mapping"
import { detectFaqPair, type FaqPairKeys } from "./faq-variation"
import type { FaqTopicKey } from "./content-variation"

export const QUALITY_FAIL_RETRY_MAX = 1

// Batch 제어 재시도가 generation을 남기지 못하고 끝난 경우의 흔적 —
// 신규 실행은 last_error_code를 "retry-"로 접두하고(예: retry-recent-preview, retry-quality-fail),
// 접두 규칙 도입 이전 행(2026-07-23 대구병원)은 last_error_message로만 식별된다.
export const BATCH_RETRY_ERROR_CODE_PREFIX = "retry-"
export const BATCH_RETRY_FAILURE_MESSAGE_PREFIX = "복구 재시도 실패: "

export type QualityFailRetryDecision =
  | { readonly allowed: true; readonly reason: string }
  | { readonly allowed: false; readonly blockedBy: "no-quality" | "not-fail" | "retry-exhausted" | "is-retry" }

export type QualityFailRetryDecisionInput = {
  readonly quality: StoredQualityReport | null
  // 이 원본에 대해 이미 소진된 복구 재시도 횟수 — generation이 남지 않은 시도도 포함한다.
  // countConsumedQualityFailRetries로 계산할 것 (시간 경과와 무관한 내구적 판정).
  readonly consumedRetryCount: number
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
  if (input.consumedRetryCount >= QUALITY_FAIL_RETRY_MAX) {
    return { allowed: false, blockedBy: "retry-exhausted" }
  }
  const firstFailCode = input.quality.issues.find((issue) => issue.level === "fail")?.code ?? "unknown"
  return { allowed: true, reason: `quality-fail-${firstFailCode.replace(/:/g, "-")}` }
}

// 복구 재시도가 generation을 남기지 못하고 끝났을 때 그 시도를 "1회 소진"으로 볼 것인가.
// 기준은 하나 — provider 호출이 실제로 시작됐는가. Batch와 단건 경로가 이 함수를 공유한다.
//  - generated: 재시도 generation이 남음 → 소진 (generation 계층에서도 잡힌다)
//  - failed: provider를 호출했고 응답·검증에서 실패 → 소진 (실패 레코드에 retry 감사 기록을 남긴다)
//  - misconfigured: API 키·provider 설정 오류로 호출 전 차단 → 부작용이 전혀 없으므로 소진 아님
//  - busy: 같은 장소 생성이 진행 중이라 잠금에 막힘 → 시도 자체가 없었으므로 소진 아님
//  - recent-preview: 복구 재시도 경로는 이 가드를 우회하므로 발생하지 않는다 (도달 시 보수적으로 소진 아님)
export type RetryAttemptOutcomeKind = "generated" | "failed" | "misconfigured" | "busy" | "recent-preview"

export function isRetryAttemptConsumed(kind: RetryAttemptOutcomeKind): boolean {
  return kind === "generated" || kind === "failed"
}

// 원본 generation을 처리한 Batch item에서 읽는 재시도 소진 흔적.
export type BatchRetryConsumptionRow = {
  readonly generationId: string | null
  readonly retryGenerationId: string | null
  readonly lastErrorCode: string | null
  readonly lastErrorMessage: string | null
}

// 이 item이 제어 재시도를 이미 소진했는가 — 재시도 generation이 남지 않은 실패도 소진으로 본다.
// (재시도 generation 없이 끝났다고 다시 허용하면 시간 경과 뒤 2회차 재시도가 열린다.)
export function isBatchItemRetryConsumed(row: BatchRetryConsumptionRow): boolean {
  if (row.retryGenerationId !== null) {
    return true
  }
  if (row.lastErrorCode?.startsWith(BATCH_RETRY_ERROR_CODE_PREFIX) === true) {
    return true
  }
  return row.lastErrorMessage?.startsWith(BATCH_RETRY_FAILURE_MESSAGE_PREFIX) === true
}

// 내구적 소진 횟수 — generation 계층(output.retry.of)과 Batch item 흔적 중 큰 값.
// 재시도 generation이 남은 Batch 실행은 양쪽에 모두 잡히므로 합산하지 않는다.
export function countConsumedQualityFailRetries(
  input: Readonly<{ generationId: string; retryGenerationCount: number; batchItems: readonly BatchRetryConsumptionRow[] }>,
): number {
  const batchConsumed = input.batchItems.filter((row) => row.generationId === input.generationId && isBatchItemRetryConsumed(row)).length
  return Math.max(input.retryGenerationCount, batchConsumed)
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
