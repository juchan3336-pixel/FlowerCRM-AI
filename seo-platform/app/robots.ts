import type { MetadataRoute } from "next"

import { buildRobotsConfig } from "@/lib/public-seo/public-pages"

function getSiteUrl(): string {
  return process.env["SEO_PLATFORM_SITE_URL"] ?? "http://localhost:3000"
}

export default function robots(): MetadataRoute.Robots {
  const config = buildRobotsConfig(getSiteUrl())
  return {
    rules: {
      userAgent: config.rules.userAgent,
      allow: config.rules.allow,
      disallow: [...config.rules.disallow],
    },
    sitemap: config.sitemap,
  }
}
