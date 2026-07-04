import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import AdminSeoPagesPage, { AdminSeoPagesContent } from "@/app/admin/seo-pages/page"
import { loadAdminSeoPages } from "@/lib/admin/seo-pages"
import type { AdminSeoPagesRepository } from "@/lib/admin/seo-pages"
import { PUBLIC_SEO_FIXTURES } from "@/lib/public-seo/fixtures"
import { listPublishedPublicPages } from "@/lib/public-seo/public-pages"

const HEADER_LABELS = ["SEO Pages", "Page type", "Path", "Canonical URL", "Status", "Sitemap", "Priority", "Change frequency"] as const
const FILTER_LABELS = ["Page type filter", "Status filter", "Sitemap inclusion filter", "Canonical health filter"] as const
const PRIVATE_TOKENS = [
  "email",
  "memo",
  "imported_payload",
  "synced_at",
  "service_role",
  "SUPABASE_SERVICE_ROLE_KEY",
  "private@example.com",
  "010-9999-0000",
] as const

describe("admin SEO pages overview", () => {
  it("renders fixture-backed headers and safe public rows when Supabase env is absent", async () => {
    // Given: the SEO pages admin overview server component.
    const pages = listPublishedPublicPages(PUBLIC_SEO_FIXTURES)

    // When: the page renders from public SEO DTO fixtures.
    const markup = renderToStaticMarkup(await AdminSeoPagesPage())

    // Then: table headers and every published public fixture row are visible.
    for (const label of HEADER_LABELS) {
      expect(markup).toContain(label)
    }
    for (const page of pages) {
      expect(markup).toContain(page.type)
      expect(markup).toContain(page.path)
      expect(markup).toContain(page.canonicalUrl)
      expect(markup).toContain(String(page.priority))
      expect(markup).toContain(page.changeFrequency)
    }
  })

  it("loads Supabase public view rows through the read-only SEO pages seam", async () => {
    // Given: a credential-free fake repository matching the public-safe view shape.
    const repository: AdminSeoPagesRepository = {
      listPublishedPlacePages() {
        return Promise.resolve([
          {
            seo_page_id: "seo_live_1",
            page_type: "hospital",
            page_slug: "hospital-live-test",
            path: "/hospital/hospital-live-test",
            title: "Live hospital page",
            page_description: "Public description",
            canonical_url: "https://seo.paldoflower.test/hospital/hospital-live-test",
            priority: 0.8,
            change_frequency: "weekly",
            last_modified_at: "2026-07-03T00:00:00.000Z",
            place_id: "place_live_1",
            name: "라이브 병원",
            category: "hospital",
            detail_category: "종합병원",
            region: "서울 강남구",
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

    // When: SEO pages are loaded and rendered through the same admin content component.
    const seoPages = await loadAdminSeoPages(repository)
    const markup = renderToStaticMarkup(createElement(AdminSeoPagesContent, { seoPages }))

    // Then: public view values render without live Supabase credentials.
    expect(seoPages.source).toBe("supabase")
    expect(markup).toContain("Supabase public-safe view")
    expect(markup).toContain("hospital")
    expect(markup).toContain("/hospital/hospital-live-test")
    expect(markup).toContain("https://seo.paldoflower.test/hospital/hospital-live-test")
    expect(markup).toContain("weekly")
  })

  it("renders placeholder filters and status controls without mutation wiring", async () => {
    // Given: fixture-backed admin page filters are display-only in this slice.
    // When: the page renders as static markup.
    const markup = renderToStaticMarkup(await AdminSeoPagesPage())

    // Then: all filter placeholders and disabled status controls are present.
    for (const label of FILTER_LABELS) {
      expect(markup).toContain(label)
    }
    expect(markup).toContain("Filter placeholders only")
    expect(markup).toContain("Status changes are placeholder-only")
    expect(markup).toContain("disabled")
  })

  it("shows sitemap inclusion and canonical health without private tokens", async () => {
    // Given: public SEO fixtures include private source fields outside DTOs.
    // When: the admin overview renders public DTO and sitemap-derived state.
    const markup = renderToStaticMarkup(await AdminSeoPagesPage())

    // Then: sitemap/canonical status is visible and private/service-role tokens never render.
    expect(markup).toContain("Included in sitemap")
    expect(markup).toContain("Canonical healthy")
    for (const token of PRIVATE_TOKENS) {
      expect(markup).not.toContain(token)
    }
  })
})
