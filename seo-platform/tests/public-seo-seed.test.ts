import { describe, expect, it } from "vitest"

import sitemap from "@/app/sitemap"
import { GENERATED_FUNERAL_PUBLIC_PAGES } from "@/lib/public-seo/funeral-seed"
import { scanPublicPayloadForPrivateData } from "@/lib/public-seo/public-pages"

const PRIVATE_FIELD_NAMES = ["phone", "email", "memo", "imported_payload", "synced_at", "service_role", "privateSource"] as const

describe("deterministic funeral public page seed", () => {
  it("creates exactly 100 published funeral records with unique slugs, paths, and canonical URLs", () => {
    // Given: deterministic funeral fixture inputs.
    const records = GENERATED_FUNERAL_PUBLIC_PAGES

    // When: uniqueness keys are collected from generated public records.
    const slugs = new Set(records.map((record) => record.slug))
    const paths = new Set(records.map((record) => record.path))
    const canonicalUrls = new Set(records.map((record) => record.canonicalUrl))

    // Then: every record is a published funeral public page with stable unique routing.
    expect(records).toHaveLength(100)
    expect(slugs.size).toBe(100)
    expect(paths.size).toBe(100)
    expect(canonicalUrls.size).toBe(100)
    expect(records.every((record) => record.type === "funeral" && record.status === "published")).toBe(true)
  })

  it("uses only public source fields and passes the privacy scanner", () => {
    // Given: generated funeral records intended for public SEO rendering.
    const serialized = JSON.stringify(GENERATED_FUNERAL_PUBLIC_PAGES)

    // When: records are scanned for private source metadata.
    const scan = scanPublicPayloadForPrivateData(serialized, GENERATED_FUNERAL_PUBLIC_PAGES)

    // Then: private source field names and known private tokens are absent.
    expect(scan).toEqual({ ok: true, leaks: [] })
    for (const fieldName of PRIVATE_FIELD_NAMES) {
      expect(serialized).not.toContain(fieldName)
    }
  })

  it("adds 100 funeral canonical URLs to the real sitemap output", () => {
    // Given: the local SEO platform site URL used by App Router sitemap.
    const previousSiteUrl = process.env["SEO_PLATFORM_SITE_URL"]
    process.env["SEO_PLATFORM_SITE_URL"] = "http://localhost:3000"

    try {
      // When: the real sitemap route is invoked.
      const generatedUrls = new Set(GENERATED_FUNERAL_PUBLIC_PAGES.map((record) => record.canonicalUrl))
      const funeralUrls = sitemap()
        .map((entry) => entry.url)
        .filter((url) => generatedUrls.has(url))

      // Then: every generated funeral canonical URL is present exactly once.
      expect(funeralUrls).toHaveLength(100)
      expect(new Set(funeralUrls).size).toBe(100)
    } finally {
      if (previousSiteUrl === undefined) {
        delete process.env["SEO_PLATFORM_SITE_URL"]
      } else {
        process.env["SEO_PLATFORM_SITE_URL"] = previousSiteUrl
      }
    }
  })
})
