import type { MetadataRoute } from "next"

import { PUBLIC_SEO_RECORDS } from "@/lib/public-seo/fixtures"
import { listPublishedPlacePages, type PublicPlacePagesRepository } from "@/lib/public-seo/place-pages"
import { buildSitemapEntriesFromPages, listPublishedPublicPages } from "@/lib/public-seo/public-pages"
import { getPublicSiteUrl } from "@/lib/site-url"

// 빌드 시 정적 산출물로 고정되면 게시/보관 직후의 revalidatePath가 반영되지 않으므로,
// 사이트맵은 항상 현재 DB의 published 상태를 조회한다.
export const revalidate = 0

export async function loadSitemapEntries(repository?: PublicPlacePagesRepository): Promise<MetadataRoute.Sitemap> {
  const siteUrl = getPublicSiteUrl()
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
