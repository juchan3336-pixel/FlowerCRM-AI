import type { SyncRunStatus } from "@/lib/domain/constants"
import type { SyncErrorTableRow, SyncRunTableRow } from "@/types/database"
import { formatKstDateTime as formatKstDateTimeInSeoul } from "./time"

export type SyncCountCard = {
  readonly label: string
  readonly value: number
  readonly tone: "accent" | "neutral" | "warning" | "error"
}

export type SyncErrorListRow = {
  readonly sheetName: string
  readonly rowLabel: string
  readonly code: string
  readonly message: string
}

export type SyncRunListRow = {
  readonly id: string
  readonly status: SyncRunStatus
  readonly startedAt: string
  readonly finishedAt: string
  readonly totalRows: number
  readonly inserted: number
  readonly updated: number
  readonly failed: number
}

export type SyncCoverageStatus = {
  readonly importedPlaces: number
  readonly latestSourceRowNumber: number | null
  readonly openRunningRuns: number
  readonly missingSourceRows: readonly number[]
}

export type AdminSyncStatus = {
  readonly source: "fixture" | "supabase"
  readonly title: string
  readonly status: SyncRunStatus
  readonly finishedAt: string
  readonly totalRows: number
  readonly message: string
  readonly counts: readonly SyncCountCard[]
  readonly errors: readonly SyncErrorListRow[]
  readonly recentRuns: readonly SyncRunListRow[]
  readonly coverage: SyncCoverageStatus
}

export interface AdminSyncRepository {
  latestRun(): Promise<SyncRunTableRow | null>
  listRecentRuns(): Promise<readonly SyncRunTableRow[]>
  listErrors(syncRunId: string): Promise<readonly SyncErrorTableRow[]>
  coverage(): Promise<SyncCoverageStatus>
}

const FIXTURE_SYNC_STATUS = {
  source: "fixture",
  title: "최신 fixture 동기화",
  status: "completed",
  finishedAt: "2026-07-03 09:30 KST",
  totalRows: 3,
  message: "fixture 가져오기는 live Supabase, auth, Google Sheets 자격 증명 없이 완료되었습니다.",
  counts: [
    { label: "삽입", value: 2, tone: "accent" },
    { label: "갱신", value: 0, tone: "neutral" },
    { label: "제외", value: 0, tone: "warning" },
    { label: "실패", value: 1, tone: "error" },
  ],
  errors: [{ sheetName: "기업 DB", rowLabel: "Row 4", code: "invalid_shape", message: "필수 회사명이 없습니다" }],
  coverage: { importedPlaces: 2, latestSourceRowNumber: 4, openRunningRuns: 0, missingSourceRows: [3] },
  recentRuns: [
    {
      id: "fixture-sync-run-1",
      status: "completed",
      startedAt: "2026-07-03 09:29 KST",
      finishedAt: "2026-07-03 09:30 KST",
      totalRows: 3,
      inserted: 2,
      updated: 0,
      failed: 1,
    },
  ],
} as const satisfies AdminSyncStatus

export async function loadAdminSync(repository?: AdminSyncRepository): Promise<AdminSyncStatus> {
  if (repository === undefined) {
    return FIXTURE_SYNC_STATUS
  }

  const latestRun = await repository.latestRun()
  if (latestRun === null) {
    return { ...FIXTURE_SYNC_STATUS, source: "supabase", title: "아직 동기화 실행이 없습니다", message: "아직 기록된 Supabase 동기화 실행이 없습니다.", errors: [], recentRuns: [], coverage: await repository.coverage() }
  }

  const [coverage, errors, recentRuns] = await Promise.all([repository.coverage(), repository.listErrors(latestRun.id), repository.listRecentRuns()])
  return syncRunToStatus(latestRun, errors, recentRuns, coverage)
}

function syncRunToStatus(run: SyncRunTableRow, errors: readonly SyncErrorTableRow[], recentRuns: readonly SyncRunTableRow[], coverage: SyncCoverageStatus): AdminSyncStatus {
  return {
    source: "supabase",
    title: "최신 Supabase 동기화",
    status: run.status,
    finishedAt: formatKstDateTimeInSeoul(run.finished_at ?? run.started_at),
    totalRows: run.total_rows,
    message: run.message ?? "최신 동기화 실행을 Supabase에서 불러왔습니다.",
    counts: [
      { label: "삽입", value: run.inserted_count, tone: "accent" },
      { label: "갱신", value: run.updated_count, tone: "neutral" },
      { label: "제외", value: run.skipped_count, tone: "warning" },
      { label: "실패", value: run.failed_count, tone: "error" },
    ],
    errors: errors.map(syncErrorToListRow),
    recentRuns: recentRuns.map(syncRunToListRow),
    coverage,
  }
}

function syncRunToListRow(run: SyncRunTableRow): SyncRunListRow {
  return {
    id: run.id,
    status: run.status,
    startedAt: formatKstDateTimeInSeoul(run.started_at),
    finishedAt: run.finished_at === null ? "진행 중" : formatKstDateTimeInSeoul(run.finished_at),
    totalRows: run.total_rows,
    inserted: run.inserted_count,
    updated: run.updated_count,
    failed: run.failed_count,
  }
}

function syncErrorToListRow(error: SyncErrorTableRow): SyncErrorListRow {
  return {
    sheetName: error.source_sheet_name ?? "알 수 없는 시트",
    rowLabel: error.source_row_number === null ? "알 수 없는 행" : `Row ${String(error.source_row_number)}`,
    code: error.error_code ?? "unknown_error",
    message: error.error_message ?? "기록된 오류 메시지가 없습니다",
  }
}
