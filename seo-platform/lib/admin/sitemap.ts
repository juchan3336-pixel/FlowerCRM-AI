import { PUBLIC_SEO_FIXTURES } from "@/lib/public-seo/fixtures"
import { buildCanonicalUrl, buildRobotsConfig, buildSitemapEntries, listPublishedPublicPages } from "@/lib/public-seo/public-pages"
import { getSiteUrl } from "@/lib/site-url"
import type { ChangeFrequency } from "@/lib/domain/constants"
import type { PublicPlacePageRow } from "@/types/database"
import { formatKstDateTime } from "./time"

export type SitemapStatusCard = {
  readonly label: string
  readonly value: string
  readonly description: string
  readonly tone: "accent" | "neutral" | "warning"
}

export type AdminSitemapEntry = {
  readonly url: string
  readonly changeFrequency: ChangeFrequency
  readonly priority: number
  readonly lastModified: string
}

export type AdminSitemapStatus = {
  readonly source: "fixture" | "supabase"
  readonly sitemapUrl: string
  readonly robotsUrl: string
  readonly cards: readonly SitemapStatusCard[]
  readonly entries: readonly AdminSitemapEntry[]
  readonly disallowedPaths: readonly ["/admin", "/api", "/login", "/private"]
}

export interface AdminSitemapRepository {
  listPublishedPlacePages(): Promise<readonly PublicPlacePageRow[]>
}

export async function loadAdminSitemap(repository?: AdminSitemapRepository): Promise<AdminSitemapStatus> {
  const siteUrl = getSiteUrl()
  const robotsConfig = buildRobotsConfig(siteUrl)
  const robotsUrl = buildCanonicalUrl(siteUrl, "/robots.txt")

  if (repository === undefined) {
    const publishedPages = listPublishedPublicPages(PUBLIC_SEO_FIXTURES)
    const entries = buildSitemapEntries(PUBLIC_SEO_FIXTURES, siteUrl)
    return buildStatus({ source: "fixture", sitemapUrl: robotsConfig.sitemap, robotsUrl, entries, excludedCount: PUBLIC_SEO_FIXTURES.length - publishedPages.length })
  }

  const rows = await repository.listPublishedPlacePages()
  const entries = rows.map(publicViewRowToSitemapEntry)
  return buildStatus({ source: "supabase", sitemapUrl: robotsConfig.sitemap, robotsUrl, entries, excludedCount: 0 })
}

function buildStatus(input: Readonly<{ source: "fixture" | "supabase"; sitemapUrl: string; robotsUrl: string; entries: readonly AdminSitemapEntry[]; excludedCount: number }>): AdminSitemapStatus {
  return {
    source: input.source,
    sitemapUrl: input.sitemapUrl,
    robotsUrl: input.robotsUrl,
    cards: [
      { label: "사이트맵 URL", value: input.sitemapUrl, description: "공개 사이트맵 모듈이 canonical 공개 URL에서 생성한 값입니다.", tone: "accent" },
      { label: "robots URL", value: input.robotsUrl, description: "robots 정책은 외부 제출 호출 없이 공개 SEO 모듈과 동일하게 맞춥니다.", tone: "neutral" },
      { label: "게시된 URL", value: String(input.entries.length), description: "생성된 사이트맵 미리보기에는 게시된 공개 레코드만 포함됩니다.", tone: "accent" },
      { label: "비공개/초안 제외", value: String(input.excludedCount), description: "이 상태 페이지를 렌더링하기 전에 초안 레코드와 비공개 관리자 경로를 제외합니다.", tone: "warning" },
    ],
    entries: input.entries,
    disallowedPaths: ["/admin", "/api", "/login", "/private"],
  }
}

function publicViewRowToSitemapEntry(row: PublicPlacePageRow): AdminSitemapEntry {
  return {
    url: buildCanonicalUrl(getSiteUrl(), row.path),
    changeFrequency: row.change_frequency,
    priority: row.priority,
    lastModified: row.last_modified_at === null ? "—" : formatKstDateTime(row.last_modified_at),
  }
}
