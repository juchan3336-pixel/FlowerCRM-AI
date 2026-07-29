import type { PlaceStatus, SyncRunStatus } from "../domain/constants"
import type { PlaceImport, SheetPayload, SheetRowError } from "../domain/sheet-row"
import type { Json } from "../../types/database"

export type SourcePlaceFields = {
  readonly source: "google_sheets"
  readonly source_sheet_name: string
  readonly source_row_number: number
  readonly source_key: string
  readonly name: string
  readonly normalized_name: string
  readonly category: string
  readonly detail_category: string | null
  readonly region: string | null
  readonly city: string | null
  readonly district: string | null
  readonly address: string | null
  readonly normalized_address: string | null
  readonly phone: string | null
  readonly normalized_phone: string | null
  readonly homepage: string | null
  readonly email: string | null
  readonly source_url: string | null
  readonly collected_at: string | null
  readonly grade: string | null
  readonly sales_status: string | null
  readonly memo: string | null
  readonly imported_payload: SheetPayload
  readonly synced_at: string
}

export type SeoFields = {
  readonly description: string | null
  readonly meta_title: string | null
  readonly meta_description: string | null
  readonly faq: Json
  readonly keywords: Json
  readonly internal_links: Json
  readonly order_url: string | null
  readonly status: PlaceStatus
}

export type SyncedPlace = SourcePlaceFields &
  SeoFields & {
    readonly id: string
    readonly slug: string
    readonly created_at: string
    readonly updated_at: string
  }

export type NewSyncedPlace = SourcePlaceFields & {
  readonly slug: string
}

export type SyncRunRecord = {
  readonly id: string
  readonly source: "google_sheets"
  readonly started_at: string
  readonly finished_at: string | null
  readonly status: SyncRunStatus
  readonly total_rows: number
  readonly inserted_count: number
  readonly updated_count: number
  readonly skipped_count: number
  readonly failed_count: number
  readonly message: string | null
}

export type SyncErrorRecord = {
  readonly id: string
  readonly sync_run_id: string
  readonly source_sheet_name: string
  readonly source_row_number: number
  readonly source_payload: Json
  readonly error_code: string
  readonly error_message: string
  readonly created_at: string
}

export type SyncSummary = {
  readonly runId: string
  readonly totalRows: number
  readonly inserted: number
  readonly updated: number
  readonly skipped: number
  readonly failed: number
}

// 배치 기록(sync_runs)을 자동 연속 처리 job에 연결하는 링크. 수동 1회 실행에서는 undefined.
export type SyncRunLink = {
  readonly syncJobId: string
  readonly batchIndex: number
}

export type SyncRepository = {
  readonly createSyncRun: (link?: SyncRunLink) => Promise<SyncRunRecord>
  readonly finishSyncRun: (input: SyncRunFinishInput) => Promise<void>
  readonly latestSourceRowNumber?: (sheetName: string) => Promise<number | undefined>
  readonly findPlaceBySourceKey: (sourceKey: string) => Promise<SyncedPlace | undefined>
  readonly listPlaceSlugs: () => Promise<ReadonlySet<string>>
  readonly insertPlace: (place: NewSyncedPlace) => Promise<SyncedPlace>
  readonly updatePlaceSourceFields: (input: UpdatePlaceSourceInput) => Promise<SyncedPlace>
  readonly recordSyncError: (input: NewSyncError) => Promise<void>
}

export type SyncRunFinishInput = {
  readonly runId: string
  readonly status: SyncRunStatus
  readonly summary: Omit<SyncSummary, "runId">
  readonly message: string | null
}

export type UpdatePlaceSourceInput = {
  readonly sourceKey: string
  readonly fields: SourcePlaceFields
}

export type NewSyncError = {
  readonly syncRunId: string
  readonly sourceSheetName: string
  readonly sourceRowNumber: number
  readonly sourcePayload: Json
  readonly errorCode: string
  readonly errorMessage: string
}

export type SyncSheetRowsInput = {
  readonly repository: SyncRepository
  readonly rows: unknown
  readonly sheetName: string
  readonly firstDataRowNumber?: number
  readonly jobLink?: SyncRunLink
}

export type ParsedImport = {
  readonly row: PlaceImport
  readonly rowNumber: number
}

export type ParsedImportError = {
  readonly error: SheetRowError
  readonly rowNumber: number
  readonly payload: Json
}

export class DuplicatePlaceSlugError extends Error {
  readonly name = "DuplicatePlaceSlugError"

  constructor(readonly slug: string) {
    super(`Duplicate place slug: ${slug}`)
  }
}
