import { describe, expect, it } from "vitest"
import {
  classifyPlaceQuality,
  createPlaceContentKey,
  type PlaceQualityInput,
} from "@/lib/seo-pages/place-quality"
import {
  generateSelectedPlaceSeoPages,
  type PlaceSeoGenerationRepository,
  type SelectablePlaceForSeoGeneration,
  type SeoPageForPlaceGeneration,
} from "@/lib/seo-pages/place-generation"

const READY_PLACE = {
  id: "place_1",
  name: "부산 중앙병원",
  address: "부산 해운대구 센텀중앙로 1",
  category: "hospital",
  slug: "hospital-busan-haeundae-busan-central",
  city: "부산",
  district: "해운대구",
}

function qualityInput(overrides: Partial<PlaceQualityInput> = {}): PlaceQualityInput {
  return {
    place: READY_PLACE,
    existingSeoPages: [],
    existingPaths: new Set(),
    duplicateContentKeys: new Set(),
    ...overrides,
  }
}

describe("place SEO generation quality", () => {
  it("marks a complete place row eligible", () => {
    const result = classifyPlaceQuality(qualityInput())

    expect(result.kind).toBe("eligible")
    expect(result.path).toBe("/places/hospital-busan-haeundae-busan-central")
    expect(result.warnings).toEqual([])
  })

  it("blocks required blank fields with stable reason codes", () => {
    const cases = [
      { field: "name", value: " ", blocker: "missing_name" },
      { field: "address", value: null, blocker: "missing_address" },
      { field: "category", value: "", blocker: "missing_category" },
      { field: "slug", value: "\t", blocker: "missing_slug" },
    ]

    for (const current of cases) {
      const result = classifyPlaceQuality(
        qualityInput({
          place: { ...READY_PLACE, [current.field]: current.value },
        }),
      )

      expect(result.kind).toBe("blocked")
      expect(result.blockers).toContain(current.blocker)
    }
  })

  it("keeps city and district gaps as warnings while selectable", () => {
    const result = classifyPlaceQuality(
      qualityInput({
        place: { ...READY_PLACE, city: " ", district: null },
      }),
    )

    expect(result.kind).toBe("warning")
    expect(result.blockers).toEqual([])
    expect(result.warnings).toEqual(["missing_city", "missing_district"])
    expect(result.path).toBe("/places/hospital-busan-haeundae-busan-central")
  })

  it("blocks a place that already has a place SEO page", () => {
    const result = classifyPlaceQuality(
      qualityInput({
        existingSeoPages: [
          {
            place_id: READY_PLACE.id,
            page_type: "place",
            path: "/places/other",
          },
        ],
      }),
    )

    expect(result.kind).toBe("blocked")
    expect(result.blockers).toContain("existing_place_page")
  })

  it("blocks a duplicate place path", () => {
    const result = classifyPlaceQuality(
      qualityInput({
        existingPaths: new Set(["/places/hospital-busan-haeundae-busan-central"]),
      }),
    )

    expect(result.kind).toBe("blocked")
    expect(result.blockers).toContain("duplicate_path")
  })

  it("blocks duplicate normalized name and address content", () => {
    const contentKey = createPlaceContentKey(READY_PLACE)

    expect(contentKey).toBe("부산중앙병원|부산해운대구센텀중앙로1")
    if (contentKey === null) {
      return
    }

    const result = classifyPlaceQuality(
      qualityInput({
        duplicateContentKeys: new Set([contentKey]),
      }),
    )

    expect(result.kind).toBe("blocked")
    expect(result.blockers).toContain("duplicate_content")
  })
})

const NOW = "2026-07-07T00:00:00.000Z"

