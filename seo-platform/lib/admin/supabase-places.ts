import "server-only"

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { AdminPlacesRepository } from "./places"
import type { PlaceRow, SeoPageRow } from "@/types/database"

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
  }
}

export class SupabaseAdminPlacesReadError extends Error {
  readonly name = "SupabaseAdminPlacesReadError"

  constructor(readonly detail: string, readonly code: string | undefined) {
    super(`Failed to read admin places: ${detail}`)
  }
}
