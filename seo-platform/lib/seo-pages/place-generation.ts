import { classifyPlaceQuality, createPlaceContentKey, type PlaceQualityBlocker, type PlaceQualityWarning } from "./place-quality"
import type { PlaceRow, SeoPageRow } from "@/types/database"

export type SelectablePlaceForSeoGeneration = Pick<
  PlaceRow,
  "id" | "name" | "address" | "category" | "slug" | "city" | "district" | "description" | "meta_title" | "meta_description"
>

export type SeoPageForPlaceGeneration = Pick<
  SeoPageRow,
  "place_id" | "page_type" | "slug" | "path" | "title" | "description" | "canonical_url" | "status" | "priority" | "change_frequency" | "last_modified_at"
>

export interface PlaceSeoGenerationRepository {
  listSelectedPlaces(placeIds: readonly string[]): Promise<readonly SelectablePlaceForSeoGeneration[]>
  listPlaceSeoPageContexts(): Promise<readonly SeoPageForPlaceGeneration[]>
  insertReadyPlaceSeoPages(pages: readonly SeoPageForPlaceGeneration[]): Promise<number>
}

export type PlaceSeoGenerationInput = {
  readonly repository: PlaceSeoGenerationRepository
  readonly placeIds: readonly string[]
  readonly now?: string
}

export type PlaceSeoGenerationRejectedReason = "EmptySelection" | "SampleMinimumNotMet" | "SampleLimitExceeded"

export type PlaceSeoGenerationResult =
  | PlaceSeoGenerationCreatedResult
  | (PlaceSeoGenerationCounts & {
      readonly kind: "rejected"
      readonly reason: PlaceSeoGenerationRejectedReason
    })

type PlaceSeoGenerationCreatedResult = PlaceSeoGenerationCounts & {
  readonly kind: "created"
}

type PlaceSeoGenerationCounts = {
  readonly selected: number
  readonly created: number
  readonly blocked: number
  readonly warnings: number
  readonly errors: readonly PlaceSeoGenerationError[]
}

export type PlaceSeoGenerationError = {
  readonly placeId: string
  readonly blockers: readonly PlaceQualityBlocker[]
  readonly warnings: readonly PlaceQualityWarning[]
}

const MAX_SELECTED_PLACE_COUNT = 100
const MIN_SELECTED_PLACE_COUNT = 50
const PLACE_PAGE_PRIORITY = 0.7
const PLACE_PAGE_CHANGE_FREQUENCY = "weekly" as const

export async function generateSelectedPlaceSeoPages(input: PlaceSeoGenerationInput): Promise<PlaceSeoGenerationResult> {
  const selected = input.placeIds.length
  if (selected === 0) {
    return rejected("EmptySelection", selected)
  }
  if (selected < MIN_SELECTED_PLACE_COUNT) {
    return rejected("SampleMinimumNotMet", selected)
  }
  if (selected > MAX_SELECTED_PLACE_COUNT) {
    return rejected("SampleLimitExceeded", selected)
  }

  const now = input.now ?? new Date().toISOString()
  const [places, existingPages] = await Promise.all([
    input.repository.listSelectedPlaces(input.placeIds),
    input.repository.listPlaceSeoPageContexts(),
  ])
  const placesById = new Map(places.map((place) => [place.id, place]))
  const existingPaths = new Set(existingPages.map((page) => page.path))
  const duplicateContentKeys = new Set<string>()
  const pages: SeoPageForPlaceGeneration[] = []
  let blocked = 0
  let warnings = 0

  for (const placeId of input.placeIds) {
    const place = placesById.get(placeId)
    if (place === undefined) {
      blocked += 1
      continue
    }

    const result = classifyPlaceQuality({ place, existingSeoPages: existingPages, existingPaths, duplicateContentKeys })
    if (result.kind === "blocked" || result.path === null) {
      blocked += 1
      continue
    }

    warnings += result.warnings.length > 0 ? 1 : 0
    pages.push(pageFromPlace(place, result.path, now))
    existingPaths.add(result.path)
    const contentKey = createPlaceContentKey(place)
    if (contentKey !== null) {
      duplicateContentKeys.add(contentKey)
    }
  }

  const created = pages.length === 0 ? 0 : await input.repository.insertReadyPlaceSeoPages(pages)
  return { kind: "created", selected, created, blocked, warnings, errors: [] }
}

function rejected(reason: PlaceSeoGenerationRejectedReason, selected: number): PlaceSeoGenerationResult {
  return { kind: "rejected", reason, selected, created: 0, blocked: 0, warnings: 0, errors: [] }
}

function pageFromPlace(place: SelectablePlaceForSeoGeneration, path: string, now: string): SeoPageForPlaceGeneration {
  const title = textValue(place.meta_title) ?? `${place.name} | 전국팔도꽃배달`
  const description = textValue(place.meta_description) ?? textValue(place.description) ?? `${place.name} ${place.address ?? ""} 화환 배송 안내`.trim()

  return {
    place_id: place.id,
    page_type: "place",
    slug: place.slug ?? place.id,
    path,
    title,
    description,
    canonical_url: path,
    status: "ready",
    priority: PLACE_PAGE_PRIORITY,
    change_frequency: PLACE_PAGE_CHANGE_FREQUENCY,
    last_modified_at: now,
  }
}

function textValue(value: string | null): string | null {
  const text = value?.trim()
  if (text === undefined || text.length === 0) {
    return null
  }
  return text
}
