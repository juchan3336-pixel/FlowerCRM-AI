import "server-only"

import { readGoogleSheetRows } from "./google-sheets"
import { createSupabaseSyncRepository } from "./supabase-repository"
import { syncSheetRows } from "./service"
import type { SyncSummary } from "./types"

export async function syncGoogleSheetsToSupabase(): Promise<SyncSummary> {
  const sheet = await readGoogleSheetRows()
  return syncSheetRows({ repository: createSupabaseSyncRepository(), rows: sheet.rows, sheetName: sheet.sheetName })
}
