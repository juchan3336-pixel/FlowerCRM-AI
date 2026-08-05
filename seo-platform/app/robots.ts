import type { MetadataRoute } from "next"

import { buildRobotsConfig } from "@/lib/public-seo/public-pages"
import { getPublicSiteUrl } from "@/lib/site-url"

export default function robots(): MetadataRoute.Robots {
  const config = buildRobotsConfig(getPublicSiteUrl())
  return {
    rules: {
      userAgent: config.rules.userAgent,
      allow: config.rules.allow,
      disallow: [...config.rules.disallow],
    },
    sitemap: config.sitemap,
  }
}
