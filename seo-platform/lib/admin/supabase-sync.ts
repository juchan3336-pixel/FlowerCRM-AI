import "server-only"

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { AdminSyncRepository } from "./sync"
import type { SyncCoverageStatus } from "./sync"
import type { SyncErrorTableRow, SyncRunTableRow } from "@/types/database"
import { loadAdminSyncCoverage } from "./supabase-sync-coverage"

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
        client.from("places").select("source_row_number").eq("source", "google_sheets").not("source_row_number", "is", null).order("source_row_number", { ascending: false }).limit(1).maybeSingle(),
      ])

      const error = countResult.error ?? runningResult.error ?? rowResult.error
      if (error !== null) {
        throw new SupabaseAdminSyncReadError(error.message)
      }

      return loadAdminSyncCoverage({
        countImportedPlaces: () => Promise.resolve(countResult.count ?? 0),
        countOpenRunningRuns: () => Promise.resolve(runningResult.count ?? 0),
        latestSourceRowNumber: () => Promise.resolve(rowResult.data?.source_row_number ?? null),
        fetchMissingSourceRowsPage: async (offset, limit) => {
          const { data, error: pageError } = await client
            .from("places")
            .select("source_row_number")
            .eq("source", "google_sheets")
            .not("source_row_number", "is", null)
            .order("source_row_number", { ascending: true })
            .range(offset, offset + limit - 1)

          if (pageError !== null) {
            throw new SupabaseAdminSyncReadError(pageError.message)
          }

          return data.map((row) => row.source_row_number)
        },
      })
    },
  }
}

export class SupabaseAdminSyncReadError extends Error {
  readonly name = "SupabaseAdminSyncReadError"

  constructor(readonly detail: string) {
    super(`Failed to read admin sync status: ${detail}`)
  }
}
