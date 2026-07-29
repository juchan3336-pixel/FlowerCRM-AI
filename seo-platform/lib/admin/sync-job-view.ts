// 자동 연속 동기화 진행 표시용 순수 뷰 모델.
//
// 사용자에게는 개별 job이 아니라 하나의 "동기화 세션"으로 보여야 한다 — 5,000행 상한에 닿으면
// 서버가 후속 job을 자동으로 만들지만, 그건 내부 사정이지 사용자가 신경 쓸 일이 아니다.
// 그래서 세션(root 기준) 누적값을 기본으로 표시하고, 현재 job 번호는 보조 정보로만 둔다.
import {
  RESUMABLE_SYNC_JOB_STATUSES,
  SESSION_STOP_MESSAGES,
  SYNC_JOB_MAX_BATCHES,
  SYNC_SESSION_MAX_AUTO_JOBS,
  SYNC_SESSION_MAX_ROWS,
  type SessionStopReason,
  type SyncJobStatus,
} from "@/lib/sync/job-policy"
import { formatKstDateTime } from "./time"

export type SyncJobViewInput = {
  readonly id: string
  readonly status: SyncJobStatus
  readonly batchSize: number
  readonly startRow: number
  readonly currentRow: number
  readonly targetLastRow: number
  readonly latestSheetRow: number
  readonly batchIndex: number
  readonly processedCount: number
  readonly insertedCount: number
  readonly updatedCount: number
  readonly skippedCount: number
  readonly failedCount: number
  readonly remainingCount: number
  readonly chainIndex: number
  readonly autoContinued: boolean
  readonly sessionStartedAt: string
  readonly totalSessionProcessed: number
  readonly maxAutoJobs: number
  readonly cancelRequested: boolean
  readonly sessionStopReason: SessionStopReason | null
  readonly startedAt: string
  readonly lastTickAt: string | null
  readonly finishedAt: string | null
  readonly lastErrorCode: string | null
}

// 세션 누적 — 같은 root의 모든 job을 합산한 값. 현재 job만으로는 이전 job의 삽입·실패 수를 알 수 없다.
export type SyncSessionTotals = {
  readonly jobCount: number
  readonly insertedCount: number
  readonly updatedCount: number
  readonly skippedCount: number
  readonly failedCount: number
  readonly failedRowNumbers: readonly number[]
}

export type SyncJobView = {
  readonly id: string
  readonly status: SyncJobStatus
  readonly statusLabel: string
  readonly active: boolean
  readonly resumable: boolean
  readonly cancellable: boolean
  // ── 세션 표시 ──
  readonly sessionJobLabel: string
  readonly sessionProcessedCount: number
  readonly sessionInsertedCount: number
  readonly sessionUpdatedCount: number
  readonly sessionSkippedCount: number
  readonly sessionFailedCount: number
  readonly failedRowNumbers: readonly number[]
  readonly hasFailedRows: boolean
  readonly failedRowsLabel: string
  readonly safetyLimitLabel: string
  readonly sessionStartedAtLabel: string
  // ── 커서 ──
  readonly sheetDataRows: number
  readonly syncedRows: number
  readonly remainingRows: number
  readonly cursorLabel: string
  readonly batchLabel: string
  readonly lastRowLabel: string
  readonly startedAtLabel: string
  readonly lastTickAtLabel: string
  readonly finishedAtLabel: string
  readonly autoContinuing: boolean
  readonly noticeMessage: string
}

const STATUS_LABELS: Readonly<Record<SyncJobStatus, string>> = {
  queued: "접수됨",
  running: "진행 중",
  completed: "완료",
  partial_completed: "부분 완료",
  failed: "오류",
  cancelled: "중단됨",
  interrupted: "정체됨",
}

// 사용자에게 보여줄 안내 — 내부 코드·스택·시트 원문을 담지 않는다.
const ERROR_NOTICES: Readonly<Record<string, string>> = {
  "chain-dispatch-failed": "자동 연속 처리가 중간에 끊겼습니다. 처리된 분량은 그대로 남아 있으니 '이어서 진행'으로 계속하세요.",
  "sheet-read-failed": "Google Sheets를 읽지 못해 중단했습니다. 시트 공유 상태를 확인한 뒤 '이어서 진행'으로 계속하세요.",
  "batch-failed": "동기화 배치 처리 중 오류가 발생해 중단했습니다. 원인을 확인한 뒤 '이어서 진행'으로 계속하세요.",
}

