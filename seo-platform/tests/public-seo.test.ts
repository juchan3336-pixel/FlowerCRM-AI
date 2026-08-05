import { describe, expect, it } from "vitest"
import robots from "@/app/robots"
import sitemap, { loadSitemapEntries } from "@/app/sitemap"
import { PUBLIC_SEO_FIXTURES, PUBLIC_SEO_RECORDS, DEFAULT_ORDER_URL } from "@/lib/public-seo/fixtures"
import type { PublicPlacePagesRepository } from "@/lib/public-seo/place-pages"
import {
  buildCanonicalUrl,
  buildJsonLdObjects,
  buildRobotsConfig,
  buildSitemapEntries,
  findPublicPageByTypeAndSlug,
  listPublishedPublicPages,
  scanPublicPayloadForPrivateData,
} from "@/lib/public-seo/public-pages"
import type { PublicPlacePageRow } from "@/types/database"

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

const DB_PUBLISHED_PLACE_ROW: PublicPlacePageRow = {
  seo_page_id: "db_place_published",
  page_type: "place",
  page_slug: "place-db-published",
  path: "/places/place-db-published",
  title: "DB published place",
  page_description: "Published DB-backed public place page.",
  canonical_url: "https://seo.example.com/places/place-db-published",
  priority: 0.7,
  change_frequency: "weekly",
  last_modified_at: "2026-07-07T00:00:00.000Z",
  place_id: "place_db_published",
  name: "DB Public Flower",
  category: "꽃집",
  detail_category: null,
  region: "부산",
  city: "부산",
  district: "해운대구",
  address: "부산 해운대구 공개로 1",
  homepage: "https://public.example.com",
  place_slug: "db-public-flower",
  order_url: null,
  place_description: "Public place description",
  meta_title: null,
  meta_description: null,
  faq: [],
  keywords: [],
  internal_links: [],
}

const DB_PRIVATE_PATH_PLACE_ROW: PublicPlacePageRow = {
  ...DB_PUBLISHED_PLACE_ROW,
  seo_page_id: "db_private_path",
  page_slug: "place-private-path",
  path: "/private/place-private-path",
  canonical_url: "https://seo.example.com/private/place-private-path",
}

class FakePublicPlacePagesRepository implements PublicPlacePagesRepository {
  constructor(private readonly rows: readonly PublicPlacePageRow[]) {}

  findPublishedPlaceBySlug(slug: string): Promise<PublicPlacePageRow | null> {
    return Promise.resolve(this.rows.find((row) => row.page_slug === slug) ?? null)
  }

  listPublishedPlaces(): Promise<readonly PublicPlacePageRow[]> {
    return Promise.resolve(this.rows)
  }
}

describe("public SEO data foundation", () => {
  it("lists only published public page DTOs without private or phone fields", () => {
    // Given: mixed fixture pages for every public SEO route family.
    const pages = listPublishedPublicPages(PUBLIC_SEO_FIXTURES)

    // When: public DTOs are serialized for rendering or metadata generation.
    const serialized = JSON.stringify(pages)

    // Then: only published pages remain and private tokens never appear.
    expect(pages.map((page) => page.type).sort()).toEqual(["area", "funeral", "hospital", "place", "product"])
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

  it("exposes real sitemap and robots route outputs from the shared public SEO modules", async () => {
    // Given: 공개 origin override — 라우트가 공개 site URL resolver를 그대로 쓰는지 본다.
    const previousSiteUrl = process.env["NEXT_PUBLIC_SITE_URL"]
    process.env["NEXT_PUBLIC_SITE_URL"] = "http://localhost:3000"

    try {
      // When: the real App Router route functions are invoked.
      const sitemapEntries = await sitemap()
      const robotsConfig = robots()

      // Then: the sitemap and robots outputs are exactly the shared module results.
      expect(sitemapEntries).toEqual(buildSitemapEntries(PUBLIC_SEO_RECORDS, "http://localhost:3000"))
      expect(robotsConfig).toEqual(buildRobotsConfig("http://localhost:3000"))
    } finally {
      if (previousSiteUrl === undefined) {
        delete process.env["NEXT_PUBLIC_SITE_URL"]
      } else {
        process.env["NEXT_PUBLIC_SITE_URL"] = previousSiteUrl
      }
    }
  })

  it("loads sitemap entries from published_place_pages repository rows without private or hidden place paths", async () => {
    // Given: a fake public-safe published_place_pages view with one public row and one private-path row.
    const previousSiteUrl = process.env["NEXT_PUBLIC_SITE_URL"]
    process.env["NEXT_PUBLIC_SITE_URL"] = "https://seo.example.com"
    const repository = new FakePublicPlacePagesRepository([DB_PUBLISHED_PLACE_ROW, DB_PRIVATE_PATH_PLACE_ROW])

    try {
      // When: sitemap entries are loaded through the real sitemap integration seam.
      const entries = await loadSitemapEntries(repository)
      const urls = entries.map((entry) => entry.url).sort()
      const serialized = JSON.stringify(entries)

      // Then: only the published public DB-backed place page is included.
      expect(urls).toContain("https://seo.example.com/places/place-db-published")
      expect(urls).not.toContain("https://seo.example.com/private/place-private-path")
      expect(urls.join("\n")).not.toContain("place-ready-hidden")
      expect(urls.join("\n")).not.toContain("place-draft-hidden")
      expect(urls.join("\n")).not.toContain("place-archived-hidden")
      expect(serialized).not.toContain("private@example.com")
      expect(serialized).not.toContain("010-9999-0000")
    } finally {
      if (previousSiteUrl === undefined) {
        delete process.env["NEXT_PUBLIC_SITE_URL"]
      } else {
        process.env["NEXT_PUBLIC_SITE_URL"] = previousSiteUrl
      }
    }
  })

  it("emits only the punycode public domain in production sitemap locs with no legacy or duplicate URLs", async () => {
    // Given: Vercel production 환경 (override 없음) + DB place 1건.
    const previousSiteUrl = process.env["NEXT_PUBLIC_SITE_URL"]
    const previousVercelEnv = process.env["VERCEL_ENV"]
    delete process.env["NEXT_PUBLIC_SITE_URL"]
    process.env["VERCEL_ENV"] = "production"
    const repository = new FakePublicPlacePagesRepository([DB_PUBLISHED_PLACE_ROW])

    try {
      // When: 실제 sitemap 통합 seam으로 항목을 만든다.
      const entries = await loadSitemapEntries(repository)
      const urls = entries.map((entry) => entry.url)

      // Then: 모든 loc가 새 공개 도메인 단일 표기이고, 구 Vercel 도메인·한글 표기·중복이 없다.
      expect(urls.length).toBeGreaterThan(0)
      for (const url of urls) {
        expect(url.startsWith("https://place.xn--hq1bo4e93ri3lbmc.com/")).toBe(true)
      }
      expect(urls.join("\n")).not.toContain("flowercrm-seo.vercel.app")
      expect(urls.join("\n")).not.toContain("팔도플라워.com/")
      expect(urls).toContain("https://place.xn--hq1bo4e93ri3lbmc.com/places/place-db-published")
      expect(new Set(urls).size).toBe(urls.length)
    } finally {
      if (previousSiteUrl === undefined) {
        delete process.env["NEXT_PUBLIC_SITE_URL"]
      } else {
        process.env["NEXT_PUBLIC_SITE_URL"] = previousSiteUrl
      }
      if (previousVercelEnv === undefined) {
        delete process.env["VERCEL_ENV"]
      } else {
        process.env["VERCEL_ENV"] = previousVercelEnv
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
