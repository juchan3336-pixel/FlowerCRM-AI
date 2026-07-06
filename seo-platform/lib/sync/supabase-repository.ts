import "server-only"

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import { SHEET_COLUMNS } from "@/lib/domain/constants"
import type { Json, PlaceRow, SyncRunTableRow } from "@/types/database"
import type { SheetPayload } from "@/lib/domain/sheet-row"
import type {
  NewSyncError,
  NewSyncedPlace,
  SourcePlaceFields,
  SyncRepository,
  SyncRunFinishInput,
  SyncRunRecord,
  SyncedPlace,
  UpdatePlaceSourceInput,
} from "./types"
import { DuplicatePlaceSlugError as DuplicatePlaceSlugWriteError } from "./types"

export function createSupabaseSyncRepository(): SyncRepository {
  const client = createSupabaseServiceRoleClient()

  return {
    async createSyncRun(): Promise<SyncRunRecord> {
      const { data, error } = await client.from("sync_runs").insert({ source: "google_sheets", status: "running" }).select("*").single()
      if (error !== null) {
        throw new SupabaseSyncWriteError(error.message)
      }
      return syncRunRowToRecord(data)
    },
    async finishSyncRun(input: SyncRunFinishInput): Promise<void> {
      const { error } = await client
        .from("sync_runs")
        .update({
          finished_at: new Date().toISOString(),
          status: input.status,
          total_rows: input.summary.totalRows,
          inserted_count: input.summary.inserted,
          updated_count: input.summary.updated,
          skipped_count: input.summary.skipped,
          failed_count: input.summary.failed,
          message: input.message,
        })
        .eq("id", input.runId)

      if (error !== null) {
        throw new SupabaseSyncWriteError(error.message)
      }
    },
    async latestSourceRowNumber(sheetName: string): Promise<number | undefined> {
      const { data, error } = await client
        .from("places")
        .select("source_row_number")
        .eq("source_sheet_name", sheetName)
        .not("source_row_number", "is", null)
        .order("source_row_number", { ascending: false })
        .limit(1)
        .maybeSingle()

      if (error !== null) {
        throw new SupabaseSyncWriteError(error.message)
      }
      return data?.source_row_number ?? undefined
    },
    async findPlaceBySourceKey(sourceKey: string): Promise<SyncedPlace | undefined> {
      const { data, error } = await client.from("places").select("*").eq("source_key", sourceKey).maybeSingle()
      if (error !== null) {
        throw new SupabaseSyncWriteError(error.message)
      }
      return data === null ? undefined : placeRowToSyncedPlace(data)
    },
    async listPlaceSlugs(): Promise<ReadonlySet<string>> {
      const { data, error } = await client.from("places").select("slug").not("slug", "is", null)
      if (error !== null) {
        throw new SupabaseSyncWriteError(error.message)
      }
      return new Set(data.map((row) => row.slug))
    },
    async insertPlace(place: NewSyncedPlace): Promise<SyncedPlace> {
      const { data, error } = await client.from("places").upsert(newPlaceToUpsert(place), { onConflict: "source_key" }).select("*").single()
      if (error !== null) {
        if (isDuplicateSlugError(error.message)) {
          throw new DuplicatePlaceSlugWriteError(place.slug)
        }
        throw new SupabaseSyncWriteError(error.message)
      }
      return placeRowToSyncedPlace(data)
    },
    async updatePlaceSourceFields(input: UpdatePlaceSourceInput): Promise<SyncedPlace> {
      const { data, error } = await client.from("places").update(sourceFieldsToUpdate(input.fields)).eq("source_key", input.sourceKey).select("*").single()
      if (error !== null) {
        throw new SupabaseSyncWriteError(error.message)
      }
      return placeRowToSyncedPlace(data)
    },
    async recordSyncError(input: NewSyncError): Promise<void> {
      const { error } = await client.from("sync_errors").insert(newSyncErrorToInsert(input))
      if (error !== null) {
        throw new SupabaseSyncWriteError(error.message)
      }
    },
  }
}

function isDuplicateSlugError(message: string): boolean {
  return message.includes('unique constraint "places_slug_key"')
}

