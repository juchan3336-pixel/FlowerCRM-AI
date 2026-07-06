import "server-only"

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { AdminSyncRepository } from "./sync"
import type { SyncCoverageStatus } from "./sync"
import type { SyncErrorTableRow, SyncRunTableRow } from "@/types/database"

const FIRST_DATA_ROW_NUMBER = 2
const MISSING_ROW_PREVIEW_LIMIT = 20

export function createSupabaseAdminSyncRepository(): AdminSyncRepository {
  const client = createSupabaseServiceRoleClient()

  return {
    async latestRun(): Promise<SyncRunTableRow | null> {
      const { data, error } = await client.from("sync_runs").select("*").order("started_at", { ascending: false }).limit(1).maybeSingle()
      if (error !== null) {
        throw new SupabaseAdminSyncReadError(error.message)
      }
      return data
    },
    async listRecentRuns(): Promise<readonly SyncRunTableRow[]> {
      const { data, error } = await client.from("sync_runs").select("*").order("started_at", { ascending: false }).limit(5)
      if (error !== null) {
        throw new SupabaseAdminSyncReadError(error.message)
      }
      return data
    },
    async listErrors(syncRunId: string): Promise<readonly SyncErrorTableRow[]> {
      const { data, error } = await client.from("sync_errors").select("*").eq("sync_run_id", syncRunId).order("created_at", { ascending: false })
      if (error !== null) {
        throw new SupabaseAdminSyncReadError(error.message)
      }
      return data
    },
    async coverage(): Promise<SyncCoverageStatus> {
      const [countResult, runningResult, rowResult] = await Promise.all([
        client.from("places").select("id", { count: "exact", head: true }).eq("source", "google_sheets"),
        client.from("sync_runs").select("id", { count: "exact", head: true }).eq("status", "running"),
        client.from("places").select("source_row_number").eq("source", "google_sheets").not("source_row_number", "is", null).order("source_row_number", { ascending: true }),
      ])

      const error = countResult.error ?? runningResult.error ?? rowResult.error
      if (error !== null) {
        throw new SupabaseAdminSyncReadError(error.message)
      }

      const sourceRows = (rowResult.data ?? []).map((row) => row.source_row_number).filter((rowNumber): rowNumber is number => rowNumber !== null)
      return {
        importedPlaces: countResult.count ?? 0,
        latestSourceRowNumber: sourceRows.at(-1) ?? null,
        missingSourceRows: missingRows(sourceRows),
        openRunningRuns: runningResult.count ?? 0,
      }
    },
  }
}

function missingRows(sourceRows: readonly number[]): readonly number[] {
  const importedRows = new Set(sourceRows)
  const latestSourceRow = sourceRows.at(-1)
  if (latestSourceRow === undefined) {
    return []
  }

  const missing: number[] = []
  for (let rowNumber = FIRST_DATA_ROW_NUMBER; rowNumber < latestSourceRow && missing.length < MISSING_ROW_PREVIEW_LIMIT; rowNumber += 1) {
    if (!importedRows.has(rowNumber)) {
      missing.push(rowNumber)
    }
  }
  return missing
}

export class SupabaseAdminSyncReadError extends Error {
  readonly name = "SupabaseAdminSyncReadError"

  constructor(readonly detail: string) {
    super(`Failed to read admin sync status: ${detail}`)
  }
}