function selectedPlace(index: number, overrides: Partial<SelectablePlaceForSeoGeneration> = {}): SelectablePlaceForSeoGeneration {
  const placeNumber = String(index)
  return {
    id: `place_${placeNumber}`,
    name: `부산 병원 ${placeNumber}`,
    address: `부산 해운대구 센텀로 ${placeNumber}`,
    category: "hospital",
    slug: `busan-hospital-${placeNumber}`,
    city: "부산",
    district: "해운대구",
    description: `부산 병원 ${placeNumber} 상세 안내`,
    meta_title: `부산 병원 ${placeNumber} | 전국팔도꽃배달`,
    meta_description: `부산 병원 ${placeNumber} 근처 화환 배송 안내`,
    ...overrides,
  }
}

class InMemoryPlaceSeoGenerationRepository implements PlaceSeoGenerationRepository {
  readonly places: ReadonlyMap<string, SelectablePlaceForSeoGeneration>
  readonly existingPages: readonly SeoPageForPlaceGeneration[]
  readonly inserted: SeoPageForPlaceGeneration[] = []

  constructor(input: Readonly<{ places: readonly SelectablePlaceForSeoGeneration[]; existingPages?: readonly SeoPageForPlaceGeneration[] }>) {
    this.places = new Map(input.places.map((place) => [place.id, place]))
    this.existingPages = input.existingPages ?? []
  }

  listSelectedPlaces(placeIds: readonly string[]): Promise<readonly SelectablePlaceForSeoGeneration[]> {
    return Promise.resolve(placeIds.flatMap((placeId) => {
      const place = this.places.get(placeId)
      return place === undefined ? [] : [place]
    }))
  }

  listPlaceSeoPageContexts(): Promise<readonly SeoPageForPlaceGeneration[]> {
    return Promise.resolve([...this.existingPages, ...this.inserted])
  }

  insertReadyPlaceSeoPages(pages: readonly SeoPageForPlaceGeneration[]): Promise<number> {
    this.inserted.push(...pages)
    return Promise.resolve(pages.length)
  }
}