function newPlaceToUpsert(place: NewSyncedPlace): Partial<PlaceRow> {
  return { ...sourceFieldsToUpdate(place), slug: place.slug }
}

function sourceFieldsToUpdate(fields: SourcePlaceFields): Partial<PlaceRow> {
  return {
    source: fields.source,
    source_sheet_name: fields.source_sheet_name,
    source_row_number: fields.source_row_number,
    source_key: fields.source_key,
    name: fields.name,
    normalized_name: fields.normalized_name,
    category: fields.category,
    detail_category: fields.detail_category,
    region: fields.region,
    city: fields.city,
    district: fields.district,
    address: fields.address,
    normalized_address: fields.normalized_address,
    phone: fields.phone,
    normalized_phone: fields.normalized_phone,
    homepage: fields.homepage,
    email: fields.email,
    source_url: fields.source_url,
    collected_at: fields.collected_at,
    grade: fields.grade,
    sales_status: fields.sales_status,
    memo: fields.memo,
    imported_payload: fields.imported_payload,
    synced_at: fields.synced_at,
  }
}

function newSyncErrorToInsert(input: NewSyncError): Record<string, Json> {
  return {
    sync_run_id: input.syncRunId,
    source_sheet_name: input.sourceSheetName,
    source_row_number: input.sourceRowNumber,
    source_payload: input.sourcePayload,
    error_code: input.errorCode,
    error_message: input.errorMessage,
  }
}

function placeRowToSyncedPlace(row: PlaceRow): SyncedPlace {
  return {
    source: row.source,
    source_sheet_name: row.source_sheet_name ?? "",
    source_row_number: row.source_row_number ?? 0,
    source_key: row.source_key,
    name: row.name,
    normalized_name: row.normalized_name,
    category: row.category,
    detail_category: row.detail_category,
    region: row.region,
    city: row.city,
    district: row.district,
    address: row.address,
    normalized_address: row.normalized_address,
    phone: row.phone,
    normalized_phone: row.normalized_phone,
    homepage: row.homepage,
    email: row.email,
    source_url: row.source_url,
    collected_at: row.collected_at,
    grade: row.grade,
    sales_status: row.sales_status,
    memo: row.memo,
    imported_payload: jsonToSheetPayload(row.imported_payload),
    synced_at: row.synced_at ?? "",
    description: row.description,
    meta_title: row.meta_title,
    meta_description: row.meta_description,
    faq: row.faq,
    keywords: row.keywords,
    internal_links: row.internal_links,
    order_url: row.order_url,
    status: row.status,
    id: row.id,
    slug: row.slug ?? "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function jsonToSheetPayload(value: Json): SheetPayload {
  const payload = emptySheetPayload()
  if (!isJsonRecord(value)) {
    return payload
  }

  for (const column of SHEET_COLUMNS) {
    payload[column] = jsonValueToText(value[column])
  }
  return payload
}

function emptySheetPayload(): SheetPayload {
  return {
    회사명: undefined,
    업종: undefined,
    세부업종: undefined,
    지역: undefined,
    주소: undefined,
    대표전화: undefined,
    홈페이지: undefined,
    이메일: undefined,
    출처URL: undefined,
    수집일: undefined,
    등급: undefined,
    영업상태: undefined,
    메모: undefined,
  }
}

function jsonValueToText(value: Json | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

function isJsonRecord(value: Json): value is Readonly<Record<string, Json | undefined>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function syncRunRowToRecord(row: SyncRunTableRow): SyncRunRecord {
  return {
    id: row.id,
    source: row.source,
    started_at: row.started_at,
    finished_at: row.finished_at,
    status: row.status,
    total_rows: row.total_rows,
    inserted_count: row.inserted_count,
    updated_count: row.updated_count,
    skipped_count: row.skipped_count,
    failed_count: row.failed_count,
    message: row.message,
  }
}

export class SupabaseSyncWriteError extends Error {
  readonly name = "SupabaseSyncWriteError"

  constructor(readonly detail: string) {
    super(`Failed to write sync data: ${detail}`)
  }
}
