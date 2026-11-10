// 검색 성과 리포트 순수 계층 — GSC 행 → 저장 행 매핑과 화면 지표 계산.
// DB·네트워크 접근이 없어 그대로 단위 테스트한다. 부수효과는 sync-service가 담당한다.
import type { GscRow } from "./gsc-client"

// 페이지 합계 행은 query='' 로 저장한다 — (date, page_path, query) 유니크 제약과 함께
// "합계 1행 + 검색어별 N행" 구조를 한 테이블에서 유지한다. query=''가 두 데이터 종류의 구분자다.
//
// 합계 행의 출처 (2026-09-02 교정): dimensions=["page"] 단독 조회의 API 원값이다.
// Google은 익명화된 검색어의 노출을 query 차원 결과에서 제외하므로, 검색어 행을 합산해 만든
// 합계는 실제보다 작아진다 (실측: GSC UI 노출 45 vs 검색어 합산 4). 합계와 검색어 상세를
// 단순 합산·비교하면 안 되는 이유이기도 하다.
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

// dimensions=["page"] 단독 응답 → 페이지 합계(query='') 행. API가 준 원값 그대로 저장한다
// (익명화 검색어 노출까지 포함된 정확한 총합 — 검색어 행 합산으로 계산하지 않는다).
export function buildPageTotalUpsertRows(date: string, rows: readonly GscRow[]): readonly SearchPerformanceUpsertRow[] {
  const totals: SearchPerformanceUpsertRow[] = []
  for (const row of rows) {
    const pageUrl = row.keys[0]
    if (pageUrl === undefined) {
      continue
    }
    const path = pageUrlToPath(pageUrl)
    if (path === null) {
      continue
    }
    totals.push({ date, page_path: path, query: PAGE_TOTAL_QUERY, impressions: row.impressions, clicks: row.clicks, position: round2(row.position) })
  }
  return totals
}

// dimensions=["page", "query"] 응답 → 검색어 상세 행. 합계 행은 만들지 않는다 —
// 합계는 buildPageTotalUpsertRows(페이지 단독 조회)가 담당한다.
export function buildQueryDetailUpsertRows(date: string, rows: readonly GscRow[]): readonly SearchPerformanceUpsertRow[] {
  const perQuery: SearchPerformanceUpsertRow[] = []
  for (const row of rows) {
    const pageUrl = row.keys[0]
    const query = row.keys[1]
    if (pageUrl === undefined || query === undefined || query === PAGE_TOTAL_QUERY) {
      continue
    }
    const path = pageUrlToPath(pageUrl)
    if (path === null) {
      continue
    }
    perQuery.push({ date, page_path: path, query, impressions: row.impressions, clicks: row.clicks, position: round2(row.position) })
  }
  return perQuery
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

// 동기화 대상 날짜 — GSC 데이터는 며칠 지연되므로 어제부터 lookback일 전까지 매일 덮어쓴다
// (dataState=all 잠정치 → 이후 실행에서 확정치로 수렴).
// 2026-09-02 실측: 8/29 노출이 9/2에야 내려옴(지연 4일) — 5일 창은 여유가 1일뿐이라 7일로 확대.
export function syncTargetDates(nowUtc: Date, lookbackDays = 7): readonly string[] {
  const dates: string[] = []
  for (let offset = 1; offset <= lookbackDays; offset += 1) {
    const day = new Date(nowUtc.getTime() - offset * 24 * 60 * 60 * 1000)
    dates.push(day.toISOString().slice(0, 10))
  }
  return dates
}
