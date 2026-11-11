// 읽기 전용: Dashboard AI 사용량용 ai_generations 조회 (수정 없음)
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import { projectedRowToUsageRow, selectRecentAiUsageRows, type AiUsageGenerationRow, type AiUsageProjectedRow } from "./ai-usage"

const AI_USAGE_ROW_LIMIT = 1000

// output 전체(생성 본문 포함)를 받지 않고 집계에 쓰는 키만 JSON 경로로 꺼낸다.
const AI_USAGE_SELECT =
  "id, place_id, status, model, created_at, usage_provider:output->provider, usage_model:output->model, usage:output->usage, estimated_cost:output->estimated_cost, quality_status:output->quality->status"

export async function fetchAiUsageGenerations(): Promise<Readonly<{ rows: readonly AiUsageGenerationRow[]; placeNames: ReadonlyMap<string, string> }>> {
  const client = createSupabaseServiceRoleClient()
  const { data, error } = await client.from("ai_generations").select(AI_USAGE_SELECT).order("created_at", { ascending: false }).limit(AI_USAGE_ROW_LIMIT)
  if (error !== null) {
    throw new Error(`Failed to read ai usage: ${error.message}`)
  }

  const rows = (data as unknown as readonly AiUsageProjectedRow[]).map(projectedRowToUsageRow)
  // 장소명은 "최근 생성" 표에 실제로 표시되는 행에만 필요하다.
  const placeIds = [...new Set(selectRecentAiUsageRows(rows).map((row) => row.place_id))]
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
