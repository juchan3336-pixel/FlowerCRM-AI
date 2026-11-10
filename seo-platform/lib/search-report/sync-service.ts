import "server-only"

// GSC 검색 성과 일별 동기화 — cron이 하루 1회 부른다. 날짜별로 두 번 조회한다:
// ① dimensions=["page"] 단독 → 페이지 합계(query='') — 익명화 검색어 노출까지 포함된 정확한 총합
// ② dimensions=["page","query"] → 검색어 상세 행
// 두 데이터는 의미가 달라 합산하지 않으며, (date, page_path, query) 유니크 제약에 각각 upsert돼
// 재실행·잠정치 갱신에 멱등이다.
import { queryGscSearchAnalytics, readGscCredentialsFromEnv, type GscCredentials } from "./gsc-client"
import { buildPageTotalUpsertRows, buildQueryDetailUpsertRows, syncTargetDates, type SearchPerformanceUpsertRow } from "./report-model"
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"

export type SearchReportSyncOutcome =
  | { readonly kind: "synced"; readonly dates: readonly string[]; readonly rowsUpserted: number }
  | { readonly kind: "conflict"; readonly reason: "missing-gsc-env" }
  | { readonly kind: "failed"; readonly reason: string }

const UPSERT_CHUNK = 500

export async function runSearchReportSync(deps: Readonly<{ credentials?: GscCredentials; now?: Date }> = {}): Promise<SearchReportSyncOutcome> {
  const credentials = deps.credentials ?? readGscCredentialsFromEnv()
  if (credentials === null) {
    return { kind: "conflict", reason: "missing-gsc-env" }
  }
  const client = createSupabaseServiceRoleClient()
  const dates = syncTargetDates(deps.now ?? new Date())

  let rowsUpserted = 0
  const upsertAll = async (upsertRows: readonly SearchPerformanceUpsertRow[]): Promise<string | null> => {
    for (let start = 0; start < upsertRows.length; start += UPSERT_CHUNK) {
      const chunk = upsertRows.slice(start, start + UPSERT_CHUNK).map((row) => ({ ...row, fetched_at: new Date().toISOString() }))
      const { error } = await client.from("search_performance_daily").upsert(chunk, { onConflict: "date,page_path,query" })
      if (error !== null) {
        return `upsert:${error.code}`
      }
      rowsUpserted += chunk.length
    }
    return null
  }

  try {
    for (const date of dates) {
      // ① 페이지 합계 (page 단독) — 합계가 먼저 최신화돼야 리포트 목록이 정확하다.
      const pageRows = await queryGscSearchAnalytics(credentials, { startDate: date, endDate: date, dimensions: ["page"], dataState: "all" })
      const totalError = await upsertAll(buildPageTotalUpsertRows(date, pageRows))
      if (totalError !== null) {
        return { kind: "failed", reason: totalError }
      }
      // ② 검색어 상세 (page+query)
      const queryRows = await queryGscSearchAnalytics(credentials, { startDate: date, endDate: date, dimensions: ["page", "query"], dataState: "all" })
      const detailError = await upsertAll(buildQueryDetailUpsertRows(date, queryRows))
      if (detailError !== null) {
        return { kind: "failed", reason: detailError }
      }
    }
    return { kind: "synced", dates, rowsUpserted }
  } catch (error) {
    // GscApiError message는 본문 300자 제한 — 시크릿·키는 포함되지 않는다.
    return { kind: "failed", reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" }
  }
}

export function httpStatusForSearchReportOutcome(outcome: SearchReportSyncOutcome): number {
  return outcome.kind === "synced" ? 200 : outcome.kind === "conflict" ? 409 : 500
}
