import "server-only"

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { AdminSitemapRepository } from "./sitemap"
import type { PublicPlacePageRow } from "@/types/database"

export function createSupabaseAdminSitemapRepository(): AdminSitemapRepository {
  const client = createSupabaseServiceRoleClient()

  return {
    async listPublishedPlacePages(): Promise<readonly PublicPlacePageRow[]> {
      const { data, error } = await client.from("published_place_pages").select("*").order("path", { ascending: true })

      if (error !== null) {
        throw new SupabaseAdminSitemapReadError(error.message)
      }

      return data
    },
  }
}

export class SupabaseAdminSitemapReadError extends Error {
  readonly name = "SupabaseAdminSitemapReadError"

  constructor(readonly detail: string) {
    super(`Failed to read admin sitemap status: ${detail}`)
  }
}
