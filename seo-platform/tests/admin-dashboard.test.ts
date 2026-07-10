import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import AdminDashboardPage, { AdminDashboardContent } from "@/app/admin/page"
import { loadAdminDashboard } from "@/lib/admin/dashboard"
import type { AdminDashboardRepositories } from "@/lib/admin/dashboard"
import type { AdminPlacesRepository } from "@/lib/admin/places"
import type { PlaceRow } from "@/types/database"

describe("admin dashboard", () => {
  it("shows the exact places count from the count query, not the capped row list", async () => {
    // Given: the count query reports the full table size while the row list is capped.
    const repository: AdminPlacesRepository = {
      countPlaces() {
        return Promise.resolve(6595)
      },
      listPlaces() {
        return Promise.resolve(makePlaceRows(1000))
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

    // Then: the total places stat reflects the actual places count.
    expect(dashboard.totalPlaces).toBe(6595)
    expect(dashboard.cards.find((card) => card.label === "전체 장소")?.value).toBe("6,595")
    expect(markup).toContain("6,595")
  })

  it("builds task cards from exact operational counts when the repository provides them", async () => {
    // Given: a repository that exposes the operational count queries.
    const repository: AdminPlacesRepository = {
      countPlaces() {
        return Promise.resolve(6595)
      },
      listPlaces() {
        return Promise.resolve(makePlaceRows(1000))
      },
      countPlaceSeoPages() {
        return Promise.resolve(0)
      },
      listPlaceSeoPages() {
        return Promise.resolve([])
      },
      countPlacesMissingAiContent() {
        return Promise.resolve(6595)
      },
      countReadyPlaceSeoPages() {
        return Promise.resolve(12)
      },
      countPublishedPlaceSeoPages() {
        return Promise.resolve(34)
      },
    }

    // When: the summary loads.
    const dashboard = await loadAdminDashboard({ places: repository })

    // Then: every task card carries the exact count and links to its work queue.
    const byKey = new Map(dashboard.tasks.map((task) => [task.key, task]))
    expect(byKey.get("ai-missing")?.value).toBe("6,595")
    expect(byKey.get("ai-missing")?.href).toBe("/admin/places?task=ai-missing")
    expect(byKey.get("publish-pending")?.value).toBe("12")
    expect(byKey.get("publish-pending")?.href).toBe("/admin/places?task=publish-pending")
    expect(byKey.get("published")?.value).toBe("34")
    expect(byKey.get("published")?.href).toBe("/admin/places?task=published")
    expect(byKey.get("google-index")?.value).toBe("Search Console 연동 전")
    expect(byKey.get("google-index")?.href).toBeUndefined()
    expect(byKey.get("sync-errors")?.href).toBe("/admin/sync")
  })

  it("renders the dashboard shell with the operations heading", async () => {
    // Given: the default dashboard page.
    const page = await AdminDashboardPage()

    // When: the server component renders.
    const markup = renderToStaticMarkup(page)

    // Then: the dashboard shell shows the operations-first copy.
    expect(markup).toContain("SEO 운영 현황")
    expect(markup).toContain("오늘 해야 할 작업")
    expect(markup).toContain("AI 생성 안됨")
    expect(markup).toContain("게시 대기")
    expect(markup).toContain("게시 완료")
    expect(markup).toContain("Search Console 연동 전")
    expect(markup).toContain("동기화 오류")
    expect(markup).not.toContain("Fixture")
    expect(markup).not.toContain("미리보기만")
    expect(markup).not.toContain("completed")
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
