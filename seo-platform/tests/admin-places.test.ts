import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { AdminPlacesContent } from "@/app/admin/places/page"
import { loadAdminPlaces } from "@/lib/admin/places"
import type { AdminPlacesRepository } from "@/lib/admin/places"
import type { PlaceRow, SeoPageRow } from "@/types/database"

describe("admin places", () => {
  it("renders 6595 live rows without placeholder controls", async () => {
    // Given: the live places table receives the same scale as production.
    const repository: AdminPlacesRepository = {
      countPlaces() {
        return Promise.resolve(6595)
      },
      listPlaces() {
        return Promise.resolve(makePlaceRows(6595))
      },
      countPlaceSeoPages() {
        return Promise.resolve(6595)
      },
      listPlaceSeoPages() {
        return Promise.resolve(makeSeoPageRows(6595))
      },
    }

    // When: the same admin content component renders real Supabase-shaped rows.
    const places = await loadAdminPlaces({ places: repository }, { supabaseUrlHostOrRef: "project.supabase.co" })
    const markup = renderToStaticMarkup(createElement(AdminPlacesContent, { places }))

    // Then: the page uses the live data copy and shows the production-sized row count.
    expect(places.source).toBe("live")
    expect(markup).toContain("장소관리")
    expect(markup).toContain("6595행")
    expect(markup).toContain("데이터 소스")
    expect(markup).toContain("live")
    expect(markup).toContain("places 조회 수")
    expect(markup).toContain("seo_pages 장소 수")
    expect(markup).toContain("Supabase URL 호스트/참조")
    expect(markup).toContain("project.supabase.co")
    expect(markup).toContain("쿼리 오류")
    expect(markup).toContain("최근 조회 시각")
  })

  it("loads Supabase place rows through the read-only places seam", async () => {
    // Given: a credential-free fake repository matching the places-table shape.
    const repository: AdminPlacesRepository = {
      countPlaces() {
        return Promise.resolve(2)
      },
      listPlaces() {
        return Promise.resolve([
          placeRow({ id: "place_live_1", name: "라이브 장소", category: "funeral", detailCategory: "전문장례식장", status: "published", city: "서울", district: "강남구", description: "Applied description" }),
          placeRow({ id: "place_live_2", name: "비공개 장소", category: "hospital", detailCategory: null, status: "noindex", city: "부산", district: "해운대구" }),
        ])
      },
      countPlaceSeoPages() {
        return Promise.resolve(2)
      },
      listPlaceSeoPages() {
        return Promise.resolve([
          seoPageRow({ place_id: "place_live_1", status: "published" }),
          seoPageRow({ place_id: "place_live_2", status: "draft" }),
        ])
      },
    }

    // When: places are loaded and rendered through the same admin content component.
    const places = await loadAdminPlaces({ places: repository }, { supabaseUrlHostOrRef: "project.supabase.co" })
    const markup = renderToStaticMarkup(createElement(AdminPlacesContent, { places }))

    // Then: direct table values render without relying on live Supabase credentials.
    expect(places.source).toBe("live")
    expect(markup).toContain("Supabase places table")
    expect(markup).toContain("라이브 장소")
    expect(markup).toContain("전문장례식장")
    expect(markup).toContain("서울 · 강남구")
    expect(markup).toContain("적용됨")
    expect(markup).toContain("published")
  })

  it("shows only matching rows when a task filter is active", async () => {
    // Given: one place already has applied AI content and one is still waiting.
    const repository: AdminPlacesRepository = {
      countPlaces() {
        return Promise.resolve(2)
      },
      listPlaces() {
        return Promise.resolve([
          placeRow({ id: "place_live_1", name: "라이브 장소", category: "funeral", detailCategory: "전문장례식장", status: "published", city: "서울", district: "강남구", description: "Applied description" }),
          placeRow({ id: "place_live_2", name: "비공개 장소", category: "hospital", detailCategory: null, status: "noindex", city: "부산", district: "해운대구" }),
        ])
      },
      countPlaceSeoPages() {
        return Promise.resolve(2)
      },
      listPlaceSeoPages() {
        return Promise.resolve([
          seoPageRow({ place_id: "place_live_1", status: "published" }),
          seoPageRow({ place_id: "place_live_2", status: "draft" }),
        ])
      },
    }

    // When: the places content renders with the AI task filter.
    const places = await loadAdminPlaces({ places: repository }, { supabaseUrlHostOrRef: "project.supabase.co" })
    const markup = renderToStaticMarkup(createElement(AdminPlacesContent, { places, taskFilter: "ai-missing" }))

    // Then: only the place without AI content stays visible and the filter can be cleared.
    expect(markup).toContain("비공개 장소")
    expect(markup).not.toContain("라이브 장소")
    expect(markup).toContain("전체 목록 보기")
    expect(markup).toContain("1행")
  })

  it("does not expose private fixture tokens in the admin places list", async () => {
    // Given: live places rows include only public-safe data in the UI.
    const repository: AdminPlacesRepository = {
      countPlaces() {
        return Promise.resolve(2)
      },
      listPlaces() {
        return Promise.resolve(makePlaceRows(2))
      },
      countPlaceSeoPages() {
        return Promise.resolve(2)
      },
      listPlaceSeoPages() {
        return Promise.resolve(makeSeoPageRows(2))
      },
    }

    const places = await loadAdminPlaces({ places: repository }, { supabaseUrlHostOrRef: "project.supabase.co" })

    // When: the component is rendered.
    const markup = renderToStaticMarkup(createElement(AdminPlacesContent, { places }))

    // Then: private fields and fixture secret values are absent from markup.
    for (const privateToken of [
      "private@example.com",
      "internal memo",
      "imported_payload",
      "synced_at",
      "service_role",
      "SUPABASE_SERVICE_ROLE_KEY",
      "010-9999-0000",
    ] as const) {
      expect(markup).not.toContain(privateToken)
    }
  })

  it("renders an error diagnostics box when the Supabase repository fails", async () => {
    const error = new Error("RLS denied places count") as Error & { code: string }
    error.code = "PGRST301"

    const repository: AdminPlacesRepository = {
      countPlaces() {
        return Promise.reject(error)
      },
      listPlaces() {
        return Promise.resolve([])
      },
      countPlaceSeoPages() {
        return Promise.resolve(0)
      },
      listPlaceSeoPages() {
        return Promise.resolve([])
      },
    }

    const places = await loadAdminPlaces({ places: repository }, { supabaseUrlHostOrRef: "project.supabase.co" })
    const markup = renderToStaticMarkup(createElement(AdminPlacesContent, { places }))

    expect(places.source).toBe("error")
    expect(markup).toContain("오류")
    expect(markup).toContain("PGRST301")
    expect(markup).toContain("RLS denied places count")
  })

  it("renders an environment missing error when no Supabase repository is available", async () => {
    const places = await loadAdminPlaces({}, { supabaseUrlHostOrRef: null })
    const markup = renderToStaticMarkup(createElement(AdminPlacesContent, { places }))

    expect(places.source).toBe("error")
    expect(markup).toContain("오류")
    expect(markup).toContain("environment missing")
    expect(markup).toContain("데이터 소스")
    expect(markup).toContain("쿼리 오류")
  })
})

