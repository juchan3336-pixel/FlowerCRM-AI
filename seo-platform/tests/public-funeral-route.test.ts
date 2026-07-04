import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import FuneralPage, { generateMetadata, generateStaticParams } from "@/app/funeral/[slug]/page"
import { DEFAULT_ORDER_URL } from "@/lib/public-seo/fixtures"
import { GENERATED_FUNERAL_PUBLIC_PAGES } from "@/lib/public-seo/funeral-seed"
import { scanPublicPayloadForPrivateData } from "@/lib/public-seo/public-pages"

const FUNERAL_SLUG = "funeral-seoul-seocho"
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

describe("funeral public route", () => {
  it("generates static params for funeral pages only", () => {
    // Given: public SEO fixtures include multiple page families.
    // When: funeral route static params are generated.
    const params = generateStaticParams()

    // Then: the fixture and generated funeral seed slugs are renderable.
    expect(params).toHaveLength(101)
    expect(params).toContainEqual({ slug: FUNERAL_SLUG })
    expect(params).toContainEqual({ slug: GENERATED_FUNERAL_PUBLIC_PAGES[0]?.slug })
  })

  it("generates metadata from the safe funeral DTO", async () => {
    // Given: a published funeral slug.
    // When: route metadata is generated.
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: FUNERAL_SLUG }) })

    // Then: public title, description, and canonical URL are exposed.
    expect(metadata.title).toBe("서울 서초 장례식장 근조화환")
    expect(metadata.description).toBe("서울 서초 장례식장 근조화환 주문과 배송 안내입니다.")
    expect(metadata.alternates?.canonical).toBe("https://seo.example.com/funeral/funeral-seoul-seocho")
  })

  it("renders public funeral content, JSON-LD, related links, and default order CTA without private leaks", async () => {
    // Given: a published funeral slug.
    const element = await FuneralPage({ params: Promise.resolve({ slug: FUNERAL_SLUG }) })

    // When: the server component is rendered to static markup.
    const rendered = renderToStaticMarkup(element)
    const scan = scanPublicPayloadForPrivateData(rendered, { slug: FUNERAL_SLUG })

    // Then: visible content and structured data are public-safe.
    expect(rendered).toContain("<h1")
    expect(rendered).toContain("서울 서초 장례식장 근조화환")
    expect(rendered).toContain("서울 서초 장례식장 근조화환 주문과 배송 안내입니다.")
    expect(rendered).toContain("breadcrumb")
    expect(rendered).toContain("장례식장으로 바로 배송되나요?")
    expect(rendered).toContain("서초구 배송 안내")
    expect(rendered).toContain(DEFAULT_ORDER_URL)
    expect(rendered).toContain("application/ld+json")
    expect(rendered).toContain("BreadcrumbList")
    expect(rendered).toContain("FAQPage")
    expect(rendered).toContain("LocalBusiness")
    expect(scan).toEqual({ ok: true, leaks: [] })
    for (const token of PRIVATE_TOKENS) {
      expect(rendered).not.toContain(token)
    }
  })

  it("renders a generated funeral seed URL advertised in the sitemap", async () => {
    // Given: a generated funeral seed page from the 100-page backfill foundation.
    const seedPage = GENERATED_FUNERAL_PUBLIC_PAGES[0]
    if (seedPage === undefined) {
      throw new Error("Generated funeral seed fixture is empty")
    }

    // When: the route renders the generated slug.
    const element = await FuneralPage({ params: Promise.resolve({ slug: seedPage.slug }) })
    const rendered = renderToStaticMarkup(element)

    // Then: generated sitemap URLs are backed by real page rendering.
    expect(rendered).toContain(seedPage.title)
    expect(rendered).toContain(seedPage.description)
  })
})
