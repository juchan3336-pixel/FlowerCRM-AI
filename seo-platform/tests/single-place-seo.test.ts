import { describe, expect, it } from "vitest"

import { generateSinglePlaceSeoPage } from "@/lib/seo-pages/single-place-generation"
import type { PlaceSeoGenerationRepository, SeoPageForPlaceGeneration, SelectablePlaceForSeoGeneration } from "@/lib/seo-pages/place-generation"

describe("single place seo page generation", () => {
  it("creates one ready seo page for an eligible place", async () => {
    // Given: an eligible place with no existing seo page.
    const inserted: SeoPageForPlaceGeneration[] = []
    const repository = fakeRepository([makePlace({})], [], inserted)

    // When: the single-place generation runs.
    const result = await generateSinglePlaceSeoPage({ repository, placeId: "place-1", now: "2026-07-13T00:00:00.000Z" })

    // Then: exactly one ready page is inserted at the place path.
    expect(result).toEqual({ kind: "created", path: "/places/place-1-slug" })
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ place_id: "place-1", page_type: "place", status: "ready", path: "/places/place-1-slug", canonical_url: "/places/place-1-slug" })
  })

  it("does not insert when the place already has a place seo page", async () => {
    // Given: an existing place page.
    const inserted: SeoPageForPlaceGeneration[] = []
    const repository = fakeRepository(
      [makePlace({})],
      [{ place_id: "place-1", page_type: "place", slug: "place-1-slug", path: "/places/place-1-slug", title: null, description: null, canonical_url: null, status: "ready", priority: 0.7, change_frequency: "weekly", last_modified_at: null }],
      inserted,
    )

    // When: the generation runs again.
    const result = await generateSinglePlaceSeoPage({ repository, placeId: "place-1" })

    // Then: the existing page is reported and nothing is inserted.
    expect(result).toEqual({ kind: "already-exists", path: "/places/place-1-slug" })
    expect(inserted).toHaveLength(0)
  })

  it("blocks generation when required fields are missing", async () => {
    // Given: a place without a slug.
    const inserted: SeoPageForPlaceGeneration[] = []
    const repository = fakeRepository([makePlace({ slug: null })], [], inserted)

    // When: the generation runs.
    const result = await generateSinglePlaceSeoPage({ repository, placeId: "place-1" })

    // Then: the quality blocker is surfaced and nothing is inserted.
    expect(result.kind).toBe("blocked")
    expect(result.kind === "blocked" && result.blockers).toContain("missing_slug")
    expect(inserted).toHaveLength(0)
  })

  it("reports a missing place", async () => {
    // Given: an empty repository.
    const repository = fakeRepository([], [], [])

    // When: the generation runs for an unknown id.
    const result = await generateSinglePlaceSeoPage({ repository, placeId: "missing" })

    // Then: the caller can show a clear error.
    expect(result).toEqual({ kind: "missing-place" })
  })
})

function fakeRepository(
  places: readonly SelectablePlaceForSeoGeneration[],
  existingPages: readonly SeoPageForPlaceGeneration[],
  inserted: SeoPageForPlaceGeneration[],
): PlaceSeoGenerationRepository {
  return {
    listSelectedPlaces(placeIds) {
      return Promise.resolve(places.filter((place) => placeIds.includes(place.id)))
    },
    listPlaceSeoPageContexts() {
      return Promise.resolve(existingPages)
    },
    insertReadyPlaceSeoPages(pages) {
      inserted.push(...pages)
      return Promise.resolve(pages.length)
    },
  }
}

function makePlace(overrides: Readonly<Partial<SelectablePlaceForSeoGeneration>>): SelectablePlaceForSeoGeneration {
  return {
    id: "place-1",
    name: "테스트 장소",
    address: "서울 강남구 테헤란로 1",
    category: "funeral",
    slug: "place-1-slug",
    city: "서울",
    district: "강남구",
    description: "적용된 본문",
    meta_title: "적용된 제목",
    meta_description: "적용된 메타",
    ...overrides,
  }
}
