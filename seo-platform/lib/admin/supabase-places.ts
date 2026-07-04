import "server-only"

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { AdminPlacesRepository } from "./places"
import type { PublicPlacePageRow } from "@/types/database"

export function createSupabaseAdminPlacesRepository(): AdminPlacesRepository {
  const client = createSupabaseServiceRoleClient()

  return {
    async listPublishedPlacePages(): Promise<readonly PublicPlacePageRow[]> {
      const { data, error } = await client.from("published_place_pages").select("*").order("path", { ascending: true })

      if (error !== null) {
        throw new SupabaseAdminPlacesReadError(error.message)
      }

      return data
    },
  }
}

export class SupabaseAdminPlacesReadError extends Error {
  readonly name = "SupabaseAdminPlacesReadError"

  constructor(readonly detail: string) {
    super(`Failed to read admin places: ${detail}`)
  }
}