export function toSyncJobView(job: SyncJobViewInput, session?: SyncSessionTotals): SyncJobView {
  const active = job.status === "queued" || job.status === "running"
  const totals = session ?? {
    jobCount: job.chainIndex + 1,
    insertedCount: job.insertedCount,
    updatedCount: job.updatedCount,
    skippedCount: job.skippedCount,
    failedCount: job.failedCount,
    failedRowNumbers: [],
  }
  // 상한 도달로 job이 닫혔지만 세션은 자동으로 이어지는 중 — 사용자에게는 계속 진행 중으로 보여야 한다.
  const autoContinuing = job.status === "partial_completed" && job.sessionStopReason === null && job.remainingCount > 0

  return {
    id: job.id,
    status: job.status,
    statusLabel: autoContinuing ? "진행 중" : STATUS_LABELS[job.status],
    active,
    // 재개 버튼은 오류·정체·전역 상한(취소 포함)에서만 뜬다.
    // 정상 backlog로 자동 후속 job이 이어지는 중에는 절대 노출하지 않는다.
    resumable: !autoContinuing && RESUMABLE_SYNC_JOB_STATUSES.includes(job.status) && job.remainingCount > 0,
    cancellable: active && !job.cancelRequested,

    sessionJobLabel: `${String(job.chainIndex + 1)} / 최대 ${String(job.maxAutoJobs + 1)}`,
    sessionProcessedCount: job.totalSessionProcessed,
    sessionInsertedCount: totals.insertedCount,
    sessionUpdatedCount: totals.updatedCount,
    sessionSkippedCount: totals.skippedCount,
    sessionFailedCount: totals.failedCount,
    failedRowNumbers: totals.failedRowNumbers,
    hasFailedRows: totals.failedCount > 0,
    failedRowsLabel: failedRowsLabelFor(totals),
    safetyLimitLabel: `작업 ${String(SYNC_SESSION_MAX_AUTO_JOBS + 1)}개 · ${SYNC_SESSION_MAX_ROWS.toLocaleString("ko-KR")}행 · 6시간`,
    sessionStartedAtLabel: formatKstDateTime(job.sessionStartedAt),

    sheetDataRows: dataRowCount(job.latestSheetRow),
    syncedRows: Math.max(0, dataRowCount(job.currentRow - 1)),
    remainingRows: job.remainingCount,
    cursorLabel: `Row ${String(job.currentRow)} / ${String(job.latestSheetRow)}`,
    batchLabel: `${String(job.batchIndex)} / 최대 ${String(SYNC_JOB_MAX_BATCHES)}`,
    lastRowLabel: job.currentRow <= job.startRow ? "-" : `Row ${String(job.currentRow - 1)}`,
    startedAtLabel: formatKstDateTime(job.startedAt),
    lastTickAtLabel: job.lastTickAt === null ? "-" : formatKstDateTime(job.lastTickAt),
    finishedAtLabel: job.finishedAt === null ? (active ? "진행 중" : "-") : formatKstDateTime(job.finishedAt),
    autoContinuing,
    noticeMessage: noticeFor(job, active, autoContinuing),
  }
}

// 실패 행은 건수와 함께 행 번호를 보여줘야 어디를 고쳐야 할지 알 수 있다.
// 많으면 앞쪽 일부만 나열한다 (화면이 실패 목록으로 뒤덮이지 않게).
const FAILED_ROW_PREVIEW_LIMIT = 20

function failedRowsLabelFor(totals: SyncSessionTotals): string {
  if (totals.failedCount === 0) {
    return "없음"
  }
  if (totals.failedRowNumbers.length === 0) {
    return `${String(totals.failedCount)}건 (행 번호는 아래 동기화 오류 목록 참조)`
  }
  const preview = totals.failedRowNumbers.slice(0, FAILED_ROW_PREVIEW_LIMIT)
  const suffix = totals.failedRowNumbers.length > FAILED_ROW_PREVIEW_LIMIT ? ` 외 ${String(totals.failedRowNumbers.length - FAILED_ROW_PREVIEW_LIMIT)}건` : ""
  return `${String(totals.failedCount)}건 — Row ${preview.map(String).join(", ")}${suffix}`
}

