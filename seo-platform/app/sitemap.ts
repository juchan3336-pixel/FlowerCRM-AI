import type { MetadataRoute } from "next"

import { listPublishedPlacePages, type PublicPlacePagesRepository } from "@/lib/public-seo/place-pages"
import { buildSitemapEntriesFromPages, filterSitemapIncludablePages } from "@/lib/public-seo/public-pages"
import { buildHubIndexSitemapEntry, buildHubSitemapEntries } from "@/lib/public-seo/region-hub"
import { getPublicSiteUrl } from "@/lib/site-url"

// 빌드 시 정적 산출물로 고정되면 게시/보관 직후의 revalidatePath가 반영되지 않으므로,
// 사이트맵은 항상 현재 DB의 published 상태를 조회한다.
export const revalidate = 0

// sitemap은 실제 게시 데이터(published_place_pages)만 담는다.
// 합성 seed/fixture 페이지는 라우트로는 남아 있지만(파일 삭제 없음, noindex),
// 검색 제출 표면에는 dataOrigin === "database"인 페이지만 나간다 (filterSitemapIncludablePages).
// 활성 P1 허브는 같은 published 데이터에서 파생돼 함께 실린다 — 구성원 0인 허브는 제외.
export async function loadSitemapEntries(repository?: PublicPlacePagesRepository): Promise<MetadataRoute.Sitemap> {
  const siteUrl = getPublicSiteUrl()
  const placePages = await listPublishedPlacePages(repository)
  const includablePages = filterSitemapIncludablePages(placePages)
  const hubIndexEntry = buildHubIndexSitemapEntry(includablePages, siteUrl)
  return [
    ...buildSitemapEntriesFromPages(includablePages, siteUrl),
    ...buildHubSitemapEntries(includablePages, siteUrl),
    ...(hubIndexEntry === null ? [] : [hubIndexEntry]),
  ]
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return loadSitemapEntries()
}
