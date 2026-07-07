import { PUBLIC_SEO_FIXTURES } from "@/lib/public-seo/fixtures"
import { buildSitemapEntries, listPublishedPublicPages } from "@/lib/public-seo/public-pages"
import type { ChangeFrequency, SeoPageType } from "@/lib/domain/constants"
import type { PublicPageDto } from "@/lib/public-seo/types"
import { classifyPlaceQuality, type PlaceQualityKind } from "@/lib/seo-pages/place-quality"
import type { SeoPageForPlaceGeneration, SelectablePlaceForSeoGeneration } from "@/lib/seo-pages/place-generation"
import type { PublicPlacePageRow, SeoPageRow } from "@/types/database"

const SITE_URL = "http://localhost:3000" as const

export type AdminSeoPagesSource = "fixture" | "supabase"

export type AdminSeoPageRow = {
  readonly id: string
  readonly type: SeoPageType
  readonly path: string
  readonly canonicalUrl: string
  readonly status: "draft" | "ready" | "published" | "archived"
  readonly sitemapState: "Included in sitemap"
  readonly priority: number
  readonly changeFrequency: ChangeFrequency
  readonly canonicalState: "Canonical healthy"
}

export type AdminSeoPageCandidateRow = {
  readonly id: string
  readonly name: string
  readonly category: string
  readonly location: string
  readonly path: string | null
  readonly quality: PlaceQualityKind
  readonly blockers: readonly string[]
  readonly warnings: readonly string[]
}

export type AdminSeoPageCandidateCounts = {
  readonly eligible: number
  readonly warning: number
  readonly blocked: number
}

export type AdminSeoPageCandidates = {
  readonly counts: AdminSeoPageCandidateCounts
  readonly rows: readonly AdminSeoPageCandidateRow[]
}

export type AdminSeoPageSource = SeoPageForPlaceGeneration & Pick<SeoPageRow, "id">

export type AdminSeoPagesLoadResult = {
  readonly source: AdminSeoPagesSource
  readonly rows: readonly AdminSeoPageRow[]
  readonly candidates: AdminSeoPageCandidates
}

export interface AdminSeoPagesRepository {
  listPublishedPlacePages(): Promise<readonly PublicPlacePageRow[]>
  listAdminSeoPages(): Promise<readonly AdminSeoPageSource[]>
  listCandidatePlaces(): Promise<readonly SelectablePlaceForSeoGeneration[]>
  listPlaceSeoPageContexts(): Promise<readonly SeoPageForPlaceGeneration[]>
}

export async function loadAdminSeoPages(repository?: AdminSeoPagesRepository): Promise<AdminSeoPagesLoadResult> {
  if (repository === undefined) {
    const sitemapUrls = new Set(buildSitemapEntries(PUBLIC_SEO_FIXTURES, SITE_URL).map((entry) => entry.url))
    const rows = listPublishedPublicPages(PUBLIC_SEO_FIXTURES).map((page) => publicPageToAdminSeoPageRow(page, sitemapUrls))
    return { source: "fixture", rows: [...rows, ...FIXTURE_ADMIN_SEO_PAGES], candidates: buildAdminSeoPageCandidates(FIXTURE_CANDIDATE_PLACES, FIXTURE_CANDIDATE_SEO_PAGES) }
  }

  const [rows, candidates, contexts] = await Promise.all([repository.listAdminSeoPages(), repository.listCandidatePlaces(), repository.listPlaceSeoPageContexts()])
  return { source: "supabase", rows: rows.map(seoPageToAdminSeoPageRow), candidates: buildAdminSeoPageCandidates(candidates, contexts) }
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

function seoPageToAdminSeoPageRow(row: AdminSeoPageSource): AdminSeoPageRow {
  return {
    id: row.id,
    type: row.page_type,
    path: row.path,
    canonicalUrl: row.canonical_url ?? row.path,
    status: row.status,
    sitemapState: row.status === "published" ? "Included in sitemap" : "Included in sitemap",
    priority: row.priority,
    changeFrequency: row.change_frequency,
    canonicalState: "Canonical healthy",
  }
}

function buildAdminSeoPageCandidates(
  places: readonly SelectablePlaceForSeoGeneration[],
  seoPages: readonly SeoPageForPlaceGeneration[],
): AdminSeoPageCandidates {
  const existingPaths = new Set(seoPages.map((page) => page.path))
  const duplicateContentKeys = new Set<string>()
  const counts: Record<PlaceQualityKind, number> = { eligible: 0, warning: 0, blocked: 0 }
  const rows = places.map((place) => {
    const result = classifyPlaceQuality({ place, existingSeoPages: seoPages, existingPaths, duplicateContentKeys })
    counts[result.kind] += 1
    return {
      id: place.id,
      name: place.name,
      category: place.category,
      location: [place.city, place.district].filter(hasText).join(" ") || "Location pending",
      path: result.path,
      quality: result.kind,
      blockers: result.blockers,
      warnings: result.warnings,
    }
  })

  return { counts, rows }
}

function hasText(value: string | null): value is string {
  return value !== null && value.trim().length > 0
}

const FIXTURE_CANDIDATE_PLACES = [
  candidatePlace({ id: "candidate_eligible", name: "부산 시민 장례식장", slug: "busan-civic-funeral", city: "부산", district: "동래구" }),
  candidatePlace({ id: "candidate_warning", name: "창원 추모 병원", slug: "changwon-tribute-hospital", city: null, district: null }),
  candidatePlace({ id: "candidate_blocked", name: "기존 발행 후보", slug: "existing-place-candidate", city: "울산", district: "남구" }),
] as const satisfies readonly SelectablePlaceForSeoGeneration[]

const FIXTURE_CANDIDATE_SEO_PAGES = [
  seoPageFixture({ id: "seo_existing_candidate", placeId: "candidate_blocked", slug: "existing-place-candidate", status: "published" }),
] as const satisfies readonly AdminSeoPageSource[]

const FIXTURE_ADMIN_SEO_PAGES = [
  seoPageToAdminSeoPageRow(seoPageFixture({ id: "seo_ready_fixture", placeId: "candidate_eligible", slug: "busan-civic-funeral", status: "ready" })),
  seoPageToAdminSeoPageRow(seoPageFixture({ id: "seo_draft_fixture", placeId: "candidate_warning", slug: "changwon-tribute-hospital", status: "draft" })),
  seoPageToAdminSeoPageRow(seoPageFixture({ id: "seo_archived_fixture", placeId: "candidate_blocked", slug: "existing-place-candidate", status: "archived" })),
] as const satisfies readonly AdminSeoPageRow[]

function candidatePlace(input: Readonly<{ id: string; name: string; slug: string; city: string | null; district: string | null }>): SelectablePlaceForSeoGeneration {
  return {
    id: input.id,
    name: input.name,
    address: "부산 동래구 충렬대로 1",
    category: "funeral",
    slug: input.slug,
    city: input.city,
    district: input.district,
    description: null,
    meta_title: null,
    meta_description: null,
  }
}

function seoPageFixture(input: Readonly<{ id: string; placeId: string; slug: string; status: "draft" | "ready" | "published" | "archived" }>): AdminSeoPageSource {
  return {
    id: input.id,
    place_id: input.placeId,
    page_type: "place",
    slug: input.slug,
    path: `/places/${input.slug}`,
    title: `${input.slug} SEO`,
    description: "Fixture SEO description",
    canonical_url: `/places/${input.slug}`,
    status: input.status,
    priority: 0.7,
    change_frequency: "weekly",
    last_modified_at: "2026-07-07T00:00:00.000Z",
  }
}
