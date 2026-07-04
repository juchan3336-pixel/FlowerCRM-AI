import type { SyncRunStatus } from "@/lib/domain/constants"
import type { SyncErrorTableRow, SyncRunTableRow } from "@/types/database"

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

export type AdminSyncStatus = {
  readonly source: "fixture" | "supabase"
  readonly title: string
  readonly status: SyncRunStatus
  readonly finishedAt: string
  readonly totalRows: number
  readonly message: string
  readonly counts: readonly SyncCountCard[]
  readonly errors: readonly SyncErrorListRow[]
}

export interface AdminSyncRepository {
  latestRun(): Promise<SyncRunTableRow | null>
  listErrors(syncRunId: string): Promise<readonly SyncErrorTableRow[]>
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
} as const satisfies AdminSyncStatus

export async function loadAdminSync(repository?: AdminSyncRepository): Promise<AdminSyncStatus> {
  if (repository === undefined) {
    return FIXTURE_SYNC_STATUS
  }

  const latestRun = await repository.latestRun()
  if (latestRun === null) {
    return { ...FIXTURE_SYNC_STATUS, source: "supabase", title: "No sync runs yet", message: "No Supabase sync run has been recorded yet.", errors: [] }
  }

  const errors = await repository.listErrors(latestRun.id)
  return syncRunToStatus(latestRun, errors)
}

function syncRunToStatus(run: SyncRunTableRow, errors: readonly SyncErrorTableRow[]): AdminSyncStatus {
  return {
    source: "supabase",
    title: "Latest Supabase sync",
    status: run.status,
    finishedAt: run.finished_at ?? run.started_at,
    totalRows: run.total_rows,
    message: run.message ?? "Latest sync run loaded from Supabase.",
    counts: [
      { label: "Inserted", value: run.inserted_count, tone: "accent" },
      { label: "Updated", value: run.updated_count, tone: "neutral" },
      { label: "Skipped", value: run.skipped_count, tone: "warning" },
      { label: "Failed", value: run.failed_count, tone: "error" },
    ],
    errors: errors.map(syncErrorToListRow),
  }
}

function syncErrorToListRow(error: SyncErrorTableRow): SyncErrorListRow {
  return {
    sheetName: error.source_sheet_name ?? "Unknown sheet",
    rowLabel: error.source_row_number === null ? "Unknown row" : `Row ${String(error.source_row_number)}`,
    code: error.error_code ?? "unknown_error",
    message: error.error_message ?? "No error message recorded",
  }
}
