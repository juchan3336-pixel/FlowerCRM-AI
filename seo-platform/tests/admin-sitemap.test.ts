import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import AdminSitemapPage, { AdminSitemapContent } from "@/app/admin/sitemap/page"
import { loadAdminSitemap } from "@/lib/admin/sitemap"
import type { AdminSitemapRepository } from "@/lib/admin/sitemap"
import { PRODUCTION_SITE_URL } from "@/lib/site-url"

describe("admin sitemap", () => {
  it("renders fixture-backed sitemap and robots status values when Supabase env is absent", async () => {
    // Given: the fixture-backed admin sitemap placeholder page.
    const page = await AdminSitemapPage()

    // When: the server component is rendered without live search provider credentials.
    const markup = renderToStaticMarkup(page)

    // Then: deterministic public SEO status values are visible.
		for (const value of [
			"사이트맵 및 robots 상태",
			`${PRODUCTION_SITE_URL}/sitemap.xml`,
			`${PRODUCTION_SITE_URL}/robots.txt`,
      "게시된 URL",
      "4",
      "비공개/초안 제외",
      "2",
      "검색 검증 자리표시자",
      "Google verification placeholder",
      "Naver verification placeholder",
    ] as const) {
      expect(markup).toContain(value)
    }
  })

  it("loads Supabase public view rows through the read-only sitemap seam", async () => {
    // Given: a credential-free fake repository matching the public-safe view shape.
    const repository: AdminSitemapRepository = {
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

    // When: sitemap status is loaded and rendered through the same admin content component.
    const sitemapStatus = await loadAdminSitemap(repository)
    const markup = renderToStaticMarkup(createElement(AdminSitemapContent, { sitemapStatus }))

    // Then: public view canonical URLs render without live Supabase credentials.
    expect(sitemapStatus.source).toBe("supabase")
    expect(markup).toContain("Supabase 공개 안전 뷰")
		expect(markup).toContain(`${PRODUCTION_SITE_URL}/funeral/funeral-live-test`)
    expect(markup).toContain("weekly")
    expect(markup).toContain("0.8")
    expect(markup).toContain("게시된 URL")
    expect(markup).toContain("1")
  })

  it("lists included public URLs without private draft or admin URLs", async () => {
    // Given: the fixture-backed admin sitemap placeholder page.
    const page = await AdminSitemapPage()

    // When: rendered from public SEO fixture modules only.
    const markup = renderToStaticMarkup(page)

    // Then: sitemap entries are public local paths while draft and admin records stay excluded.
		for (const publicUrl of [
			`${PRODUCTION_SITE_URL}/area/area-seoul-seocho`,
			`${PRODUCTION_SITE_URL}/funeral/funeral-seoul-seocho`,
			`${PRODUCTION_SITE_URL}/hospital/hospital-busan-haeundae`,
			`${PRODUCTION_SITE_URL}/products/product-funeral-flower`,
		] as const) {
      expect(markup).toContain(publicUrl)
    }
    for (const excludedToken of ["draft-funeral", "https://seo.example.com/admin/leak"] as const) {
      expect(markup).not.toContain(excludedToken)
    }
  })

  it("renders robots disallowed paths and non-functional controls", async () => {
    // Given: the fixture-backed admin sitemap placeholder page.
    const page = await AdminSitemapPage()

    // When: the page is rendered to static markup.
    const markup = renderToStaticMarkup(page)

    // Then: robots exclusions and planned controls are visible but not automated.
    for (const value of ["/admin", "/api", "/login", "/private", "사이트맵 열기", "robots 열기", "나중에 검증"] as const) {
      expect(markup).toContain(value)
    }
    expect(markup).toContain("검증 자동화는 이 읽기 전용 단계에서 intentionally 연결하지 않았습니다")
    expect(markup).toContain("disabled")
  })

  it("does not expose private tokens in the admin sitemap placeholder", async () => {
    // Given: sitemap fixtures contain private source metadata near public SEO fields.
    const page = await AdminSitemapPage()

    // When: the public SEO module-backed status page is rendered.
    const markup = renderToStaticMarkup(page)

    // Then: no private source values, service-role names, or verification secrets cross the UI boundary.
    for (const privateToken of [
      "SUPABASE_SERVICE_ROLE_KEY",
      "service_role",
      "service-role",
      "GOOGLE_SERVICE_ACCOUNT_JSON",
      "OPENAI_API_KEY",
      "Bearer ",
      "refresh_token",
      "private@example.com",
      "010-9999-0000",
      "imported_payload",
      "internal memo",
    ] as const) {
      expect(markup).not.toContain(privateToken)
    }
  })
})
