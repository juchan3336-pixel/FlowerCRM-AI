import type { MetadataRoute } from "next"

import { PUBLIC_SEO_RECORDS } from "@/lib/public-seo/fixtures"
import { buildSitemapEntries } from "@/lib/public-seo/public-pages"

function getSiteUrl(): string {
  return process.env["SEO_PLATFORM_SITE_URL"] ?? "http://localhost:3000"
}

export default function sitemap(): MetadataRoute.Sitemap {
  return [...buildSitemapEntries(PUBLIC_SEO_RECORDS, getSiteUrl())]
}
