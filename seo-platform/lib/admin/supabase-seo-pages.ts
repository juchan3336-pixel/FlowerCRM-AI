import "server-only"

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { AdminSeoPagesRepository } from "./seo-pages"
import type { PublicPlacePageRow } from "@/types/database"

export function createSupabaseAdminSeoPagesRepository(): AdminSeoPagesRepository {
  const client = createSupabaseServiceRoleClient()

  return {
    async listPublishedPlacePages(): Promise<readonly PublicPlacePageRow[]> {
      const { data, error } = await client.from("published_place_pages").select("*").order("path", { ascending: true })

      if (error !== null) {
        throw new SupabaseAdminSeoPagesReadError(error.message)
      }

      return data
    },
  }
}

export class SupabaseAdminSeoPagesReadError extends Error {
  readonly name = "SupabaseAdminSeoPagesReadError"

  constructor(readonly detail: string) {
    super(`Failed to read admin SEO pages: ${detail}`)
  }
}
