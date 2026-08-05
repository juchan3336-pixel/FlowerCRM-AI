import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import AreaPage, { dynamicParams, generateMetadata, generateStaticParams } from "@/app/area/[slug]/page"
import { DEFAULT_ORDER_URL } from "@/lib/public-seo/fixtures"
import { scanPublicPayloadForPrivateData } from "@/lib/public-seo/public-pages"

const AREA_SLUG = "area-seoul-seocho"
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

describe("area public route", () => {
  it("generates static params for area pages only and disables dynamic params", () => {
    // Given: public SEO fixtures include multiple page families and one private-path area.
    // When: area route static params are generated.
    const params = generateStaticParams()

    // Then: only the published public area slug is emitted and unknown area params are rejected.
    expect(params).toEqual([{ slug: AREA_SLUG }])
    expect(dynamicParams).toBe(false)
  })

  it("generates metadata from the safe area DTO", async () => {
    // Given: a published public area slug.
    // When: route metadata is generated.
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: AREA_SLUG }) })

    // Then: public title, description, and canonical URL are exposed.
    expect(metadata.title).toBe("서울 서초구 근조화환 배송 안내")
    expect(metadata.description).toBe("서울 서초구 장례식장과 병원 근조화환 주문 안내입니다.")
    expect(metadata.alternates?.canonical).toBe("http://localhost:3000/area/area-seoul-seocho")
    // 합성 fixture 페이지는 직접 접근돼도 색인되지 않는다.
    expect(metadata.robots).toEqual({ index: false, follow: false })
  })

  it("renders public area content, JSON-LD, related links, and default order CTA without private leaks", async () => {
    // Given: a published public area slug.
    const element = await AreaPage({ params: Promise.resolve({ slug: AREA_SLUG }) })

    // When: the server component is rendered to static markup.
    const rendered = renderToStaticMarkup(element)
    const scan = scanPublicPayloadForPrivateData(rendered, { slug: AREA_SLUG })

    // Then: visible content and structured data are public-safe.
    expect(rendered).toContain("<h1")
    expect(rendered).toContain("서울 서초구 근조화환 배송 안내")
    expect(rendered).toContain("서울 서초구 장례식장과 병원 근조화환 주문 안내입니다.")
    expect(rendered).toContain("지역 근조화환 배송 안내")
    expect(rendered).toContain("페이지 요약")
    expect(rendered).toContain("서초구 근조화환 주문은 어디로 하나요?")
    expect(rendered).toContain("서초 장례식장")
    expect(rendered).toContain(DEFAULT_ORDER_URL)
    expect(rendered).toContain("application/ld+json")
    expect(rendered).toContain("BreadcrumbList")
    expect(rendered).toContain("FAQPage")
    expect(rendered).toContain("WebPage")
    expect(scan).toEqual({ ok: true, leaks: [] })
    for (const token of PRIVATE_TOKENS) {
      expect(rendered).not.toContain(token)
    }
  })
})
