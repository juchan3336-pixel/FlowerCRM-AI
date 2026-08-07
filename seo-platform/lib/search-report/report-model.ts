// 검색 성과 리포트 순수 계층 — GSC 행 → 저장 행 매핑과 화면 지표 계산.
// DB·네트워크 접근이 없어 그대로 단위 테스트한다. 부수효과는 sync-service가 담당한다.
import type { GscRow } from "./gsc-client"

// 페이지 합계 행은 query='' 로 저장한다 — (date, page_path, query) 유니크 제약과 함께
// "합계 1행 + 검색어별 N행" 구조를 한 테이블에서 유지한다.
export const PAGE_TOTAL_QUERY = ""

export type SearchPerformanceUpsertRow = {
  readonly date: string
  readonly page_path: string
  readonly query: string
  readonly impressions: number
  readonly clicks: number
  readonly position: number
}

// GSC page 차원은 절대 URL — 우리 저장 키는 경로만 쓴다 (도메인 교체에도 이력 유지).
export function pageUrlToPath(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl)
    return `${url.pathname}${url.search}`
  } catch {
    return null
  }
}

// dimensions=[page, query] 응답을 저장 행으로 변환하고, 페이지 합계(query='') 행을 함께 만든다.
// 합계 position은 노출수 가중 평균 — GSC 자체 집계와 같은 방식이다.
export function buildUpsertRows(date: string, rows: readonly GscRow[]): readonly SearchPerformanceUpsertRow[] {
  const perQuery: SearchPerformanceUpsertRow[] = []
  const totals = new Map<string, { impressions: number; clicks: number; weightedPosition: number }>()

  for (const row of rows) {
    const pageUrl = row.keys[0]
    const query = row.keys[1]
    if (pageUrl === undefined || query === undefined) {
      continue
    }
    const path = pageUrlToPath(pageUrl)
    if (path === null) {
      continue
    }
    perQuery.push({ date, page_path: path, query, impressions: row.impressions, clicks: row.clicks, position: round2(row.position) })
    const total = totals.get(path) ?? { impressions: 0, clicks: 0, weightedPosition: 0 }
    total.impressions += row.impressions
    total.clicks += row.clicks
    total.weightedPosition += row.position * row.impressions
    totals.set(path, total)
  }

  const totalRows: SearchPerformanceUpsertRow[] = [...totals.entries()].map(([path, total]) => ({
    date,
    page_path: path,
    query: PAGE_TOTAL_QUERY,
    impressions: total.impressions,
    clicks: total.clicks,
    position: round2(total.impressions === 0 ? 0 : total.weightedPosition / total.impressions),
  }))

  return [...totalRows, ...perQuery]
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

// 평균 순위 → 구글 검색 결과 페이지 번호 (1페이지 = 1~10위).
export function searchResultPageNumber(position: number): number {
  if (position <= 0) {
    return 0
  }
  return Math.ceil(position / 10)
}

// 순위 변화 — 양수 = 상승(순위 숫자 감소). 비교 대상이 없으면 null.
export function positionDelta(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || previous <= 0 || current <= 0) {
    return null
  }
  return round2(previous - current)
}

// 동기화 대상 날짜 — GSC 데이터는 2~3일 지연되므로 어제부터 lookback일 전까지 매일 덮어쓴다
// (dataState=all 잠정치 → 이후 실행에서 확정치로 수렴).
export function syncTargetDates(nowUtc: Date, lookbackDays = 5): readonly string[] {
  const dates: string[] = []
  for (let offset = 1; offset <= lookbackDays; offset += 1) {
    const day = new Date(nowUtc.getTime() - offset * 24 * 60 * 60 * 1000)
    dates.push(day.toISOString().slice(0, 10))
  }
  return dates
}
