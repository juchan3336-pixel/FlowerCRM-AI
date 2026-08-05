import { describe, expect, it } from "vitest"

import { LOCAL_SITE_URL, PRODUCTION_SITE_URL, PUBLIC_SEO_SITE_URL, getPublicSiteUrl, getSiteUrl } from "@/lib/site-url"

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

describe("public SEO site URL sourcing", () => {
  it("uses the fixed punycode public domain on Vercel production and preview", () => {
    // Given: Vercel deployment environments without an explicit override.
    // When/Then: 공개 origin은 퓨니코드 공개 도메인 하나로 고정된다 (Preview도 Production canonical 정책 유지).
    expect(getPublicSiteUrl({ VERCEL_ENV: "production" })).toBe(PUBLIC_SEO_SITE_URL)
    expect(getPublicSiteUrl({ VERCEL_ENV: "preview" })).toBe(PUBLIC_SEO_SITE_URL)
    expect(PUBLIC_SEO_SITE_URL).toBe("https://place.xn--hq1bo4e93ri3lbmc.com")
  })

  it("keeps local development on localhost without forcing the production domain", () => {
    // Given: no Vercel environment (local dev / test).
    expect(getPublicSiteUrl({})).toBe(LOCAL_SITE_URL)
    expect(getPublicSiteUrl({ VERCEL_ENV: "development" })).toBe(LOCAL_SITE_URL)
  })

  it("honors NEXT_PUBLIC_SITE_URL override and normalizes it to a single origin", () => {
    // Given: an explicit override with a path suffix.
    expect(getPublicSiteUrl({ NEXT_PUBLIC_SITE_URL: "https://staging.example.test/base", VERCEL_ENV: "production" })).toBe("https://staging.example.test")
  })

  it("normalizes a Korean-script override to punycode so both notations resolve identically", () => {
    // Given: 한글 표기 도메인 override.
    // Then: URL 파서가 퓨니코드 origin으로 정규화한다 — 한글/퓨니코드 혼용이 생기지 않는다.
    expect(getPublicSiteUrl({ NEXT_PUBLIC_SITE_URL: "https://place.팔도플라워.com" })).toBe(PUBLIC_SEO_SITE_URL)
  })

  it("keeps the admin app origin resolver unchanged by the public domain migration", () => {
    // Given: 관리자·인증 origin은 기존 규칙 그대로여야 한다 (auth redirect 회귀 방지).
    expect(getSiteUrl({})).toBe(PRODUCTION_SITE_URL)
  })
})
