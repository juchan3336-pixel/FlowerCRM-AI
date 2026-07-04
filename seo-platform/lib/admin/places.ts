import { PUBLIC_SEO_FIXTURES } from "@/lib/public-seo/fixtures"
import { listPublishedPublicPages } from "@/lib/public-seo/public-pages"
import type { PublicPageDto } from "@/lib/public-seo/types"
import type { PublicPlacePageRow } from "@/types/database"

export type AdminPlacesSource = "fixture" | "supabase"

export type AdminPlaceRow = {
  readonly id: string
  readonly status: "Published"
  readonly nameOrTitle: string
  readonly categoryOrType: string
  readonly region: string
  readonly path: string
  readonly aiState: "Preview pending"
}

export type AdminPlacesLoadResult = {
  readonly source: AdminPlacesSource
  readonly rows: readonly AdminPlaceRow[]
}

export interface AdminPlacesRepository {
  listPublishedPlacePages(): Promise<readonly PublicPlacePageRow[]>
}

export async function loadAdminPlaces(repository?: AdminPlacesRepository): Promise<AdminPlacesLoadResult> {
  if (repository === undefined) {
    return { source: "fixture", rows: listPublishedPublicPages(PUBLIC_SEO_FIXTURES).map(publicPageToAdminPlaceRow) }
  }

  const rows = await repository.listPublishedPlacePages()
  return { source: "supabase", rows: rows.map(publicViewRowToAdminPlaceRow) }
}

function publicPageToAdminPlaceRow(page: PublicPageDto): AdminPlaceRow {
  return {
    id: page.id,
    status: "Published",
    nameOrTitle: page.place?.name ?? page.title,
    categoryOrType: page.place?.detailCategory ?? page.place?.category ?? page.type,
    region: formatRegion(page.region, page.city, page.district),
    path: page.path,
    aiState: "Preview pending",
  }
}

function publicViewRowToAdminPlaceRow(row: PublicPlacePageRow): AdminPlaceRow {
  return {
    id: row.seo_page_id,
    status: "Published",
    nameOrTitle: row.name ?? row.title ?? row.path,
    categoryOrType: row.detail_category ?? row.category ?? row.page_type,
    region: formatRegion(row.region, row.city, row.district),
    path: row.path,
    aiState: "Preview pending",
  }
}

function formatRegion(region: string | null, city: string | null, district: string | null): string {
  const cityDistrict = [city, district].filter((value) => value !== null).join(" · ")
  return region ?? (cityDistrict.length > 0 ? cityDistrict : "Nationwide")
}
