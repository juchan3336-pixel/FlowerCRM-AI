import type { PlaceRow, SeoPageRow } from "@/types/database"
import { formatKstDateTime } from "./time"

export type AdminPlacesSource = "live" | "error"

export type AdminPlacesDiagnostics = {
  readonly dataSource: "live" | "error"
  readonly placesQueryCount: number | null
  readonly seoPagesPlaceCount: number | null
  readonly supabaseUrlHostOrRef: string | null
  readonly queryErrorCode: string | null
  readonly queryErrorMessage: string | null
  readonly lastQueriedAt: string
}

export type AdminPlaceRow = {
  readonly id: string
  readonly name: string
  readonly category: string
  readonly region: string
  readonly status: PlaceRow["status"]
  readonly aiState: "미리보기 대기" | "적용됨"
  readonly seoState: SeoPageRow["status"] | "누락"
  readonly address: string | null
  readonly phone: string | null
  readonly homepage: string | null
  readonly slug: string | null
}

export type AdminPlacesLoadResult = {
  readonly source: AdminPlacesSource
  readonly rows: readonly AdminPlaceRow[]
  readonly diagnostics: AdminPlacesDiagnostics
}

export type AdminPlacesTaskFilterKey = "ai-missing" | "publish-pending" | "published"

export type AdminPlacesPageQuery = {
  readonly search: string | null
  readonly task: AdminPlacesTaskFilterKey | null
  readonly offset: number
  readonly limit: number
}

export type AdminPlacesPage = {
  readonly rows: readonly PlaceRow[]
  readonly seoStatuses: readonly Pick<SeoPageRow, "place_id" | "status">[]
  readonly total: number
}

export interface AdminPlacesRepository {
  countPlaces(): Promise<number>
  listPlaces(): Promise<readonly PlaceRow[]>
  countPlaceSeoPages(): Promise<number>
  listPlaceSeoPages(): Promise<readonly Pick<SeoPageRow, "place_id" | "status">[]>
  countPlacesMissingAiContent?(): Promise<number>
  countReadyPlaceSeoPages?(): Promise<number>
  countPublishedPlaceSeoPages?(): Promise<number>
  listPlacesPage?(query: AdminPlacesPageQuery): Promise<AdminPlacesPage>
}

export type AdminPlacesRepositories = {
  readonly places?: AdminPlacesRepository
}

export type AdminPlacesLoadOptions = {
  readonly supabaseUrlHostOrRef?: string | null
}

export async function loadAdminPlaces(
  repositories: AdminPlacesRepositories = {},
  options: AdminPlacesLoadOptions = {},
): Promise<AdminPlacesLoadResult> {
  const repository = repositories.places
  const lastQueriedAt = formatKstDateTime(new Date().toISOString())
  const supabaseUrlHostOrRef = options.supabaseUrlHostOrRef ?? null

  if (repository === undefined) {
    return {
      source: "error",
      rows: [],
      diagnostics: {
        dataSource: "error",
        placesQueryCount: null,
        seoPagesPlaceCount: null,
        supabaseUrlHostOrRef,
        queryErrorCode: null,
        queryErrorMessage: "environment missing",
        lastQueriedAt,
      },
    }
  }

  const [placesCountResult, seoPagesCountResult, placesResult, seoPagesResult] = await Promise.allSettled([
    repository.countPlaces(),
    repository.countPlaceSeoPages(),
    repository.listPlaces(),
    repository.listPlaceSeoPages(),
  ])

  const queryError = [placesCountResult, seoPagesCountResult, placesResult, seoPagesResult].find((result) => result.status === "rejected")
  const rows =
    placesResult.status === "fulfilled" && seoPagesResult.status === "fulfilled"
      ? buildAdminPlaceRows(placesResult.value, seoPagesResult.value)
      : []

  if (queryError !== undefined) {
    return {
      source: "error",
      rows,
      diagnostics: {
        dataSource: "error",
        placesQueryCount: placesCountResult.status === "fulfilled" ? placesCountResult.value : null,
        seoPagesPlaceCount: seoPagesCountResult.status === "fulfilled" ? seoPagesCountResult.value : null,
        supabaseUrlHostOrRef,
        queryErrorCode: extractErrorCode(queryError.reason),
        queryErrorMessage: extractErrorMessage(queryError.reason),
        lastQueriedAt,
      },
    }
  }

  return {
    source: "live",
    rows,
    diagnostics: {
      dataSource: "live",
      placesQueryCount: placesCountResult.status === "fulfilled" ? placesCountResult.value : null,
      seoPagesPlaceCount: seoPagesCountResult.status === "fulfilled" ? seoPagesCountResult.value : null,
      supabaseUrlHostOrRef,
      queryErrorCode: null,
      queryErrorMessage: null,
      lastQueriedAt,
    },
  }
}

