import "server-only"

import { readGoogleSheetRows } from "./google-sheets"
import { createSupabaseSyncRepository } from "./supabase-repository"
import { syncSheetRows } from "./service"
import type { SyncSummary } from "./types"

const FIRST_DATA_ROW_NUMBER = 2
const DEFAULT_SYNC_BATCH_SIZE = 50

export async function syncGoogleSheetsToSupabase(): Promise<SyncSummary> {
  const sheet = await readGoogleSheetRows()
  const repository = createSupabaseSyncRepository()
  const latestRowNumber = await repository.latestSourceRowNumber?.(sheet.sheetName)
  const firstDataRowNumber = latestRowNumber === undefined ? FIRST_DATA_ROW_NUMBER : latestRowNumber + 1
  const startIndex = firstDataRowNumber - FIRST_DATA_ROW_NUMBER
  const rows = sheet.rows.slice(startIndex, startIndex + DEFAULT_SYNC_BATCH_SIZE)
  return syncSheetRows({ firstDataRowNumber, repository, rows, sheetName: sheet.sheetName })
}
