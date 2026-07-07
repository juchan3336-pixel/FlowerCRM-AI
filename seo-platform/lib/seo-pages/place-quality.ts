import type { PlaceRow, SeoPageRow } from "@/types/database"

export const PLACE_QUALITY_BLOCKERS = [
  "missing_name",
  "missing_address",
  "missing_category",
  "missing_slug",
  "existing_place_page",
  "duplicate_path",
  "duplicate_content",
] as const

export const PLACE_QUALITY_WARNINGS = ["missing_city", "missing_district"] as const

export type PlaceQualityBlocker = (typeof PLACE_QUALITY_BLOCKERS)[number]
export type PlaceQualityWarning = (typeof PLACE_QUALITY_WARNINGS)[number]
export type PlaceQualityKind = "eligible" | "warning" | "blocked"

export type PlaceQualityPlace = {
  readonly id: PlaceRow["id"]
  readonly name: PlaceRow["name"] | null
  readonly address: PlaceRow["address"]
  readonly category: PlaceRow["category"] | null
  readonly slug: PlaceRow["slug"]
  readonly city: PlaceRow["city"]
  readonly district: PlaceRow["district"]
}

export type PlaceSeoPageContext = Pick<SeoPageRow, "place_id" | "page_type" | "path">

export type PlaceQualityInput = {
  readonly place: PlaceQualityPlace
  readonly existingSeoPages: readonly PlaceSeoPageContext[]
  readonly existingPaths: ReadonlySet<string>
  readonly duplicateContentKeys: ReadonlySet<string>
}

export type PlaceQualityResult = {
  readonly kind: PlaceQualityKind
  readonly blockers: readonly PlaceQualityBlocker[]
  readonly warnings: readonly PlaceQualityWarning[]
  readonly path: string | null
  readonly contentKey: string | null
}

export function classifyPlaceQuality(input: PlaceQualityInput): PlaceQualityResult {
  const blockers = collectBlockers(input)
  const warnings = collectWarnings(input.place)
  const kind = classifyKind(blockers, warnings)

  return {
    kind,
    blockers,
    warnings,
    path: createPlacePath(input.place),
    contentKey: createPlaceContentKey(input.place),
  }
}

export function createPlaceContentKey(place: PlaceQualityPlace): string | null {
  const name = normalizeContentPart(place.name)
  const address = normalizeContentPart(place.address)

  if (name === null || address === null) {
    return null
  }

  return `${name}|${address}`
}

function collectBlockers(input: PlaceQualityInput): readonly PlaceQualityBlocker[] {
  const blockers: PlaceQualityBlocker[] = []
  const path = createPlacePath(input.place)
  const contentKey = createPlaceContentKey(input.place)

  if (!hasText(input.place.name)) {
    blockers.push("missing_name")
  }
  if (!hasText(input.place.address)) {
    blockers.push("missing_address")
  }
  if (!hasText(input.place.category)) {
    blockers.push("missing_category")
  }
  if (!hasText(input.place.slug)) {
    blockers.push("missing_slug")
  }
  if (hasExistingPlacePage(input.place, input.existingSeoPages)) {
    blockers.push("existing_place_page")
  }
  if (path !== null && input.existingPaths.has(path)) {
    blockers.push("duplicate_path")
  }
  if (contentKey !== null && input.duplicateContentKeys.has(contentKey)) {
    blockers.push("duplicate_content")
  }

  return blockers
}

function collectWarnings(place: PlaceQualityPlace): readonly PlaceQualityWarning[] {
  const warnings: PlaceQualityWarning[] = []

  if (!hasText(place.city)) {
    warnings.push("missing_city")
  }
  if (!hasText(place.district)) {
    warnings.push("missing_district")
  }

  return warnings
}

function classifyKind(
  blockers: readonly PlaceQualityBlocker[],
  warnings: readonly PlaceQualityWarning[],
): PlaceQualityKind {
  if (blockers.length > 0) {
    return "blocked"
  }
  if (warnings.length > 0) {
    return "warning"
  }
  return "eligible"
}

function createPlacePath(place: PlaceQualityPlace): string | null {
  const slug = textValue(place.slug)
  if (slug === null) {
    return null
  }

  return `/places/${slug}`
}

function hasExistingPlacePage(place: PlaceQualityPlace, seoPages: readonly PlaceSeoPageContext[]): boolean {
  return seoPages.some((page) => page.page_type === "place" && page.place_id === place.id)
}

function hasText(value: string | null): boolean {
  return textValue(value) !== null
}

function normalizeContentPart(value: string | null): string | null {
  const text = textValue(value)
  if (text === null) {
    return null
  }

  return text.toLocaleLowerCase("ko-KR").replace(/\s+/g, "")
}

function textValue(value: string | null): string | null {
  const text = value?.trim()
  if (text === undefined || text.length === 0) {
    return null
  }

  return text
}
