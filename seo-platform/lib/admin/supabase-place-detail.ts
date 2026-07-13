import "server-only"

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { AdminPlaceDetailRepository, AdminPlaceGenerationHistoryRow, AdminPlaceSeoPageRow } from "./place-detail"
import type { PlaceRow } from "@/types/database"

export function createSupabaseAdminPlaceDetailRepository(): AdminPlaceDetailRepository {
  const client = createSupabaseServiceRoleClient()

  return {
    async findPlaceById(placeId: string): Promise<PlaceRow | null> {
      const { data, error } = await client.from("places").select("*").eq("id", placeId).maybeSingle()
      if (error !== null) {
        throw new SupabaseAdminPlaceDetailReadError(error.message, error.code)
      }
      return data
    },
    async findPlaceSeoPage(placeId: string): Promise<AdminPlaceSeoPageRow | null> {
      const { data, error } = await client
        .from("seo_pages")
        .select("id, status, path, title, description, created_at, last_modified_at")
        .eq("page_type", "place")
        .eq("place_id", placeId)
        .maybeSingle()
      if (error !== null) {
        throw new SupabaseAdminPlaceDetailReadError(error.message, error.code)
      }
      return data
    },
    async listAiGenerations(placeId: string, limit: number): Promise<readonly AdminPlaceGenerationHistoryRow[]> {
      const { data, error } = await client
        .from("ai_generations")
        .select("id, status, model, created_at, applied_at, output")
        .eq("place_id", placeId)
        .order("created_at", { ascending: false })
        .limit(limit)
      if (error !== null) {
        throw new SupabaseAdminPlaceDetailReadError(error.message, error.code)
      }
      return data
    },
  }
}

export class SupabaseAdminPlaceDetailReadError extends Error {
  readonly name = "SupabaseAdminPlaceDetailReadError"

  constructor(readonly detail: string, readonly code: string | undefined) {
    super(`Failed to read admin place detail: ${detail}`)
  }
}
