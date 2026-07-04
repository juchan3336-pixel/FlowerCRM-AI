import type { PlaceStatus } from "../domain/constants"
import type { Json } from "../../types/database"
import type { AiGenerationRecord, AiRepository, ApplyAiGenerationInput, NewAiGeneration } from "../ai/types"
import type {
  NewSyncError,
  NewSyncedPlace,
  SeoFields,
  SyncErrorRecord,
  SyncRepository,
  SyncRunFinishInput,
  SyncRunRecord,
  SyncedPlace,
  UpdatePlaceSourceInput,
} from "./types"

export class InMemorySyncRepository implements SyncRepository, AiRepository {
  private readonly placesBySourceKey = new Map<string, SyncedPlace>()
  private readonly runsById = new Map<string, SyncRunRecord>()
  private readonly generationsById = new Map<string, AiGenerationRecord>()
  private readonly errors: SyncErrorRecord[] = []
  private sequence = 0

  createSyncRun(): Promise<SyncRunRecord> {
    const now = new Date().toISOString()
    const run: SyncRunRecord = {
      id: this.nextId("sync_run"),
      source: "google_sheets",
      started_at: now,
      finished_at: null,
      status: "running",
      total_rows: 0,
      inserted_count: 0,
      updated_count: 0,
      skipped_count: 0,
      failed_count: 0,
      message: null,
    }
    this.runsById.set(run.id, run)
    return Promise.resolve(run)
  }

  finishSyncRun(input: SyncRunFinishInput): Promise<void> {
    const current = this.runsById.get(input.runId)
    if (current === undefined) {
      return Promise.reject(new MissingSyncRunError(input.runId))
    }

    this.runsById.set(input.runId, {
      ...current,
      finished_at: new Date().toISOString(),
      status: input.status,
      total_rows: input.summary.totalRows,
      inserted_count: input.summary.inserted,
      updated_count: input.summary.updated,
      skipped_count: input.summary.skipped,
      failed_count: input.summary.failed,
      message: input.message,
    })
    return Promise.resolve()
  }

  findPlaceBySourceKey(sourceKey: string): Promise<SyncedPlace | undefined> {
    return Promise.resolve(this.placesBySourceKey.get(sourceKey))
  }

  listPlaceSlugs(): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set(this.places().map((place) => place.slug)))
  }

  insertPlace(place: NewSyncedPlace): Promise<SyncedPlace> {
    const now = new Date().toISOString()
    const inserted: SyncedPlace = {
      ...place,
      id: this.nextId("place"),
      created_at: now,
      updated_at: now,
      description: null,
      meta_title: null,
      meta_description: null,
      faq: [],
      keywords: [],
      internal_links: [],
      order_url: null,
      status: "draft",
    }
    this.placesBySourceKey.set(inserted.source_key, inserted)
    return Promise.resolve(inserted)
  }

  updatePlaceSourceFields(input: UpdatePlaceSourceInput): Promise<SyncedPlace> {
    const current = this.placesBySourceKey.get(input.sourceKey)
    if (current === undefined) {
      return Promise.reject(new MissingPlaceError(input.sourceKey))
    }

    const updated: SyncedPlace = {
      ...current,
      ...input.fields,
      updated_at: new Date().toISOString(),
    }
    this.placesBySourceKey.set(input.sourceKey, updated)
    return Promise.resolve(updated)
  }

  recordSyncError(input: NewSyncError): Promise<void> {
    this.errors.push({
      id: this.nextId("sync_error"),
      sync_run_id: input.syncRunId,
      source_sheet_name: input.sourceSheetName,
      source_row_number: input.sourceRowNumber,
      source_payload: input.sourcePayload,
      error_code: input.errorCode,
      error_message: input.errorMessage,
      created_at: new Date().toISOString(),
    })
    return Promise.resolve()
  }

  findPlaceById(placeId: string): Promise<SyncedPlace | undefined> {
    return Promise.resolve(this.places().find((place) => place.id === placeId))
  }

  createAiGeneration(input: NewAiGeneration): Promise<AiGenerationRecord> {
    const generation: AiGenerationRecord = {
      id: this.nextId("ai_generation"),
      place_id: input.placeId,
      status: "preview",
      input: input.input,
      output: input.output,
      before: null,
      after: null,
      created_at: new Date().toISOString(),
      applied_at: null,
    }
    this.generationsById.set(generation.id, generation)
    return Promise.resolve(generation)
  }

  findAiGenerationById(generationId: string): Promise<AiGenerationRecord | undefined> {
    return Promise.resolve(this.generationsById.get(generationId))
  }

  applyAiGeneration(input: ApplyAiGenerationInput): Promise<AiGenerationRecord> {
    const generation = this.generationsById.get(input.generationId)
    if (generation === undefined) {
      return Promise.reject(new MissingAiGenerationRecordError(input.generationId))
    }
    const place = this.places().find((currentPlace) => currentPlace.id === generation.place_id)
    if (place === undefined) {
      return Promise.reject(new MissingPlaceError(generation.place_id))
    }
    const updatedPlace: SyncedPlace = {
      ...place,
      description: input.after.description,
      meta_title: input.after.meta_title,
      meta_description: input.after.meta_description,
      faq: input.after.faq,
      keywords: input.after.keywords,
      internal_links: input.after.internal_links,
      updated_at: new Date().toISOString(),
    }
    this.placesBySourceKey.set(updatedPlace.source_key, updatedPlace)
    const applied: AiGenerationRecord = {
      ...generation,
      status: "applied",
      before: input.before,
      after: input.after,
      applied_at: new Date().toISOString(),
    }
    this.generationsById.set(applied.id, applied)
    return Promise.resolve(applied)
  }

  places(): readonly SyncedPlace[] {
    return [...this.placesBySourceKey.values()]
  }

  syncRuns(): readonly SyncRunRecord[] {
    return [...this.runsById.values()]
  }

  syncErrors(): readonly SyncErrorRecord[] {
    return [...this.errors]
  }

  aiGenerations(): readonly AiGenerationRecord[] {
    return [...this.generationsById.values()]
  }

  findSeededPlace(sourceKey: string): SyncedPlace | undefined {
    return this.placesBySourceKey.get(sourceKey)
  }

  seedSeoFields(sourceKey: string, fields: PartialSeedSeoFields): void {
    const current = this.placesBySourceKey.get(sourceKey)
    if (current === undefined) {
      throw new MissingPlaceError(sourceKey)
    }
    this.placesBySourceKey.set(sourceKey, { ...current, ...fields })
  }

  private nextId(prefix: string): string {
    this.sequence += 1
    return `${prefix}_${String(this.sequence)}`
  }
}

export class MissingSyncRunError extends Error {
  readonly name = "MissingSyncRunError"

  constructor(readonly runId: string) {
    super(`Missing sync run ${runId}`)
  }
}

export class MissingPlaceError extends Error {
  readonly name = "MissingPlaceError"

  constructor(readonly sourceKey: string) {
    super(`Missing place ${sourceKey}`)
  }
}

export class MissingAiGenerationRecordError extends Error {
  readonly name = "MissingAiGenerationRecordError"

  constructor(readonly generationId: string) {
    super(`Missing AI generation ${generationId}`)
  }
}

type PartialSeedSeoFields = Partial<
  SeoFields & {
    readonly faq: Json
    readonly keywords: Json
    readonly internal_links: Json
    readonly status: PlaceStatus
  }
>
