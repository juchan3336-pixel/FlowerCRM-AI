import "server-only"

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { AdminSyncRepository } from "./sync"
import type { SyncErrorTableRow, SyncRunTableRow } from "@/types/database"

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
    async listErrors(syncRunId: string): Promise<readonly SyncErrorTableRow[]> {
      const { data, error } = await client.from("sync_errors").select("*").eq("sync_run_id", syncRunId).order("created_at", { ascending: false })
      if (error !== null) {
        throw new SupabaseAdminSyncReadError(error.message)
      }
      return data
    },
  }
}

export class SupabaseAdminSyncReadError extends Error {
  readonly name = "SupabaseAdminSyncReadError"

  constructor(readonly detail: string) {
    super(`Failed to read admin sync status: ${detail}`)
  }
}