function makePlaceRows(count: number): readonly PlaceRow[] {
  return Array.from({ length: count }, (_, index) => makePlaceRow(index + 1))
}

function makeSeoPageRows(count: number): readonly Pick<SeoPageRow, "place_id" | "status">[] {
  return Array.from({ length: count }, (_, index) => ({
    place_id: `place_${String(index + 1).padStart(4, "0")}`,
    status: index % 2 === 0 ? "published" : "ready",
  }))
}

function makePlaceRow(index: number): PlaceRow {
  const suffix = String(index).padStart(4, "0")
  return {
    id: `place_${suffix}`,
    source: "google_sheets",
    source_sheet_name: null,
    source_row_number: index,
    source_key: `source_${suffix}`,
    name: `장소 ${suffix}`,
    normalized_name: `장소 ${suffix}`,
    category: index % 2 === 0 ? "hospital" : "funeral",
    detail_category: null,
    region: "부산 해운대구",
    city: "부산",
    district: "해운대구",
    address: `부산 해운대구 센텀로 ${String(index)}`,
    normalized_address: `부산 해운대구 센텀로 ${String(index)}`,
    phone: null,
    normalized_phone: null,
    homepage: null,
    email: null,
    source_url: null,
    collected_at: null,
    grade: null,
    sales_status: null,
    memo: null,
    lat: null,
    lng: null,
    slug: `place-${suffix}`,
    status: "published",
    order_url: null,
    description: index % 2 === 0 ? `설명 ${suffix}` : null,
    meta_title: null,
    meta_description: null,
    faq: [],
    keywords: [],
    internal_links: [],
    imported_payload: null,
    synced_at: null,
    created_at: "2026-07-07T00:00:00.000Z",
    updated_at: "2026-07-07T00:00:00.000Z",
  }
}

function placeRow(input: Readonly<{
  id: string
  name: string
  category: string
  detailCategory: string | null
  status: PlaceRow["status"]
  city: string | null
  district: string | null
  description?: string | null
}>): PlaceRow {
  return {
    id: input.id,
    source: "google_sheets",
    source_sheet_name: null,
    source_row_number: null,
    source_key: `${input.id}_source_key`,
    name: input.name,
    normalized_name: input.name,
    category: input.category,
    detail_category: input.detailCategory,
    region: null,
    city: input.city,
    district: input.district,
    address: "서울 강남구 테헤란로 1",
    normalized_address: null,
    phone: null,
    normalized_phone: null,
    homepage: null,
    email: null,
    source_url: null,
    collected_at: null,
    grade: null,
    sales_status: null,
    memo: null,
    lat: null,
    lng: null,
    slug: `${input.id}-slug`,
    status: input.status,
    order_url: null,
    description: input.description ?? null,
    meta_title: null,
    meta_description: null,
    faq: [],
    keywords: [],
    internal_links: [],
    imported_payload: null,
    synced_at: null,
    created_at: "2026-07-07T00:00:00.000Z",
    updated_at: "2026-07-07T00:00:00.000Z",
  }
}

function seoPageRow(input: Readonly<{ place_id: string | null; status: SeoPageRow["status"] }>): Pick<SeoPageRow, "place_id" | "status"> {
  return {
    place_id: input.place_id,
    status: input.status,
  }
}
