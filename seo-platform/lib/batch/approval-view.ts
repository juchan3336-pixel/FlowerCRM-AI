// 승인 Batch 자동 실행 v1 — 승인 이력 표시 정책 (PR-C).
// 상태 라벨·경고 문구·취소 가능 여부만 담는 순수 계층 (DB·네트워크 없음).
import type { BatchApprovalStatus } from "@/types/database"

export type ApprovalTone = "accent" | "warning" | "neutral" | "muted"

export const APPROVAL_STATUS_LABELS: Readonly<Record<BatchApprovalStatus, string>> = {
  approved: "승인됨",
  queued: "실행 준비",
  running: "자동 생성 중",
  completed: "완료",
  failed: "실패",
  expired: "만료",
  cancelled: "취소됨",
}

export function describeApprovalStatus(status: BatchApprovalStatus): { readonly label: string; readonly tone: ApprovalTone } {
  switch (status) {
    case "completed":
      return { label: APPROVAL_STATUS_LABELS.completed, tone: "accent" }
    case "running":
    case "queued":
      return { label: APPROVAL_STATUS_LABELS[status], tone: "neutral" }
    case "failed":
    case "expired":
      return { label: APPROVAL_STATUS_LABELS[status], tone: "warning" }
    case "cancelled":
      return { label: APPROVAL_STATUS_LABELS.cancelled, tone: "muted" }
    default:
      return { label: APPROVAL_STATUS_LABELS.approved, tone: "neutral" }
  }
}

// 승인 행 중 경고 판정에 필요한 최소 필드만 받는다.
export type ApprovalWarningInput = {
  readonly status: BatchApprovalStatus
  readonly batchRunId: string | null
  readonly lastErrorCode: string | null
}

export type ApprovalWarning = {
  readonly kind: "start-interrupted" | "chain-stalled" | "expired" | "failed"
  readonly message: string
}

// 운영자가 바로 판단할 수 있는 경고만 반환한다 — 정상 진행 중에는 null.
export function approvalWarning(input: ApprovalWarningInput): ApprovalWarning | null {
  if (input.status === "running" && input.batchRunId === null) {
    // activate와 batch_run 연결 사이에서 프로세스가 죽은 경우 — 자동 재활성화는 금지된 상태다.
    return { kind: "start-interrupted", message: "실행 시작 중단 — 취소 후 새 승인이 필요합니다" }
  }
  if (input.status === "running" && input.lastErrorCode === "chain-dispatch-failed") {
    return { kind: "chain-stalled", message: "자동 진행이 멈췄습니다 — 이어서 진행하거나 취소 후 새 승인이 필요합니다" }
  }
  if (input.status === "expired") {
    return { kind: "expired", message: "승인 유효시간이 지나 실행할 수 없습니다 — 새로 승인해 주세요" }
  }
  if (input.status === "failed") {
    return { kind: "failed", message: "자동 실행이 실패했습니다 — 사유를 확인한 뒤 새로 승인해 주세요" }
  }
  return null
}

// 취소 가능 범위 — 저장소의 cancelApproval 조건(approved/queued/running)과 일치시킨다.
// completed·failed·expired·cancelled는 종료 상태라 취소할 수 없다.
export function canCancelApproval(status: BatchApprovalStatus): boolean {
  return status === "approved" || status === "queued" || status === "running"
}

// chain이 끊겨 정체된 running 승인만 "이어서 진행" 대상이다 (batch_run이 연결된 경우에 한함).
// 전체 재실행이 아니라 현재 execution_tick 기준 tick 1회만 재발사한다.
export function canResumeApproval(input: ApprovalWarningInput): boolean {
  return input.status === "running" && input.batchRunId !== null && input.lastErrorCode === "chain-dispatch-failed"
}

// last_error_code를 사용자 문구로 — 알 수 없는 코드는 원문 대신 일반 문구로 감싼다(내부 코드 노출 최소화).
const ERROR_CODE_LABELS: Readonly<Record<string, string>> = {
  "chain-dispatch-failed": "자동 진행 요청 실패",
  preflight: "승인 후 장소 정보가 바뀌어 중단",
  "start-failed": "생성 배치 시작 실패",
  "kick-failed": "실행 서버 호출 실패",
  internal: "내부 오류",
}

export function describeApprovalError(code: string | null): string | null {
  if (code === null || code.trim().length === 0) {
    return null
  }
  const key = code.split(":")[0] ?? code
  return ERROR_CODE_LABELS[key] ?? "실행 오류"
}