function dataRowCount(lastRowNumber: number): number {
  return Math.max(0, lastRowNumber - 1)
}

function noticeFor(job: SyncJobViewInput, active: boolean, autoContinuing: boolean): string {
  if (job.cancelRequested && active) {
    return "중단을 요청했습니다. 진행 중인 배치까지만 처리하고 멈춥니다 — 처리된 분량은 유지됩니다."
  }
  if (autoContinuing) {
    return "작업 상한에 도달해 서버가 다음 작업을 자동으로 이어가고 있습니다. 추가 클릭은 필요하지 않습니다."
  }
  if (active) {
    return "서버가 50건 단위로 계속 처리하고 있습니다. 이 화면을 닫아도 동기화는 계속됩니다."
  }
  if (job.status === "completed") {
    return failedTail("미동기화 신규 행을 모두 반영했습니다. 잔여 0건입니다.", job)
  }
  if (job.sessionStopReason !== null) {
    return failedTail(SESSION_STOP_MESSAGES[job.sessionStopReason], job)
  }
  if (job.lastErrorCode !== null && job.lastErrorCode in ERROR_NOTICES) {
    return failedTail(ERROR_NOTICES[job.lastErrorCode] ?? "", job)
  }
  return failedTail(job.remainingCount > 0 ? "잔여 행이 남아 있습니다. '이어서 진행'으로 계속하세요." : "처리가 끝났습니다.", job)
}

// 실패 행이 있으면 완료 상태에서도 반드시 함께 알린다 — 조용히 넘어가면 누락을 못 본다.
function failedTail(message: string, job: SyncJobViewInput): string {
  return job.failedCount > 0 ? `${message} 형식 오류로 건너뛴 행이 있어 재처리가 필요합니다 (아래 동기화 오류 목록 참조).` : message
}

// ── 시작 결과 안내 ───────────────────────────────────────────────
export function syncJobNoticeMessage(job: string | undefined, reason: string | undefined, remaining: number): string | undefined {
  switch (job) {
    case "started":
      return `자동 연속 동기화를 시작했습니다. 잔여 ${String(remaining)}건을 50건 단위로 계속 처리합니다 — 상한에 닿으면 서버가 다음 작업을 자동으로 이어가고, 화면을 닫아도 진행됩니다.`
    case "resumed":
      return `이어서 진행을 시작했습니다. 잔여 ${String(remaining)}건을 50건 단위로 계속 처리합니다.`
    case "cancelled":
      return "중단을 요청했습니다. 진행 중인 배치까지만 처리하고 멈춥니다."
    case "already-active":
      return "이미 자동 동기화가 진행 중입니다. 진행 상황은 아래 카드에서 확인하세요."
    case "nothing-to-sync":
      return "미동기화 신규 행이 없습니다. 잔여 0건입니다."
    case "missing-env":
      return "Google Sheets 동기화가 아직 설정되지 않아 시작하지 못했습니다."
    case "failed":
      return syncJobFailureMessage(reason)
    default:
      return undefined
  }
}

function syncJobFailureMessage(reason: string | undefined): string {
  switch (reason) {
    case "unknown-job":
      return "대상 작업을 찾지 못해 시작하지 못했습니다. 화면을 새로 고친 뒤 다시 시도하세요."
    case "resume-conflict":
      return "다른 처리가 먼저 진행돼 이어서 진행하지 못했습니다. 화면을 새로 고친 뒤 다시 시도하세요."
    case "create-failed":
      return "작업을 만들지 못했습니다. 잠시 후 다시 시도하세요."
    case "not-active":
      return "이미 종료된 작업이라 중단할 수 없습니다."
    default:
      return "자동 연속 동기화를 시작하지 못했습니다. 잠시 후 다시 시도하세요."
  }
}
