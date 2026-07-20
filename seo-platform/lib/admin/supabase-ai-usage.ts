// 읽기 전용: Dashboard AI 사용량용 ai_generations 조회 (수정 없음)
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { AiUsageGenerationRow } from "./ai-usage"

const AI_USAGE_ROW_LIMIT = 1000

export async function fetchAiUsageGenerations(): Promise<Readonly<{ rows: readonly AiUsageGenerationRow[]; placeNames: ReadonlyMap<string, string> }>> {
  const client = createSupabaseServiceRoleClient()
  const { data, error } = await client
    .from("ai_generations")
    .select("id, place_id, status, model, created_at, output")
    .order("created_at", { ascending: false })
    .limit(AI_USAGE_ROW_LIMIT)
  if (error !== null) {
    throw new Error(`Failed to read ai usage: ${error.message}`)
  }

  const rows = data as readonly AiUsageGenerationRow[]
  const placeIds = [...new Set(rows.map((row) => row.place_id))]
  const placeNames = new Map<string, string>()
  if (placeIds.length > 0) {
    const { data: places, error: placesError } = await client.from("places").select("id, name").in("id", placeIds)
    if (placesError === null) {
      for (const place of places) {
        placeNames.set(place.id, place.name)
      }
    }
  }

  return { rows, placeNames }
}
