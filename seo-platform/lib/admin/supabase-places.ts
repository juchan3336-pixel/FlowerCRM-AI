import "server-only"

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { AdminPlacesPage, AdminPlacesPageQuery, AdminPlacesRepository } from "./places"
import type { PlaceRow, SeoPageRow } from "@/types/database"

const SEARCHABLE_PLACE_COLUMNS = ["name", "address", "region", "city", "district", "category", "detail_category", "slug"] as const

export function createSupabaseAdminPlacesRepository(): AdminPlacesRepository {
  const client = createSupabaseServiceRoleClient()

  return {
    async countPlaces(): Promise<number> {
      const { count, error } = await client.from("places").select("id", { count: "exact", head: true })

      if (error !== null) {
        throw new SupabaseAdminPlacesReadError(error.message, error.code)
      }

      return count ?? 0
    },
    async listPlaces(): Promise<readonly PlaceRow[]> {
      const { data, error } = await client.from("places").select("*").order("name", { ascending: true })

      if (error !== null) {
        throw new SupabaseAdminPlacesReadError(error.message, error.code)
      }

      return data
    },
    async countPlaceSeoPages(): Promise<number> {
      const { count, error } = await client.from("seo_pages").select("id", { count: "exact", head: true }).eq("page_type", "place")

      if (error !== null) {
        throw new SupabaseAdminPlacesReadError(error.message, error.code)
      }

      return count ?? 0
    },
    async listPlaceSeoPages(): Promise<readonly Pick<SeoPageRow, "place_id" | "status">[]> {
      const { data, error } = await client.from("seo_pages").select("place_id, status").eq("page_type", "place")

      if (error !== null) {
        throw new SupabaseAdminPlacesReadError(error.message, error.code)
      }

      return data
    },
    async countPlacesMissingAiContent(): Promise<number> {
      const { count, error } = await client
        .from("places")
        .select("id", { count: "exact", head: true })
        .is("description", null)
        .is("meta_title", null)
        .is("meta_description", null)

      if (error !== null) {
        throw new SupabaseAdminPlacesReadError(error.message, error.code)
      }

      return count ?? 0
    },
    async countReadyPlaceSeoPages(): Promise<number> {
      const { count, error } = await client
        .from("seo_pages")
        .select("id", { count: "exact", head: true })
        .eq("page_type", "place")
        .eq("status", "ready")

      if (error !== null) {
        throw new SupabaseAdminPlacesReadError(error.message, error.code)
      }

      return count ?? 0
    },
    async countPublishedPlaceSeoPages(): Promise<number> {
      const { count, error } = await client
        .from("seo_pages")
        .select("id", { count: "exact", head: true })
        .eq("page_type", "place")
        .eq("status", "published")

      if (error !== null) {
        throw new SupabaseAdminPlacesReadError(error.message, error.code)
      }

      return count ?? 0
    },
    async listPlacesPage(query: AdminPlacesPageQuery): Promise<AdminPlacesPage> {
      const searchFilter = buildSearchFilter(query.search)
      const rangeEnd = query.offset + query.limit - 1
      const usesSeoStatusJoin = query.task === "publish-pending" || query.task === "published"

      let rows: readonly PlaceRow[]
      let total: number

      if (usesSeoStatusJoin) {
        let builder = client
          .from("places")
          .select("*, seo_pages!inner(place_id, status)", { count: "exact" })
          .eq("seo_pages.page_type", "place")
          .eq("seo_pages.status", query.task === "published" ? "published" : "ready")
        if (searchFilter !== null) {
          builder = builder.or(searchFilter)
        }
        const { data, count, error } = await builder.order("name", { ascending: true }).range(query.offset, rangeEnd)

        if (error !== null) {
          throw new SupabaseAdminPlacesReadError(error.message, error.code)
        }

        rows = data.map((row) => stripEmbeddedSeoPages(row))
        total = count ?? 0
      } else {
        let builder = client.from("places").select("*", { count: "exact" })
        if (query.task === "ai-missing") {
          builder = builder.is("description", null).is("meta_title", null).is("meta_description", null)
        }
        if (searchFilter !== null) {
          builder = builder.or(searchFilter)
        }
        const { data, count, error } = await builder.order("name", { ascending: true }).range(query.offset, rangeEnd)

        if (error !== null) {
          throw new SupabaseAdminPlacesReadError(error.message, error.code)
        }

        rows = data
        total = count ?? 0
      }

      if (rows.length === 0) {
        return { rows, seoStatuses: [], total }
      }

      const { data: seoStatuses, error: seoError } = await client
        .from("seo_pages")
        .select("place_id, status")
        .eq("page_type", "place")
        .in("place_id", rows.map((row) => row.id))

      if (seoError !== null) {
        throw new SupabaseAdminPlacesReadError(seoError.message, seoError.code)
      }

      return { rows, seoStatuses, total }
    },
  }
}

function buildSearchFilter(search: string | null): string | null {
  if (search === null) {
    return null
  }

  const term = search.replace(/[,()%_'"\\]/g, "").trim()
  if (term.length === 0) {
    return null
  }

  return SEARCHABLE_PLACE_COLUMNS.map((column) => `${column}.ilike.%${term}%`).join(",")
}

function stripEmbeddedSeoPages(row: PlaceRow & Readonly<{ seo_pages?: unknown }>): PlaceRow {
  const place: PlaceRow & { seo_pages?: unknown } = { ...row }
  delete place.seo_pages
  return place
}

export class SupabaseAdminPlacesReadError extends Error {
  readonly name = "SupabaseAdminPlacesReadError"

  constructor(readonly detail: string, readonly code: string | undefined) {
    super(`Failed to read admin places: ${detail}`)
  }
}