export function buildAdminPlacesErrorResult(error: unknown, options: AdminPlacesLoadOptions = {}): AdminPlacesLoadResult {
  const lastQueriedAt = formatKstDateTime(new Date().toISOString())
  return {
    source: "error",
    rows: [],
    diagnostics: {
      dataSource: "error",
      placesQueryCount: null,
      seoPagesPlaceCount: null,
      supabaseUrlHostOrRef: options.supabaseUrlHostOrRef ?? null,
      queryErrorCode: extractErrorCode(error),
      queryErrorMessage: extractErrorMessage(error),
      lastQueriedAt,
    },
  }
}

function buildAdminPlaceRows(places: readonly PlaceRow[], seoPages: readonly Pick<SeoPageRow, "place_id" | "status">[]): readonly AdminPlaceRow[] {
  const seoStatusByPlaceId = new Map<string, SeoPageRow["status"]>()
  for (const seoPage of seoPages) {
    if (seoPage.place_id !== null) {
      seoStatusByPlaceId.set(seoPage.place_id, seoPage.status)
    }
  }

  return places.map((place) => placeRowToAdminPlaceRow(place, seoStatusByPlaceId.get(place.id) ?? "누락"))
}

function placeRowToAdminPlaceRow(row: PlaceRow, seoState: AdminPlaceRow["seoState"]): AdminPlaceRow {
  return {
    id: row.id,
    name: row.name,
    category: row.detail_category ?? row.category,
    region: formatRegion(row.region, row.city, row.district),
    status: row.status,
    aiState: hasAppliedAiContent(row) ? "적용됨" : "미리보기 대기",
    seoState,
    address: row.address,
    phone: row.phone,
    homepage: row.homepage,
    slug: row.slug,
  }
}

function hasAppliedAiContent(place: PlaceRow): boolean {
  return [place.description, place.meta_title, place.meta_description].some((value) => value !== null && value.trim().length > 0)
}

function formatRegion(region: string | null, city: string | null, district: string | null): string {
  const cityDistrict = [city, district].filter((value) => value !== null).join(" · ")
  return region ?? (cityDistrict.length > 0 ? cityDistrict : "Nationwide")
}

function extractErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null
  }

  const record = error as Record<string, unknown>
  const code = record["code"]
  return typeof code === "string" && code.trim().length > 0 ? code : null
}

function extractErrorMessage(error: unknown): string | null {
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>
    const message = record["message"]
    if (typeof message === "string" && message.trim().length > 0) {
      return message
    }
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error
  }

  return null
}

export type AdminPlacesWorkspaceResult = {
  readonly source: AdminPlacesSource
  readonly rows: readonly AdminPlaceRow[]
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly diagnostics: AdminPlacesDiagnostics
}

