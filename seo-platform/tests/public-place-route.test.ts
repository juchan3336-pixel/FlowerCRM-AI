import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import PlacesPage, { generateMetadata, generateStaticParams } from "@/app/places/[slug]/page"
import { DEFAULT_ORDER_URL, PUBLIC_SEO_FIXTURES } from "@/lib/public-seo/fixtures"
import { buildJsonLdObjects, findPublicPageByTypeAndSlug, scanPublicPayloadForPrivateData } from "@/lib/public-seo/public-pages"

const PUBLISHED_PLACE_SLUG = "place-busan-haeundae-flower"
const HIDDEN_PLACE_SLUGS = ["place-ready-hidden", "place-draft-hidden", "place-archived-hidden"] as const
const PRIVATE_TOKENS = [
  "email",
  "memo",
  "imported_payload",
  "synced_at",
  "service_role",
  "SUPABASE_SERVICE_ROLE_KEY",
  "Bearer ",
  "private@example.com",
  "010-9999-0000",
] as const

describe("places public route", () => {
  it("generates static params for published place pages only", async () => {
    // Given: public SEO fixtures include one published place and hidden place rows.
    // When: places route static params are generated.
    const params = await generateStaticParams()

    // Then: only the published place slug is renderable.
    expect(params).toContainEqual({ slug: PUBLISHED_PLACE_SLUG })
    for (const slug of HIDDEN_PLACE_SLUGS) {
      expect(params).not.toContainEqual({ slug })
    }
  })

  it("generates metadata from a published public-safe place DTO", async () => {
    // Given: a published place slug.
    // When: route metadata is generated.
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: PUBLISHED_PLACE_SLUG }) })

    // Then: public title, description, canonical URL are exposed.
    // 이 테스트 환경의 장소는 fixture 출처라 noindex다 — 실제 DB 게시 페이지(dataOrigin "database")만 색인을 허용한다.
    expect(metadata.title).toBe("부산 해운대 꽃집 근조화환")
    expect(metadata.description).toBe("부산 해운대 꽃집 근조화환 주문과 배송 안내입니다.")
    expect(metadata.alternates?.canonical).toBe("http://localhost:3000/places/place-busan-haeundae-flower")
    expect(metadata.robots).toEqual({ index: false, follow: false })
  })

  it("returns noindex metadata for missing or unpublished place slugs", async () => {
    for (const slug of ["missing-place", ...HIDDEN_PLACE_SLUGS]) {
      // Given: a missing or non-published place slug.
      // When: route metadata is generated.
      const metadata = await generateMetadata({ params: Promise.resolve({ slug }) })

      // Then: crawlers receive noindex/not-found metadata.
      expect(metadata.title).toBe("장소 SEO 페이지를 찾을 수 없습니다")
      expect(metadata.robots).toEqual({ index: false, follow: false })
    }
  })

  it("renders public place content and LocalBusiness JSON-LD without private leaks", async () => {
    // Given: a published place slug.
    const element = await PlacesPage({ params: Promise.resolve({ slug: PUBLISHED_PLACE_SLUG }) })

    // When: the server component is rendered to static markup.
    const rendered = renderToStaticMarkup(element)
    const page = findPublicPageByTypeAndSlug(PUBLIC_SEO_FIXTURES, "place", PUBLISHED_PLACE_SLUG)
    const jsonLd = page === undefined ? [] : buildJsonLdObjects(page)
    const scan = scanPublicPayloadForPrivateData(rendered, jsonLd)

    // Then: visible content and structured data use public-safe place fields only.
    expect(rendered).toContain("부산 해운대 꽃집 근조화환")
    expect(rendered).toContain("부산 해운대 꽃집 근조화환 주문과 배송 안내입니다.")
    expect(rendered).toContain("부산")
    expect(rendered).toContain("해운대구")
    expect(rendered).toContain("부산 해운대구 센텀동로 99")
    expect(rendered).toContain("꽃집")
    expect(rendered).toContain("근조화환 전문")
    expect(rendered).toContain("해운대구 배송 안내")
    expect(rendered).toContain(DEFAULT_ORDER_URL)
    expect(rendered).toContain("application/ld+json")
    expect(rendered).toContain("LocalBusiness")
    expect(jsonLd.map((item) => item["@type"])).toEqual(["BreadcrumbList", "FAQPage", "LocalBusiness"])
    expect(scan).toEqual({ ok: true, leaks: [] })
    for (const token of PRIVATE_TOKENS) {
      expect(rendered).not.toContain(token)
      expect(JSON.stringify(jsonLd)).not.toContain(token)
    }
  })

  it("does not resolve ready, draft, or archived place fixtures through the public DTO lookup", () => {
    for (const slug of HIDDEN_PLACE_SLUGS) {
      // Given: hidden place rows exist in fixture data.
      // When: looking up by public route type and slug.
      const page = findPublicPageByTypeAndSlug(PUBLIC_SEO_FIXTURES, "place", slug)

      // Then: non-published place rows are excluded before rendering.
      expect(page).toBeUndefined()
    }
  })
})
