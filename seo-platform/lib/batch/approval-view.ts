// 승인 Batch 자동 실행 — 승인 이력 표시 정책.
// 상태 라벨·경고 문구·취소 가능 여부·자동 생성 상태만 담는 순수 계층 (DB·네트워크 없음).
import { BATCH_PUMP_DELAY_WARN_MS, BATCH_PUMP_INTERVAL_SECONDS } from "./approval-execution-policy"
import type { BatchApprovalStatus } from "@/types/database"

export type ApprovalTone = "accent" | "warning" | "neutral" | "muted"

export const APPROVAL_STATUS_LABELS: Readonly<Record<BatchApprovalStatus, string>> = {
  approved: "승인됨",
  queued: "대기 중",
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
  // 자동 생성(pump)이 정상 대기 범위를 넘겼는지 — 정상 대기를 경고로 표시하지 않기 위한 구분.
  readonly pumpDelayed?: boolean
}

export type ApprovalWarning = {
  readonly kind: "start-interrupted" | "stalled" | "expired" | "failed"
  readonly message: string
}

// 운영자가 바로 판단할 수 있는 경고만 반환한다 — 정상 진행 중에는 null.
export function approvalWarning(input: ApprovalWarningInput): ApprovalWarning | null {
  if (input.status === "running" && input.batchRunId === null) {
    // activate와 batch_run 연결 사이에서 프로세스가 죽은 경우 — 자동 재활성화는 금지된 상태다.
    return { kind: "start-interrupted", message: "실행 시작 중단 — 취소 후 새 승인이 필요합니다" }
  }
  // 자동 생성이 오래 멈춰 있을 때만 경고한다. 1분 주기의 정상 대기는 경고가 아니다.
  // (예전에는 발사 실패 표식 하나로 "이어서 진행"을 유도했지만, 그 표식은 실제 정체와 무관할 때가 많았고
  //  정작 508로 진짜 멈춘 경우에는 표식조차 남지 않아 아무 안내도 뜨지 않았다.)
  if (input.status === "running" && input.pumpDelayed === true) {
    return { kind: "stalled", message: "자동 생성이 지연되고 있습니다 — 처리된 분량은 유지됩니다. 예약 작업(Cron) 상태를 확인해 주세요" }
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

// ── 자동 생성(Cron pump) 상태 ────────────────────────────────────
// 1분 주기의 정상 대기를 오류처럼 보이게 하면 안 된다. 그래서 세 가지를 구분한다:
//  · busy    — lease가 살아 있다 = 지금 생성 중
//  · waiting — lease가 없다 = 다음 Cron 호출을 기다린다 (정상)
//  · delayed — 마지막 진행 이후 lease 유효시간 + Cron 주기를 넘겼다 = 스케줄러가 멈췄을 수 있다
export type ApprovalPumpInput = {
  readonly status: BatchApprovalStatus
  readonly leaseExpiresAt: string | null
  readonly lastTickAt: string | null
  readonly pumpAttempt: number
  readonly nowIso: string
}

export type ApprovalPumpState = {
  readonly busy: boolean
  readonly delayed: boolean
  readonly stateLabel: string
  readonly attemptLabel: string
  readonly leaseExpiresAt: string | null
}

export function describeApprovalPump(input: ApprovalPumpInput): ApprovalPumpState {
  const attemptLabel = `${String(input.pumpAttempt)}회`
  if (input.status !== "running") {
    return { busy: false, delayed: false, stateLabel: "자동 생성 없음", attemptLabel, leaseExpiresAt: null }
  }
  const nowMs = Date.parse(input.nowIso)
  const leaseMs = input.leaseExpiresAt === null ? null : Date.parse(input.leaseExpiresAt)
  if (leaseMs !== null && Number.isFinite(leaseMs) && leaseMs > nowMs) {
    return { busy: true, delayed: false, stateLabel: "AI 생성 처리 중", attemptLabel, leaseExpiresAt: input.leaseExpiresAt }
  }
  const lastMs = input.lastTickAt === null ? null : Date.parse(input.lastTickAt)
  const delayed = lastMs !== null && Number.isFinite(lastMs) && nowMs - lastMs >= BATCH_PUMP_DELAY_WARN_MS
  if (delayed) {
    return { busy: false, delayed: true, stateLabel: "자동 생성 지연", attemptLabel, leaseExpiresAt: null }
  }
  return {
    busy: false,
    delayed: false,
    stateLabel: `다음 자동 생성 대기 (약 ${String(BATCH_PUMP_INTERVAL_SECONDS)}초 주기)`,
    attemptLabel,
    leaseExpiresAt: null,
  }
}

// last_error_code를 사용자 문구로 — 알 수 없는 코드는 원문 대신 일반 문구로 감싼다(내부 코드 노출 최소화).
const ERROR_CODE_LABELS: Readonly<Record<string, string>> = {
  // 예전 self-chain 구조가 남긴 코드 — 새 구조는 만들지 않지만 기존 기록을 읽어야 한다.
  "chain-dispatch-failed": "이전 자동 진행 구조에서 중단",
  "kick-status-unknown": "실행 서버 응답 확인 실패",
  "tick-limit": "실행 횟수 상한 도달",
  preflight: "승인 후 장소 정보가 바뀌어 중단",
  "start-failed": "생성 배치 시작 실패",
  "kick-failed": "실행 서버 호출 실패",
  "run-failed": "생성 배치 실패",
  internal: "내부 오류",
}

export function describeApprovalError(code: string | null): string | null {
  if (code === null || code.trim().length === 0) {
    return null
  }
  const key = code.split(":")[0] ?? code
  return ERROR_CODE_LABELS[key] ?? "실행 오류"
}
