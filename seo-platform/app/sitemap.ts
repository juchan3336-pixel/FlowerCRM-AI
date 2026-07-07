import type { MetadataRoute } from "next"

import { PUBLIC_SEO_RECORDS } from "@/lib/public-seo/fixtures"
import { listPublishedPlacePages, type PublicPlacePagesRepository } from "@/lib/public-seo/place-pages"
import { buildSitemapEntriesFromPages, listPublishedPublicPages } from "@/lib/public-seo/public-pages"

function getSiteUrl(): string {
  return process.env["SEO_PLATFORM_SITE_URL"] ?? "http://localhost:3000"
}

export async function loadSitemapEntries(repository?: PublicPlacePagesRepository): Promise<MetadataRoute.Sitemap> {
  const siteUrl = getSiteUrl()
  const publicFixturePages = listPublishedPublicPages(PUBLIC_SEO_RECORDS)
  const placePages = await listPublishedPlacePages(repository)
  const placePagesByPath = new Map(placePages.map((page) => [page.path, page]))
  const fixturePlacePaths = new Set(publicFixturePages.filter((page) => page.type === "place").map((page) => page.path))
  const sitemapPages = [
    ...publicFixturePages.flatMap((page) => {
      if (page.type !== "place") {
        return [page]
      }
      return placePagesByPath.get(page.path) ?? []
    }),
    ...placePages.filter((page) => !fixturePlacePaths.has(page.path)),
  ]
  return [...buildSitemapEntriesFromPages(sitemapPages, siteUrl)]
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return loadSitemapEntries()
}
