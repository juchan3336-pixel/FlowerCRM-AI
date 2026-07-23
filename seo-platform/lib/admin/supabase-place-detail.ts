import "server-only"

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import { toBatchRetryConsumptionRow } from "@/lib/ai/supabase-repository"
import type { BatchRetryConsumptionRow } from "@/lib/ai/retry-policy"
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
      // verification_* 컬럼은 migration 202607220001 이후에만 존재 — select("*")로 읽어 적용 전에도 드로어가 깨지지 않게 한다.
      const { data, error } = await client
        .from("seo_pages")
        .select("*")
        .eq("page_type", "place")
        .eq("place_id", placeId)
        .maybeSingle()
      if (error !== null) {
        throw new SupabaseAdminPlaceDetailReadError(error.message, error.code)
      }
      return data
    },
    async listBatchRetryConsumption(placeId: string): Promise<readonly BatchRetryConsumptionRow[]> {
      const { data, error } = await client
        .from("batch_run_items")
        .select("generation_id, retry_generation_id, last_error_code, last_error_message")
        .eq("place_id", placeId)
      if (error !== null) {
        throw new SupabaseAdminPlaceDetailReadError(error.message, error.code)
      }
      return data.map(toBatchRetryConsumptionRow)
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
