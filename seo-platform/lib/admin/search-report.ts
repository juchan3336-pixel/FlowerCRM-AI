import "server-only"

// 검색 성과 리포트 조회 — search_performance_daily(GSC 동기화 결과)를 admin 화면용으로 가공한다.
// 지표 계산(순위 변화·검색 결과 페이지 번호)은 report-model 순수 계층을 쓴다.
import { PAGE_TOTAL_QUERY, positionDelta, searchResultPageNumber } from "@/lib/search-report/report-model"
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"

export type SearchReportPageRow = {
  readonly pagePath: string
  readonly impressions: number
  readonly clicks: number
  readonly position: number
  // 구글 검색 결과 몇 페이지에 노출 중인지 (평균 순위 기준, 0 = 지표 없음)
  readonly resultPage: number
  // 전일 대비·7일 전 대비 순위 변화 — 양수 = 상승. 비교 데이터가 없으면 null.
  readonly deltaFromPreviousDay: number | null
  readonly deltaFromWeekAgo: number | null
}

export type SearchReportSummary = {
  // 가장 최근 동기화된 날짜 (GSC 지연으로 오늘보다 1~3일 전) — 데이터가 아예 없으면 null.
  readonly latestDate: string | null
  readonly totalImpressions: number
  readonly totalClicks: number
  readonly pages: readonly SearchReportPageRow[]
}

type DailyRow = { readonly date: string; readonly page_path: string; readonly impressions: number; readonly clicks: number; readonly position: number }

export async function loadSearchReportSummary(limit = 100): Promise<SearchReportSummary> {
  const client = createSupabaseServiceRoleClient()
  const { data: latestRows, error: latestError } = await client
    .from("search_performance_daily")
    .select("date")
    .eq("query", PAGE_TOTAL_QUERY)
    .order("date", { ascending: false })
    .limit(1)
  if (latestError !== null) {
    throw new SearchReportQueryError("latest-date", latestError.message)
  }
  const latestDate = latestRows[0]?.date ?? null
  if (latestDate === null) {
    return { latestDate: null, totalImpressions: 0, totalClicks: 0, pages: [] }
  }

  const previousDay = shiftDate(latestDate, -1)
  const weekAgo = shiftDate(latestDate, -7)
  const { data, error } = await client
    .from("search_performance_daily")
    .select("date,page_path,impressions,clicks,position")
    .eq("query", PAGE_TOTAL_QUERY)
    .in("date", [latestDate, previousDay, weekAgo])
  if (error !== null) {
    throw new SearchReportQueryError("page-totals", error.message)
  }

  const byDate = new Map<string, Map<string, DailyRow>>()
  for (const row of data as DailyRow[]) {
    const forDate = byDate.get(row.date) ?? new Map<string, DailyRow>()
    forDate.set(row.page_path, row)
    byDate.set(row.date, forDate)
  }
  const current = [...(byDate.get(latestDate)?.values() ?? [])].sort((a, b) => b.impressions - a.impressions).slice(0, limit)

  const pages = current.map((row): SearchReportPageRow => {
    const prev = byDate.get(previousDay)?.get(row.page_path)
    const week = byDate.get(weekAgo)?.get(row.page_path)
    return {
      pagePath: row.page_path,
      impressions: row.impressions,
      clicks: row.clicks,
      position: row.position,
      resultPage: searchResultPageNumber(row.position),
      deltaFromPreviousDay: positionDelta(row.position, prev?.position ?? null),
      deltaFromWeekAgo: positionDelta(row.position, week?.position ?? null),
    }
  })

  return {
    latestDate,
    totalImpressions: current.reduce((sum, row) => sum + row.impressions, 0),
    totalClicks: current.reduce((sum, row) => sum + row.clicks, 0),
    pages,
  }
}

export type SearchReportPageDetail = {
  readonly pagePath: string
  // 최근 28일 일별 시계열 (오래된 날짜부터)
  readonly daily: readonly { readonly date: string; readonly impressions: number; readonly clicks: number; readonly position: number; readonly resultPage: number }[]
  // 최신 날짜의 상위 검색어
  readonly topQueries: readonly { readonly query: string; readonly impressions: number; readonly clicks: number; readonly position: number }[]
}

export async function loadSearchReportPageDetail(pagePath: string, latestDate: string): Promise<SearchReportPageDetail> {
  const client = createSupabaseServiceRoleClient()
  const since = shiftDate(latestDate, -27)
  const [dailyResult, queryResult] = await Promise.all([
    client
      .from("search_performance_daily")
      .select("date,impressions,clicks,position")
      .eq("query", PAGE_TOTAL_QUERY)
      .eq("page_path", pagePath)
      .gte("date", since)
      .order("date", { ascending: true }),
    client
      .from("search_performance_daily")
      .select("query,impressions,clicks,position")
      .eq("page_path", pagePath)
      .eq("date", latestDate)
      .neq("query", PAGE_TOTAL_QUERY)
      .order("impressions", { ascending: false })
      .limit(20),
  ])
  if (dailyResult.error !== null) {
    throw new SearchReportQueryError("page-daily", dailyResult.error.message)
  }
  if (queryResult.error !== null) {
    throw new SearchReportQueryError("page-queries", queryResult.error.message)
  }
  return {
    pagePath,
    daily: (dailyResult.data as readonly { date: string; impressions: number; clicks: number; position: number }[]).map((row) => ({
      ...row,
      resultPage: searchResultPageNumber(row.position),
    })),
    topQueries: queryResult.data,
  }
}

// date 문자열(YYYY-MM-DD) 산술 — UTC 자정 기준이라 타임존 영향이 없다.
function shiftDate(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`)
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export class SearchReportQueryError extends Error {
  readonly name = "SearchReportQueryError"

  constructor(step: string, detail: string) {
    super(`search report query failed (${step}): ${detail}`)
  }
}
