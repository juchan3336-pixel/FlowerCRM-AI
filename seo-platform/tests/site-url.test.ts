import { describe, expect, it } from "vitest"

import { PRODUCTION_SITE_URL, getSiteUrl } from "@/lib/site-url"

describe("site URL sourcing", () => {
  it("defaults every public URL surface to the production origin", () => {
    // Given: no deployment URL environment values are configured.
    const env = {}

    // When: the shared site URL helper resolves the origin.
    const siteUrl = getSiteUrl(env)

    // Then: production is the only fallback origin.
    expect(siteUrl).toBe(PRODUCTION_SITE_URL)
    expect(siteUrl).toBe("https://flowercrm-seo.vercel.app")
    expect(siteUrl).not.toContain("localhost")
    expect(siteUrl).not.toContain("example")
    expect(siteUrl).not.toContain("AI.MIDM")
  })

  it("preserves explicit NEXT_PUBLIC_APP_URL overrides before SEO_PLATFORM_SITE_URL", () => {
    // Given: both public and SEO-specific deployment origins are configured.
    const env = {
      NEXT_PUBLIC_APP_URL: "https://app.example.test/path",
      SEO_PLATFORM_SITE_URL: "https://seo.example.test",
    }

    // When: the shared site URL helper resolves the origin.
    const siteUrl = getSiteUrl(env)

    // Then: the public app URL wins and is normalized to its origin.
    expect(siteUrl).toBe("https://app.example.test")
  })

  it("preserves explicit SEO_PLATFORM_SITE_URL when NEXT_PUBLIC_APP_URL is absent", () => {
    // Given: only the SEO platform origin is configured.
    const env = { SEO_PLATFORM_SITE_URL: "https://seo.example.test/base" }

    // When: the shared site URL helper resolves the origin.
    const siteUrl = getSiteUrl(env)

    // Then: the SEO URL is used and normalized to its origin.
    expect(siteUrl).toBe("https://seo.example.test")
  })
})
