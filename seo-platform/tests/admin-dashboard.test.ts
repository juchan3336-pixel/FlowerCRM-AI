import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import AdminDashboardPage, { AdminDashboardContent } from "@/app/admin/page"
import { loadAdminDashboard } from "@/lib/admin/dashboard"
import type { AdminDashboardRepositories } from "@/lib/admin/dashboard"
import type { AdminPlacesRepository } from "@/lib/admin/places"
import type { PlaceRow } from "@/types/database"

describe("admin dashboard", () => {
  it("counts places from the places table seam", async () => {
    // Given: the dashboard receives a read-only places-table repository.
    const repository: AdminPlacesRepository = {
      countPlaces() {
        return Promise.resolve(6595)
      },
      listPlaces() {
        return Promise.resolve(makePlaceRows(6595))
      },
      countPlaceSeoPages() {
        return Promise.resolve(0)
      },
      listPlaceSeoPages() {
        return Promise.resolve([])
      },
    }

    // When: the summary loads and renders.
    const repositories: AdminDashboardRepositories = { places: repository }
    const dashboard = await loadAdminDashboard(repositories)
    const markup = renderToStaticMarkup(createElement(AdminDashboardContent, { dashboard }))

    // Then: the Places card reflects the actual places count.
    expect(dashboard.cards.find((card) => card.label === "Places")?.value).toBe("6595")
    expect(markup).toContain("6595")
  })

  it("renders the dashboard shell with the admin overview heading", async () => {
    // Given: the default dashboard page.
    const page = await AdminDashboardPage()

    // When: the server component renders.
    const markup = renderToStaticMarkup(page)

    // Then: the dashboard shell remains intact.
    expect(markup).toContain("Admin overview")
    expect(markup).toContain("Places")
  })
})

function makePlaceRows(count: number): readonly PlaceRow[] {
  return Array.from({ length: count }, (_, index) => makePlaceRow(index))
}

function makePlaceRow(index: number): PlaceRow {
  const suffix = String(index + 1).padStart(4, "0")
  const ordinal = String(index + 1)

  return {
    id: `place_${suffix}`,
    source: "google_sheets",
    source_sheet_name: null,
    source_row_number: index + 1,
    source_key: `source_${suffix}`,
    name: `Place ${suffix}`,
    normalized_name: `Place ${suffix}`,
    category: "funeral",
    detail_category: index % 2 === 0 ? "장례식장" : null,
    region: "부산 해운대구",
    city: "부산",
    district: "해운대구",
    address: `부산 해운대구 센텀로 ${ordinal}`,
    normalized_address: `부산 해운대구 센텀로 ${ordinal}`,
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
    description: index % 2 === 0 ? `Applied description ${suffix}` : null,
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
