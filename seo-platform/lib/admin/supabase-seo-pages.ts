import "server-only"

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { AdminSeoPageActionRepository } from "./seo-page-actions"
import type { AdminSeoPageSource, AdminSeoPagesRepository } from "./seo-pages"
import type { SeoPageForPlaceGeneration, SelectablePlaceForSeoGeneration } from "@/lib/seo-pages/place-generation"
import type { PublicPlacePageRow } from "@/types/database"

export function createSupabaseAdminSeoPagesRepository(): AdminSeoPagesRepository & AdminSeoPageActionRepository {
  const client = createSupabaseServiceRoleClient()

  return {
    async listPublishedPlacePages(): Promise<readonly PublicPlacePageRow[]> {
      const { data, error } = await client.from("published_place_pages").select("*").order("path", { ascending: true })

      if (error !== null) {
        throw new SupabaseAdminSeoPagesReadError(error.message)
      }

      return data
    },
    async listAdminSeoPages(): Promise<readonly AdminSeoPageSource[]> {
      const { data, error } = await client
        .from("seo_pages")
        .select("id, place_id, page_type, slug, path, title, description, canonical_url, status, priority, change_frequency, last_modified_at")
        .eq("page_type", "place")
        .order("path", { ascending: true })

      if (error !== null) {
        throw new SupabaseAdminSeoPagesReadError(error.message)
      }

      return data
    },
    async listCandidatePlaces(): Promise<readonly SelectablePlaceForSeoGeneration[]> {
      const { data, error } = await client
        .from("places")
        .select("id, name, address, category, slug, city, district, description, meta_title, meta_description")
        .order("name", { ascending: true })
        .limit(500)

      if (error !== null) {
        throw new SupabaseAdminSeoPagesReadError(error.message)
      }

      return data
    },
    async listPlaceSeoPageContexts(): Promise<readonly SeoPageForPlaceGeneration[]> {
      const { data, error } = await client
        .from("seo_pages")
        .select("id, place_id, page_type, slug, path, title, description, canonical_url, status, priority, change_frequency, last_modified_at")
        .eq("page_type", "place")

      if (error !== null) {
        throw new SupabaseAdminSeoPagesReadError(error.message)
      }

      return data
    },
    async listSelectedPlaces(placeIds: readonly string[]): Promise<readonly SelectablePlaceForSeoGeneration[]> {
      const { data, error } = await client
        .from("places")
        .select("id, name, address, category, slug, city, district, description, meta_title, meta_description")
        .in("id", [...placeIds])

      if (error !== null) {
        throw new SupabaseAdminSeoPagesReadError(error.message)
      }

      return data
    },
    async insertReadyPlaceSeoPages(pages: readonly SeoPageForPlaceGeneration[]): Promise<number> {
      const { data, error } = await client.from("seo_pages").insert(pages).select("id")

      if (error !== null) {
        throw new SupabaseAdminSeoPagesWriteError(error.message)
      }

      return data.length
    },
    async publishSelectedReadySeoPages(seoPageIds: readonly string[]): Promise<number> {
      const { data, error } = await client.from("seo_pages").update({ status: "published" }).in("id", [...seoPageIds]).eq("status", "ready").select("id")

      if (error !== null) {
        throw new SupabaseAdminSeoPagesWriteError(error.message)
      }

      return data.length
    },
  }
}

export class SupabaseAdminSeoPagesReadError extends Error {
  readonly name = "SupabaseAdminSeoPagesReadError"

  constructor(readonly detail: string) {
    super(`Failed to read admin SEO pages: ${detail}`)
  }
}

export class SupabaseAdminSeoPagesWriteError extends Error {
  readonly name = "SupabaseAdminSeoPagesWriteError"

  constructor(readonly detail: string) {
    super(`Failed to write admin SEO pages: ${detail}`)
  }
}
