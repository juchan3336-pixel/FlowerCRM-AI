import { describe, expect, it } from "vitest"
import robots from "@/app/robots"
import sitemap from "@/app/sitemap"
import { PUBLIC_SEO_FIXTURES, PUBLIC_SEO_RECORDS, DEFAULT_ORDER_URL } from "@/lib/public-seo/fixtures"
import {
  buildCanonicalUrl,
  buildJsonLdObjects,
  buildRobotsConfig,
  buildSitemapEntries,
  findPublicPageByTypeAndSlug,
  listPublishedPublicPages,
  scanPublicPayloadForPrivateData,
} from "@/lib/public-seo/public-pages"

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

describe("public SEO data foundation", () => {
  it("lists only published public page DTOs without private or phone fields", () => {
    // Given: mixed fixture pages for every public SEO route family.
    const pages = listPublishedPublicPages(PUBLIC_SEO_FIXTURES)

    // When: public DTOs are serialized for rendering or metadata generation.
    const serialized = JSON.stringify(pages)

    // Then: only published pages remain and private tokens never appear.
    expect(pages.map((page) => page.type).sort()).toEqual(["area", "funeral", "hospital", "product"])
    for (const token of PRIVATE_TOKENS) {
      expect(serialized).not.toContain(token)
    }
  })

  it("finds a published page by type and slug", () => {
    // Given: published hospital fixture data.
    // When: looking up by route type and slug.
    const page = findPublicPageByTypeAndSlug(PUBLIC_SEO_FIXTURES, "hospital", "hospital-busan-haeundae")

    // Then: the matching safe DTO is returned.
    expect(page?.title).toBe("부산 해운대 병원 근조화환")
    expect(page?.ctaUrl).toBe(DEFAULT_ORDER_URL)
  })

  it("builds canonical URLs and sitemap entries from published public page paths", () => {
    // Given: fixtures that include draft/noindex/private-path pages.
    const pages = listPublishedPublicPages(PUBLIC_SEO_FIXTURES)

    // When: canonical URLs and sitemap entries are built.
    const canonical = buildCanonicalUrl("https://seo.example.com/", "/funeral/funeral-seoul-seocho")
    const sitemap = buildSitemapEntries(PUBLIC_SEO_FIXTURES, "https://seo.example.com/")

    // Then: sitemap contains published public paths on the requested site URL only.
    expect(canonical).toBe("https://seo.example.com/funeral/funeral-seoul-seocho")
    expect(sitemap.map((entry) => entry.url).sort()).toEqual(
      pages.map((page) => buildCanonicalUrl("https://seo.example.com/", page.path)).sort(),
    )
    expect(sitemap.map((entry) => entry.url).join("\n")).not.toContain("draft")
    expect(sitemap.map((entry) => entry.url).join("\n")).not.toContain("/admin")
    expect(sitemap.map((entry) => entry.url).join("\n")).not.toContain("/api")
    expect(sitemap.map((entry) => entry.url).join("\n")).not.toContain("/login")
    expect(sitemap.map((entry) => entry.url).join("\n")).not.toContain("/private")
  })

  it("builds robots config that blocks private platform surfaces", () => {
    // Given: the production site URL.
    // When: robots data is generated.
    const robots = buildRobotsConfig("https://seo.example.com/")

    // Then: admin/API/login/private routes are disallowed and sitemap is absolute.
    expect(robots.rules).toEqual({
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/api", "/login", "/private"],
    })
    expect(robots.sitemap).toBe("https://seo.example.com/sitemap.xml")
  })

  it("exposes real sitemap and robots route outputs from the shared public SEO modules", () => {
    // Given: the local SEO platform site URL.
    const previousSiteUrl = process.env["SEO_PLATFORM_SITE_URL"]
    process.env["SEO_PLATFORM_SITE_URL"] = "http://localhost:3000"

    try {
      // When: the real App Router route functions are invoked.
      const sitemapEntries = sitemap()
      const robotsConfig = robots()

      // Then: the sitemap and robots outputs are exactly the shared module results.
      expect(sitemapEntries).toEqual(buildSitemapEntries(PUBLIC_SEO_RECORDS, "http://localhost:3000"))
      expect(robotsConfig).toEqual(buildRobotsConfig("http://localhost:3000"))
    } finally {
      if (previousSiteUrl === undefined) {
        delete process.env["SEO_PLATFORM_SITE_URL"]
      } else {
        process.env["SEO_PLATFORM_SITE_URL"] = previousSiteUrl
      }
    }
  })

  it("builds JSON-LD objects without leaking private data or phone", () => {
    // Given: a published funeral public DTO.
    const page = findPublicPageByTypeAndSlug(PUBLIC_SEO_FIXTURES, "funeral", "funeral-seoul-seocho")
    expect(page).toBeDefined()
    if (page === undefined) {
      return
    }

    // When: JSON-LD objects are built from the DTO.
    const jsonLd = buildJsonLdObjects(page)
    const serialized = JSON.stringify(jsonLd)

    // Then: structured data includes public schemas only and excludes private tokens.
    expect(jsonLd.map((item) => item["@type"])).toEqual(["BreadcrumbList", "FAQPage", "LocalBusiness"])
    for (const token of PRIVATE_TOKENS) {
      expect(serialized).not.toContain(token)
    }
  })

  it("privacy-scans rendered/data payloads and keeps default CTA on 팔도플라워.com", () => {
    // Given: safe public DTOs and rendered payloads.
    const pages = listPublishedPublicPages(PUBLIC_SEO_FIXTURES)
    const rendered = JSON.stringify(pages)

    // When: payloads are scanned for private fields and values.
    const scan = scanPublicPayloadForPrivateData(rendered, pages)

    // Then: no leaks are detected and pages without overrides use the default CTA.
    expect(scan).toEqual({ ok: true, leaks: [] })
    expect(pages.every((page) => page.ctaUrl.startsWith("https://팔도플라워.com"))).toBe(true)
  })
})
