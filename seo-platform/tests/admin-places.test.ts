import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import AdminPlacesPage, { AdminPlacesContent } from "@/app/admin/places/page"
import { loadAdminPlaces } from "@/lib/admin/places"
import type { AdminPlacesRepository } from "@/lib/admin/places"

describe("admin places", () => {
  it("renders fixture-backed admin places headers and safe rows when Supabase env is absent", async () => {
    // Given: the fixture-backed admin places placeholder page.
    const page = await AdminPlacesPage()

    // When: the server component is rendered without live Supabase credentials.
    const markup = renderToStaticMarkup(page)

    // Then: the operational table exposes only public SEO DTO fields.
    for (const header of ["Status", "Name / title", "Category / type", "Region", "Path", "AI state"] as const) {
      expect(markup).toContain(header)
    }
    for (const value of ["서울 서초 장례식장", "부산 해운대 병원", "근조화환 상품 안내", "/products/product-funeral-flower"] as const) {
      expect(markup).toContain(value)
    }
  })

  it("loads Supabase public view rows through the read-only places seam", async () => {
    // Given: a credential-free fake repository matching the public-safe view shape.
    const repository: AdminPlacesRepository = {
      listPublishedPlacePages() {
        return Promise.resolve([
          {
            seo_page_id: "seo_live_1",
            page_type: "funeral",
            page_slug: "funeral-live-test",
            path: "/funeral/funeral-live-test",
            title: "Live funeral page",
            page_description: "Public description",
            canonical_url: "https://seo.paldoflower.test/funeral/funeral-live-test",
            priority: 0.8,
            change_frequency: "weekly",
            last_modified_at: "2026-07-03T00:00:00.000Z",
            place_id: "place_live_1",
            name: "라이브 장례식장",
            category: "funeral",
            detail_category: "전문장례식장",
            region: null,
            city: "서울",
            district: "강남구",
            address: "서울 강남구 테헤란로 1",
            homepage: null,
            place_slug: "live-place",
            order_url: null,
            place_description: "Place description",
            meta_title: "Meta title",
            meta_description: "Meta description",
            faq: [],
            keywords: [],
            internal_links: [],
          },
        ])
      },
    }

    // When: places are loaded and rendered through the same admin content component.
    const places = await loadAdminPlaces(repository)
    const markup = renderToStaticMarkup(createElement(AdminPlacesContent, { places }))

    // Then: public view values render without relying on live Supabase credentials.
    expect(places.source).toBe("supabase")
    expect(markup).toContain("Supabase public-safe view")
    expect(markup).toContain("라이브 장례식장")
    expect(markup).toContain("전문장례식장")
    expect(markup).toContain("서울 · 강남구")
    expect(markup).toContain("/funeral/funeral-live-test")
  })

  it("renders non-functional places filter placeholders", async () => {
    // Given: the fixture-backed admin places placeholder page.
    const page = await AdminPlacesPage()

    // When: the server component is rendered to static markup.
    const markup = renderToStaticMarkup(page)

    // Then: planned filters are visible but not wired to live data.
    for (const label of ["Search", "Category", "City / district", "Status", "AI state"] as const) {
      expect(markup).toContain(label)
    }
    expect(markup).toContain("Filter controls are placeholders")
  })

  it("does not expose private fixture tokens in the admin places list", async () => {
    // Given: fixtures include private source metadata that must not cross this page boundary.
    const page = await AdminPlacesPage()

    // When: the public DTO-backed list is rendered.
    const markup = renderToStaticMarkup(page)

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
})
