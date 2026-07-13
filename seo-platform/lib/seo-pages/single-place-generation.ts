import { classifyPlaceQuality, type PlaceQualityBlocker } from "./place-quality"
import { pageFromPlace, type PlaceSeoGenerationRepository } from "./place-generation"

export type SinglePlaceSeoPageInput = {
  readonly repository: PlaceSeoGenerationRepository
  readonly placeId: string
  readonly now?: string
}

export type SinglePlaceSeoPageResult =
  | { readonly kind: "created"; readonly path: string }
  | { readonly kind: "already-exists"; readonly path: string }
  | { readonly kind: "blocked"; readonly blockers: readonly PlaceQualityBlocker[] }
  | { readonly kind: "missing-place" }

export async function generateSinglePlaceSeoPage(input: SinglePlaceSeoPageInput): Promise<SinglePlaceSeoPageResult> {
  const [places, existingPages] = await Promise.all([
    input.repository.listSelectedPlaces([input.placeId]),
    input.repository.listPlaceSeoPageContexts(),
  ])

  const place = places.find((candidate) => candidate.id === input.placeId)
  if (place === undefined) {
    return { kind: "missing-place" }
  }

  const existing = existingPages.find((page) => page.page_type === "place" && page.place_id === input.placeId)
  if (existing !== undefined) {
    return { kind: "already-exists", path: existing.path }
  }

  const quality = classifyPlaceQuality({
    place,
    existingSeoPages: existingPages,
    existingPaths: new Set(existingPages.map((page) => page.path)),
    duplicateContentKeys: new Set(),
  })
  if (quality.kind === "blocked" || quality.path === null) {
    return { kind: "blocked", blockers: quality.blockers }
  }

  const now = input.now ?? new Date().toISOString()
  await input.repository.insertReadyPlaceSeoPages([pageFromPlace(place, quality.path, now)])
  return { kind: "created", path: quality.path }
}