describe("selected place SEO page generation", () => {
  it("creates 50 ready place pages and no published pages", async () => {
    const places = Array.from({ length: 50 }, (_, index) => selectedPlace(index + 1))
    const repository = new InMemoryPlaceSeoGenerationRepository({ places })

    const result = await generateSelectedPlaceSeoPages({ repository, placeIds: places.map((place) => place.id), now: NOW })

    expect(result).toEqual({ kind: "created", selected: 50, created: 50, blocked: 0, warnings: 0, errors: [] })
    expect(repository.inserted).toHaveLength(50)
    expect(repository.inserted.every((page) => page.status === "ready")).toBe(true)
    expect(repository.inserted.some((page) => page.status === "published")).toBe(false)
    expect(repository.inserted[0]).toMatchObject({
      page_type: "place",
      slug: "busan-hospital-1",
      path: "/places/busan-hospital-1",
      title: "부산 병원 1 | 전국팔도꽃배달",
      description: "부산 병원 1 근처 화환 배송 안내",
      canonical_url: "/places/busan-hospital-1",
      priority: 0.7,
      change_frequency: "weekly",
      last_modified_at: NOW,
    })
  })

  it("creates 100 ready place pages at the upper selected limit", async () => {
    const places = Array.from({ length: 100 }, (_, index) => selectedPlace(index + 1))
    const repository = new InMemoryPlaceSeoGenerationRepository({ places })

    const result = await generateSelectedPlaceSeoPages({ repository, placeIds: places.map((place) => place.id), now: NOW })

    expect(result).toEqual({ kind: "created", selected: 100, created: 100, blocked: 0, warnings: 0, errors: [] })
    expect(repository.inserted).toHaveLength(100)
  })

  it("rejects 101 selected IDs without writes", async () => {
    const placeIds = Array.from({ length: 101 }, (_, index) => `place_${String(index + 1)}`)
    const repository = new InMemoryPlaceSeoGenerationRepository({ places: [] })

    const result = await generateSelectedPlaceSeoPages({ repository, placeIds, now: NOW })

    expect(result).toEqual({ kind: "rejected", reason: "SampleLimitExceeded", selected: 101, created: 0, blocked: 0, warnings: 0, errors: [] })
    expect(repository.inserted).toEqual([])
  })

  it.each([1, 49] as const)("rejects %i selected IDs without writes", async (selectedCount) => {
    const places = Array.from({ length: selectedCount }, (_, index) => selectedPlace(index + 1))
    const repository = new InMemoryPlaceSeoGenerationRepository({ places })

    const result = await generateSelectedPlaceSeoPages({ repository, placeIds: places.map((place) => place.id), now: NOW })

    expect(result).toEqual({ kind: "rejected", reason: "SampleMinimumNotMet", selected: selectedCount, created: 0, blocked: 0, warnings: 0, errors: [] })
    expect(repository.inserted).toEqual([])
  })

  it("rejects empty selection without writes", async () => {
    const repository = new InMemoryPlaceSeoGenerationRepository({ places: [] })

    const result = await generateSelectedPlaceSeoPages({ repository, placeIds: [], now: NOW })

    expect(result).toEqual({ kind: "rejected", reason: "EmptySelection", selected: 0, created: 0, blocked: 0, warnings: 0, errors: [] })
    expect(repository.inserted).toEqual([])
  })

  it("skips duplicate, already-paged, missing-required, and unreturned selected rows", async () => {
    const first = selectedPlace(1)
    const duplicate = selectedPlace(2, { address: first.address, name: first.name })
    const alreadyPaged = selectedPlace(3)
    const missingRequired = selectedPlace(4, { slug: null })
    const warning = selectedPlace(5, { city: null })
    const existingPage = pageFor(alreadyPaged, "published")
    const eligiblePlaces = Array.from({ length: 44 }, (_, index) => selectedPlace(index + 6))
    const repository = new InMemoryPlaceSeoGenerationRepository({ places: [first, duplicate, alreadyPaged, missingRequired, warning, ...eligiblePlaces], existingPages: [existingPage] })

    const result = await generateSelectedPlaceSeoPages({ repository, placeIds: [first.id, duplicate.id, alreadyPaged.id, missingRequired.id, warning.id, "missing", ...eligiblePlaces.map((place) => place.id)], now: NOW })

    expect(result).toEqual({ kind: "created", selected: 50, created: 46, blocked: 4, warnings: 1, errors: [] })
    expect(repository.inserted.map((page) => page.place_id)).toEqual([first.id, warning.id, ...eligiblePlaces.map((place) => place.id)])
    expect(repository.existingPages).toEqual([existingPage])
  })

  it("does not overwrite a published existing place page", async () => {
    const place = selectedPlace(1, { meta_title: "New title" })
    const existingPage = pageFor(place, "published")
    const eligiblePlaces = Array.from({ length: 49 }, (_, index) => selectedPlace(index + 2))
    const repository = new InMemoryPlaceSeoGenerationRepository({ places: [place, ...eligiblePlaces], existingPages: [existingPage] })

    const result = await generateSelectedPlaceSeoPages({ repository, placeIds: [place.id, ...eligiblePlaces.map((eligiblePlace) => eligiblePlace.id)], now: NOW })

    expect(result).toEqual({ kind: "created", selected: 50, created: 49, blocked: 1, warnings: 0, errors: [] })
    expect(repository.inserted.map((page) => page.place_id)).toEqual(eligiblePlaces.map((eligiblePlace) => eligiblePlace.id))
    expect(repository.existingPages[0]).toEqual(existingPage)
  })
})

function pageFor(place: SelectablePlaceForSeoGeneration, status: SeoPageForPlaceGeneration["status"]): SeoPageForPlaceGeneration {
  return {
    place_id: place.id,
    page_type: "place",
    slug: place.slug ?? place.id,
    path: `/places/${place.slug ?? place.id}`,
    title: place.meta_title,
    description: place.meta_description,
    canonical_url: `/places/${place.slug ?? place.id}`,
    status,
    priority: 0.7,
    change_frequency: "weekly",
    last_modified_at: NOW,
  }
}
