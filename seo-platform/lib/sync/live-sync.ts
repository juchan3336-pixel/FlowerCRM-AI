import "server-only"

import { readGoogleSheetRows } from "./google-sheets"
import { detectRowNumberDrift, lastSheetRowNumber, type RowNumberDrift } from "./job-policy"
import { createSupabaseSyncRepository } from "./supabase-repository"
import { syncSheetRows } from "./service"
import type { SyncSummary } from "./types"

const FIRST_DATA_ROW_NUMBER = 2
const DEFAULT_SYNC_BATCH_SIZE = 50

export type ManualSyncResult =
  | { readonly kind: "synced"; readonly summary: SyncSummary }
  // 시트가 기록보다 짧다 — 한 배치도 처리하지 않고 돌려보낸다.
  | { readonly kind: "row-number-drift"; readonly drift: RowNumberDrift }

export async function syncGoogleSheetsToSupabase(): Promise<ManualSyncResult> {
  const sheet = await readGoogleSheetRows()
  const repository = createSupabaseSyncRepository()
  const latestRowNumber = await repository.latestSourceRowNumber?.(sheet.sheetName)

  // 자동 연속 동기화와 같은 게이트. 커서가 시트 끝을 앞지른 채 실행하면 잔여가 없는 것처럼 보이고,
  // 그 뒤에 붙는 신규 행이 커서에 닿을 때까지 통째로 건너뛰어진다.
  const drift = detectRowNumberDrift({ latestSheetRow: lastSheetRowNumber(sheet.rows.length), maxSourceRowNumber: latestRowNumber })
  if (drift.kind === "drift") {
    return { kind: "row-number-drift", drift: drift.drift }
  }

  const firstDataRowNumber = latestRowNumber === undefined ? FIRST_DATA_ROW_NUMBER : latestRowNumber + 1
  const startIndex = firstDataRowNumber - FIRST_DATA_ROW_NUMBER
  const rows = sheet.rows.slice(startIndex, startIndex + DEFAULT_SYNC_BATCH_SIZE)
  return { kind: "synced", summary: await syncSheetRows({ firstDataRowNumber, repository, rows, sheetName: sheet.sheetName }) }
}
