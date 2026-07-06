import type { SyncRunStatus } from "@/lib/domain/constants"
import type { SyncErrorTableRow, SyncRunTableRow } from "@/types/database"

const KST_DATE_FORMATTER = new Intl.DateTimeFormat("sv-SE", {
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  month: "2-digit",
  timeZone: "Asia/Seoul",
  year: "numeric",
})

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
  title: "Latest fixture sync",
  status: "completed",
  finishedAt: "2026-07-03 09:30 KST",
  totalRows: 3,
  message: "Fixture import completed without live Supabase, auth, or Google Sheets credentials.",
  counts: [
    { label: "Inserted", value: 2, tone: "accent" },
    { label: "Updated", value: 0, tone: "neutral" },
    { label: "Skipped", value: 0, tone: "warning" },
    { label: "Failed", value: 1, tone: "error" },
  ],
  errors: [{ sheetName: "기업 DB", rowLabel: "Row 4", code: "invalid_shape", message: "Required company name is missing" }],
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
    return { ...FIXTURE_SYNC_STATUS, source: "supabase", title: "No sync runs yet", message: "No Supabase sync run has been recorded yet.", errors: [], recentRuns: [], coverage: await repository.coverage() }
  }

  const [coverage, errors, recentRuns] = await Promise.all([repository.coverage(), repository.listErrors(latestRun.id), repository.listRecentRuns()])
  return syncRunToStatus(latestRun, errors, recentRuns, coverage)
}

function syncRunToStatus(run: SyncRunTableRow, errors: readonly SyncErrorTableRow[], recentRuns: readonly SyncRunTableRow[], coverage: SyncCoverageStatus): AdminSyncStatus {
  return {
    source: "supabase",
    title: "Latest Supabase sync",
    status: run.status,
    finishedAt: formatKstDateTime(run.finished_at ?? run.started_at),
    totalRows: run.total_rows,
    message: run.message ?? "Latest sync run loaded from Supabase.",
    counts: [
      { label: "Inserted", value: run.inserted_count, tone: "accent" },
      { label: "Updated", value: run.updated_count, tone: "neutral" },
      { label: "Skipped", value: run.skipped_count, tone: "warning" },
      { label: "Failed", value: run.failed_count, tone: "error" },
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
    startedAt: formatKstDateTime(run.started_at),
    finishedAt: run.finished_at === null ? "Still running" : formatKstDateTime(run.finished_at),
    totalRows: run.total_rows,
    inserted: run.inserted_count,
    updated: run.updated_count,
    failed: run.failed_count,
  }
}

function formatKstDateTime(value: string): string {
  return `${KST_DATE_FORMATTER.format(new Date(value))} KST`
}

function syncErrorToListRow(error: SyncErrorTableRow): SyncErrorListRow {
  return {
    sheetName: error.source_sheet_name ?? "Unknown sheet",
    rowLabel: error.source_row_number === null ? "Unknown row" : `Row ${String(error.source_row_number)}`,
    code: error.error_code ?? "unknown_error",
    message: error.error_message ?? "No error message recorded",
  }
}
