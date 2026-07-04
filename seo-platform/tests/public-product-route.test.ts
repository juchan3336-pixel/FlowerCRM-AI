import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import ProductPage, { generateMetadata, generateStaticParams } from "@/app/products/[slug]/page"
import { DEFAULT_ORDER_URL } from "@/lib/public-seo/fixtures"
import { scanPublicPayloadForPrivateData } from "@/lib/public-seo/public-pages"

const PRODUCT_SLUG = "product-funeral-flower"
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

describe("product public route", () => {
  it("generates static params for product pages only", () => {
    // Given: public SEO fixtures include multiple page families.
    // When: product route static params are generated.
    const params = generateStaticParams()

    // Then: only the published product slug is emitted.
    expect(params).toEqual([{ slug: PRODUCT_SLUG }])
  })

  it("generates metadata from the safe product DTO", async () => {
    // Given: a published product slug.
    // When: route metadata is generated.
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: PRODUCT_SLUG }) })

    // Then: public title, description, and canonical URL are exposed.
    expect(metadata.title).toBe("근조화환 상품 안내")
    expect(metadata.description).toBe("장례식장과 병원으로 보내는 근조화환 상품 안내입니다.")
    expect(metadata.alternates?.canonical).toBe("https://seo.example.com/products/product-funeral-flower")
  })

  it("renders public product content, JSON-LD, related links, and default order CTA without private leaks", async () => {
    // Given: a published product slug.
    const element = await ProductPage({ params: Promise.resolve({ slug: PRODUCT_SLUG }) })

    // When: the server component is rendered to static markup.
    const rendered = renderToStaticMarkup(element)
    const scan = scanPublicPayloadForPrivateData(rendered, { slug: PRODUCT_SLUG })

    // Then: visible content and structured data are public-safe.
    expect(rendered).toContain("<h1")
    expect(rendered).toContain("근조화환 상품 안내")
    expect(rendered).toContain("장례식장과 병원으로 보내는 근조화환 상품 안내입니다.")
    expect(rendered).toContain("breadcrumb")
    expect(rendered).toContain("상품 가격은 어디서 확인하나요?")
    expect(rendered).toContain("지역별 배송 안내")
    expect(rendered).toContain("근조화환 상품 주문 전 확인")
    expect(rendered).toContain(`href="${DEFAULT_ORDER_URL}"`)
    expect(rendered).not.toContain("https://팔도플라워.com/products/funeral-flower")
    expect(rendered).toContain("application/ld+json")
    expect(rendered).toContain("BreadcrumbList")
    expect(rendered).toContain("FAQPage")
    expect(rendered).toContain("Product")
    expect(scan).toEqual({ ok: true, leaks: [] })
    for (const token of PRIVATE_TOKENS) {
      expect(rendered).not.toContain(token)
    }
  })
})
