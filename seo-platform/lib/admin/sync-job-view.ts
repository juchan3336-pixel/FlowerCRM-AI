// 자동 연속 동기화 진행 표시용 순수 뷰 모델.
// 렌더링 컴포넌트가 계산을 하지 않도록 라벨·수치·버튼 가용성을 여기서 전부 확정한다 (테스트 가능).
import { RESUMABLE_SYNC_JOB_STATUSES, SYNC_JOB_MAX_BATCHES, type SyncJobStatus } from "@/lib/sync/job-policy"
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
  readonly startedAt: string
  readonly lastTickAt: string | null
  readonly finishedAt: string | null
  readonly lastErrorCode: string | null
}

export type SyncJobView = {
  readonly id: string
  readonly status: SyncJobStatus
  readonly statusLabel: string
  readonly active: boolean
  readonly resumable: boolean
  // 시트 전체 데이터 행 수 (헤더 제외)
  readonly sheetDataRows: number
  // Supabase에 반영이 끝난 행 수 (커서 기준)
  readonly syncedRows: number
  readonly remainingRows: number
  readonly batchLabel: string
  readonly processedCount: number
  readonly insertedCount: number
  readonly updatedCount: number
  readonly skippedCount: number
  readonly failedCount: number
  readonly lastRowLabel: string
  readonly startedAtLabel: string
  readonly lastTickAtLabel: string
  readonly finishedAtLabel: string
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
  "batch-limit": `한 번에 처리할 수 있는 상한(${String(SYNC_JOB_MAX_BATCHES)}배치)에 도달해 여기까지 처리했습니다. 잔여분은 '이어서 진행'으로 계속하세요.`,
  "chain-dispatch-failed": "자동 연속 처리가 중간에 끊겼습니다. 처리된 분량은 그대로 남아 있으니 '이어서 진행'으로 계속하세요.",
  "sheet-read-failed": "Google Sheets를 읽지 못해 중단했습니다. 시트 공유 상태를 확인한 뒤 '이어서 진행'으로 계속하세요.",
  "batch-failed": "동기화 배치 처리 중 오류가 발생해 중단했습니다. 원인을 확인한 뒤 '이어서 진행'으로 계속하세요.",
}

export function toSyncJobView(job: SyncJobViewInput): SyncJobView {
  const active = job.status === "queued" || job.status === "running"
  return {
    id: job.id,
    status: job.status,
    statusLabel: STATUS_LABELS[job.status],
    active,
    // 잔여가 남아 있고 종료 상태일 때만 재개할 수 있다 (완료된 job에 재개 버튼을 띄우지 않는다).
    resumable: RESUMABLE_SYNC_JOB_STATUSES.includes(job.status) && job.remainingCount > 0,
    sheetDataRows: dataRowCount(job.latestSheetRow),
    syncedRows: Math.max(0, dataRowCount(job.currentRow - 1)),
    remainingRows: job.remainingCount,
    batchLabel: `${String(job.batchIndex)} / 최대 ${String(SYNC_JOB_MAX_BATCHES)}`,
    processedCount: job.processedCount,
    insertedCount: job.insertedCount,
    updatedCount: job.updatedCount,
    skippedCount: job.skippedCount,
    failedCount: job.failedCount,
    lastRowLabel: job.currentRow <= job.startRow ? "-" : `Row ${String(job.currentRow - 1)}`,
    startedAtLabel: formatKstDateTime(job.startedAt),
    lastTickAtLabel: job.lastTickAt === null ? "-" : formatKstDateTime(job.lastTickAt),
    finishedAtLabel: job.finishedAt === null ? (active ? "진행 중" : "-") : formatKstDateTime(job.finishedAt),
    noticeMessage: noticeFor(job, active),
  }
}

function dataRowCount(lastRowNumber: number): number {
  return Math.max(0, lastRowNumber - 1)
}

function noticeFor(job: SyncJobViewInput, active: boolean): string {
  if (active) {
    return "서버가 50건 단위로 계속 처리하고 있습니다. 이 화면을 닫아도 동기화는 계속됩니다."
  }
  if (job.status === "completed") {
    return "미동기화 신규 행을 모두 반영했습니다. 잔여 0건입니다."
  }
  if (job.lastErrorCode !== null && job.lastErrorCode in ERROR_NOTICES) {
    return ERROR_NOTICES[job.lastErrorCode] ?? ""
  }
  return job.remainingCount > 0 ? "잔여 행이 남아 있습니다. '이어서 진행'으로 계속하세요." : "처리가 끝났습니다."
}

// ── 시작 결과 안내 ───────────────────────────────────────────────
export function syncJobNoticeMessage(job: string | undefined, reason: string | undefined, remaining: number): string | undefined {
  switch (job) {
    case "started":
      return `자동 연속 동기화를 시작했습니다. 잔여 ${String(remaining)}건을 50건 단위로 계속 처리합니다 — 화면을 닫아도 진행됩니다.`
    case "resumed":
      return `이어서 진행을 시작했습니다. 잔여 ${String(remaining)}건을 50건 단위로 계속 처리합니다.`
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
    default:
      return "자동 연속 동기화를 시작하지 못했습니다. 잠시 후 다시 시도하세요."
  }
}
