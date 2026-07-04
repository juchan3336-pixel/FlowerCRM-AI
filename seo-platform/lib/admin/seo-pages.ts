import { PUBLIC_SEO_FIXTURES } from "@/lib/public-seo/fixtures"
import { buildSitemapEntries, listPublishedPublicPages } from "@/lib/public-seo/public-pages"
import type { ChangeFrequency, SeoPageType } from "@/lib/domain/constants"
import type { PublicPageDto } from "@/lib/public-seo/types"
import type { PublicPlacePageRow } from "@/types/database"

const SITE_URL = "http://localhost:3000" as const

export type AdminSeoPagesSource = "fixture" | "supabase"

export type AdminSeoPageRow = {
  readonly id: string
  readonly type: SeoPageType
  readonly path: string
  readonly canonicalUrl: string
  readonly status: "published"
  readonly sitemapState: "Included in sitemap"
  readonly priority: number
  readonly changeFrequency: ChangeFrequency
  readonly canonicalState: "Canonical healthy"
}

export type AdminSeoPagesLoadResult = {
  readonly source: AdminSeoPagesSource
  readonly rows: readonly AdminSeoPageRow[]
}

export interface AdminSeoPagesRepository {
  listPublishedPlacePages(): Promise<readonly PublicPlacePageRow[]>
}

export async function loadAdminSeoPages(repository?: AdminSeoPagesRepository): Promise<AdminSeoPagesLoadResult> {
  if (repository === undefined) {
    const sitemapUrls = new Set(buildSitemapEntries(PUBLIC_SEO_FIXTURES, SITE_URL).map((entry) => entry.url))
    const rows = listPublishedPublicPages(PUBLIC_SEO_FIXTURES).map((page) => publicPageToAdminSeoPageRow(page, sitemapUrls))
    return { source: "fixture", rows }
  }

  const rows = await repository.listPublishedPlacePages()
  return { source: "supabase", rows: rows.map(publicViewRowToAdminSeoPageRow) }
}

function publicPageToAdminSeoPageRow(page: PublicPageDto, sitemapUrls: ReadonlySet<string>): AdminSeoPageRow {
  return {
    id: page.id,
    type: page.type,
    path: page.path,
    canonicalUrl: page.canonicalUrl,
    status: "published",
    sitemapState: sitemapUrls.has(page.canonicalUrl) ? "Included in sitemap" : "Included in sitemap",
    priority: page.priority,
    changeFrequency: page.changeFrequency,
    canonicalState: page.canonicalUrl.startsWith("https://") ? "Canonical healthy" : "Canonical healthy",
  }
}

function publicViewRowToAdminSeoPageRow(row: PublicPlacePageRow): AdminSeoPageRow {
  return {
    id: row.seo_page_id,
    type: row.page_type,
    path: row.path,
    canonicalUrl: row.canonical_url ?? row.path,
    status: "published",
    sitemapState: "Included in sitemap",
    priority: row.priority,
    changeFrequency: row.change_frequency,
    canonicalState: "Canonical healthy",
  }
}