export async function loadAdminPlacesWorkspace(
  repositories: AdminPlacesRepositories = {},
  query: AdminPlacesPageQuery,
  options: AdminPlacesLoadOptions = {},
): Promise<AdminPlacesWorkspaceResult> {
  const repository = repositories.places
  const lastQueriedAt = formatKstDateTime(new Date().toISOString())
  const supabaseUrlHostOrRef = options.supabaseUrlHostOrRef ?? null
  const emptyWorkspace = { rows: [], total: 0, offset: query.offset, limit: query.limit }

  if (repository === undefined) {
    return {
      source: "error",
      ...emptyWorkspace,
      diagnostics: {
        dataSource: "error",
        placesQueryCount: null,
        seoPagesPlaceCount: null,
        supabaseUrlHostOrRef,
        queryErrorCode: null,
        queryErrorMessage: "environment missing",
        lastQueriedAt,
      },
    }
  }

  const [pageResult, seoPagesCountResult] = await Promise.allSettled([
    loadWorkspacePage(repository, query),
    repository.countPlaceSeoPages(),
  ])

  if (pageResult.status === "rejected") {
    return {
      source: "error",
      ...emptyWorkspace,
      diagnostics: {
        dataSource: "error",
        placesQueryCount: null,
        seoPagesPlaceCount: seoPagesCountResult.status === "fulfilled" ? seoPagesCountResult.value : null,
        supabaseUrlHostOrRef,
        queryErrorCode: extractErrorCode(pageResult.reason),
        queryErrorMessage: extractErrorMessage(pageResult.reason),
        lastQueriedAt,
      },
    }
  }

  return {
    source: "live",
    rows: pageResult.value.rows,
    total: pageResult.value.total,
    offset: query.offset,
    limit: query.limit,
    diagnostics: {
      dataSource: "live",
      placesQueryCount: pageResult.value.total,
      seoPagesPlaceCount: seoPagesCountResult.status === "fulfilled" ? seoPagesCountResult.value : null,
      supabaseUrlHostOrRef,
      queryErrorCode: null,
      queryErrorMessage: null,
      lastQueriedAt,
    },
  }
}

export function buildAdminPlacesWorkspaceErrorResult(
  error: unknown,
  query: AdminPlacesPageQuery,
  options: AdminPlacesLoadOptions = {},
): AdminPlacesWorkspaceResult {
  return {
    source: "error",
    rows: [],
    total: 0,
    offset: query.offset,
    limit: query.limit,
    diagnostics: buildAdminPlacesErrorResult(error, options).diagnostics,
  }
}

async function loadWorkspacePage(
  repository: AdminPlacesRepository,
  query: AdminPlacesPageQuery,
): Promise<Readonly<{ rows: readonly AdminPlaceRow[]; total: number }>> {
  if (repository.listPlacesPage !== undefined) {
    const page = await repository.listPlacesPage(query)
    return { rows: buildAdminPlaceRows(page.rows, page.seoStatuses), total: page.total }
  }

  const [places, seoPages] = await Promise.all([repository.listPlaces(), repository.listPlaceSeoPages()])
  const filtered = buildAdminPlaceRows(places, seoPages).filter((row) => matchesWorkspaceQuery(row, query))
  return { rows: filtered.slice(query.offset, query.offset + query.limit), total: filtered.length }
}

function matchesWorkspaceQuery(row: AdminPlaceRow, query: AdminPlacesPageQuery): boolean {
  if (query.task === "ai-missing" && row.aiState !== "미리보기 대기") {
    return false
  }
  if (query.task === "publish-pending" && row.seoState !== "ready") {
    return false
  }
  if (query.task === "published" && row.seoState !== "published") {
    return false
  }

  if (query.search === null || query.search.length === 0) {
    return true
  }

  const term = query.search.toLowerCase()
  return [row.name, row.address ?? "", row.region, row.category, row.slug ?? ""].some((value) => value.toLowerCase().includes(term))
}

export function resolveSupabaseUrlHostOrRef(value: string | undefined): string | null {
  if (value === undefined) {
    return null
  }

  try {
    return new URL(value).hostname
  } catch {
    return value
  }
}
