import type { SeoPageType } from "../domain/constants"
import { parsePlaceImport, type PlaceImport, type SheetRowError } from "../domain/sheet-row"
import { createBaseSlug } from "../domain/slug"
import type { Json } from "../../types/database"
import { planSyncUpsert } from "./upsert-plan"
import { createSlugInserter } from "./slug-insert"
import type { SourcePlaceFields, SyncSheetRowsInput, SyncSummary } from "./types"

const FIRST_DATA_ROW_NUMBER = 2

export async function syncSheetRows(input: SyncSheetRowsInput): Promise<SyncSummary> {
  const run = await input.repository.createSyncRun()
  const rows = Array.isArray(input.rows) ? input.rows : []
  const firstDataRowNumber = input.firstDataRowNumber ?? FIRST_DATA_ROW_NUMBER
  const counter = createSyncCounter(rows.length)
  const slugInserter = createSlugInserter(input.repository)

  try {
    if (!Array.isArray(input.rows)) {
      await input.repository.recordSyncError({
        syncRunId: run.id,
        sourceSheetName: input.sheetName,
        sourceRowNumber: firstDataRowNumber,
        sourcePayload: toJson(input.rows),
        errorCode: "invalid_fixture",
        errorMessage: "Sync input must be an array of Sheet rows",
      })
      counter.failed += 1
    }

    for (const [index, rawRow] of rows.entries()) {
      const rowNumber = index + firstDataRowNumber
      const parsed = parsePlaceImport(rawRow, { sheetName: input.sheetName, rowNumber })
      if (!parsed.ok) {
        await input.repository.recordSyncError({
          syncRunId: run.id,
          sourceSheetName: input.sheetName,
          sourceRowNumber: rowNumber,
          sourcePayload: toJson(rawRow),
          errorCode: parsed.error.kind,
          errorMessage: sheetRowErrorMessage(parsed.error),
        })
        counter.failed += 1
        continue
      }

      const next = toSourcePlaceFields(parsed.value, new Date().toISOString())
      const current = await input.repository.findPlaceBySourceKey(next.source_key)
      const plan = planSyncUpsert({ current, next })

      switch (plan.kind) {
        case "insert": {
          const existing = await input.repository.findPlaceBySourceKey(plan.next.source_key)
          if (existing !== undefined) {
            const retryPlan = planSyncUpsert({ current: existing, next: plan.next })
            switch (retryPlan.kind) {
              case "update": {
                await input.repository.updatePlaceSourceFields({ sourceKey: retryPlan.current.source_key, fields: retryPlan.next })
                counter.updated += 1
                break
              }
              case "skip": {
                counter.skipped += 1
                break
              }
              case "insert": {
                throw new DuplicateInsertPlanError(retryPlan.next.source_key)
              }
              default: {
                assertNever(retryPlan)
              }
            }
            break
          }

          const baseSlugInput = {
            pageType: pageTypeForCategory(plan.next.category),
            name: plan.next.name,
            ...(plan.next.city === null ? {} : { city: plan.next.city }),
            ...(plan.next.district === null ? {} : { district: plan.next.district }),
          }
          const baseSlug = createBaseSlug(baseSlugInput)
          await slugInserter.insert({ baseSlug, place: plan.next })
          counter.inserted += 1
          break
        }
        case "update": {
          await input.repository.updatePlaceSourceFields({ sourceKey: plan.current.source_key, fields: plan.next })
          counter.updated += 1
          break
        }
        case "skip": {
          counter.skipped += 1
          break
        }
        default: {
          assertNever(plan)
        }
      }
    }
  } catch (error) {
    const summary = toSummary(run.id, counter)
    await input.repository.finishSyncRun({ runId: run.id, status: "failed", summary, message: syncRuntimeErrorMessage(error) })
    throw error
  }

  const summary = toSummary(run.id, counter)
  await input.repository.finishSyncRun({
    runId: run.id,
    status: summary.failed > 0 ? "failed" : "completed",
    summary,
    message: summary.failed > 0 ? "Completed with row errors" : "Completed",
  })
  return summary
}

function syncRuntimeErrorMessage(error: unknown): string {
  return error instanceof Error ? `Sync failed: ${error.message}` : "Sync failed with an unknown error"
}

function toSourcePlaceFields(place: PlaceImport, syncedAt: string): SourcePlaceFields {
  return { ...toImportFields(place), synced_at: syncedAt }
}

function toImportFields(place: PlaceImport): Omit<SourcePlaceFields, "synced_at"> {
  return {
    source: place.source,
    source_sheet_name: place.source_sheet_name,
    source_row_number: place.source_row_number,
    source_key: place.source_key,
    name: place.name,
    normalized_name: place.normalized_name,
    category: place.category,
    detail_category: textOrNull(place.detail_category),
    region: textOrNull(place.region),
    city: textOrNull(place.city),
    district: textOrNull(place.district),
    address: textOrNull(place.address),
    normalized_address: textOrNull(place.normalized_address),
    phone: textOrNull(place.phone),
    normalized_phone: textOrNull(place.normalized_phone),
    homepage: textOrNull(place.homepage),
    email: textOrNull(place.email),
    source_url: textOrNull(place.source_url),
    collected_at: textOrNull(place.collected_at),
    grade: textOrNull(place.grade),
    sales_status: textOrNull(place.sales_status),
    memo: textOrNull(place.memo),
    imported_payload: place.imported_payload,
  }
}

function pageTypeForCategory(category: string): SeoPageType {
  if (category === "funeral") {
    return "funeral"
  }
  if (category === "hospital") {
    return "hospital"
  }
  return "area"
}

function sheetRowErrorMessage(error: SheetRowError): string {
  switch (error.kind) {
    case "invalid_shape":
      return error.issues.join("; ")
    case "missing_dedupe_fields":
      return `Missing phone and address for ${error.name}`
    default:
      return assertNever(error)
  }
}

function textOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed
}

function createSyncCounter(totalRows: number): SyncCounter {
  return { totalRows, inserted: 0, updated: 0, skipped: 0, failed: 0 }
}

function toSummary(runId: string, counter: SyncCounter): SyncSummary {
  return { runId, ...counter }
}

function toJson(value: unknown): Json {
  if (value === undefined) {
    return null
  }
  const parsed: unknown = JSON.parse(JSON.stringify(value))
  return isJson(parsed) ? parsed : null
}

function isJson(value: unknown): value is Json {
  if (value === null) {
    return true
  }
  const valueType = typeof value
  if (valueType === "string" || valueType === "number" || valueType === "boolean") {
    return true
  }
  if (Array.isArray(value)) {
    return value.every(isJson)
  }
  if (!isRecord(value)) {
    return false
  }
  return Object.values(value).every((entry) => entry === undefined || isJson(entry))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function assertNever(value: never): never {
  throw new UnhandledSyncVariantError(JSON.stringify(value))
}

type SyncCounter = {
  totalRows: number
  inserted: number
  updated: number
  skipped: number
  failed: number
}

class UnhandledSyncVariantError extends Error {
  readonly name = "UnhandledSyncVariantError"

  constructor(readonly variant: string) {
    super(`Unhandled sync variant: ${variant}`)
  }
}

class DuplicateInsertPlanError extends Error {
  readonly name = "DuplicateInsertPlanError"

  constructor(readonly sourceKey: string) {
    super(`Duplicate insert plan for ${sourceKey}`)
  }
}
