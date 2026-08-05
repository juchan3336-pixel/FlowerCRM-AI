import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import HospitalPage, { generateMetadata, generateStaticParams } from "@/app/hospital/[slug]/page"
import { DEFAULT_ORDER_URL } from "@/lib/public-seo/fixtures"
import { scanPublicPayloadForPrivateData } from "@/lib/public-seo/public-pages"

const HOSPITAL_SLUG = "hospital-busan-haeundae"
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

describe("hospital public route", () => {
  it("generates static params for hospital pages only", () => {
    // Given: public SEO fixtures include multiple page families.
    // When: hospital route static params are generated.
    const params = generateStaticParams()

    // Then: only the published hospital slug is emitted.
    expect(params).toEqual([{ slug: HOSPITAL_SLUG }])
  })

  it("generates metadata from the safe hospital DTO", async () => {
    // Given: a published hospital slug.
    // When: route metadata is generated.
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: HOSPITAL_SLUG }) })

    // Then: public title, description, and canonical URL are exposed.
    expect(metadata.title).toBe("부산 해운대 병원 근조화환")
    expect(metadata.description).toBe("부산 해운대 병원 장례 관련 근조화환 주문 안내입니다.")
    expect(metadata.alternates?.canonical).toBe("http://localhost:3000/hospital/hospital-busan-haeundae")
  })

  it("renders public hospital content, JSON-LD, related links, and default order CTA without private leaks", async () => {
    // Given: a published hospital slug.
    const element = await HospitalPage({ params: Promise.resolve({ slug: HOSPITAL_SLUG }) })

    // When: the server component is rendered to static markup.
    const rendered = renderToStaticMarkup(element)
    const scan = scanPublicPayloadForPrivateData(rendered, { slug: HOSPITAL_SLUG })

    // Then: visible content and structured data are public-safe.
    expect(rendered).toContain("<h1")
    expect(rendered).toContain("부산 해운대 병원 근조화환")
    expect(rendered).toContain("부산 해운대 병원 장례 관련 근조화환 주문 안내입니다.")
    expect(rendered).toContain("breadcrumb")
    expect(rendered).toContain("병원 장례식장 화환도 가능한가요?")
    expect(rendered).toContain("지역 배송 안내")
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
})
