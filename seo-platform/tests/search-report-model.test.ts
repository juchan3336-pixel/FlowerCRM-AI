// 검색 성과 리포트 순수 계층 — GSC 행 매핑·지표 계산 계약.
import { describe, expect, it } from "vitest"

import {
  buildPageTotalUpsertRows,
  buildQueryDetailUpsertRows,
  PAGE_TOTAL_QUERY,
  pageUrlToPath,
  positionDelta,
  searchResultPageNumber,
  syncTargetDates,
} from "@/lib/search-report/report-model"

describe("GSC 행 → 저장 행 매핑", () => {
  it("stores page-dimension rows as the query='' totals with the API's own values", () => {
    const rows = buildPageTotalUpsertRows("2026-08-05", [
      { keys: ["https://place.example.com/places/a"], clicks: 3, impressions: 45, ctr: 0.066, position: 15.6 },
      { keys: ["https://place.example.com/places/b"], clicks: 0, impressions: 5, ctr: 0, position: 55.4 },
    ])
    expect(rows).toEqual([
      { date: "2026-08-05", page_path: "/places/a", query: PAGE_TOTAL_QUERY, impressions: 45, clicks: 3, position: 15.6 },
      { date: "2026-08-05", page_path: "/places/b", query: PAGE_TOTAL_QUERY, impressions: 5, clicks: 0, position: 55.4 },
    ])
  })

  it("keeps query rows as details only and never fabricates a total from them", () => {
    const rows = buildQueryDetailUpsertRows("2026-08-05", [
      { keys: ["https://place.example.com/places/a", "a 근조화환"], clicks: 2, impressions: 10, ctr: 0.2, position: 4 },
      { keys: ["https://place.example.com/places/a", "a 화환 주문"], clicks: 1, impressions: 30, ctr: 0.03, position: 12 },
    ])
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.query !== PAGE_TOTAL_QUERY)).toBe(true)
  })

  it("supports anonymized queries: page total larger than the query-detail sum coexists on distinct keys", () => {
    // GSC UI 실측(노출 45) vs 검색어 합산(노출 4) 상황 — 합계와 상세가 다른 게 정상이다.
    const totals = buildPageTotalUpsertRows("2026-08-05", [{ keys: ["https://p.example.com/places/a"], clicks: 0, impressions: 45, ctr: 0, position: 15.6 }])
    const details = buildQueryDetailUpsertRows("2026-08-05", [{ keys: ["https://p.example.com/places/a", "안동전문장례식장"], clicks: 0, impressions: 1, ctr: 0, position: 40 }])
    const merged = [...totals, ...details]
    // 같은 (date, page_path)에서 query 값이 달라 유니크 키 충돌이 없다 — upsert 시 서로를 덮어쓰지 않는다.
    expect(new Set(merged.map((row) => `${row.date}|${row.page_path}|${row.query}`)).size).toBe(2)
    expect(totals[0]?.impressions).toBeGreaterThan(details[0]?.impressions ?? 0)
  })

  it("drops malformed page URLs instead of throwing", () => {
    expect(buildPageTotalUpsertRows("2026-08-05", [{ keys: ["not-a-url"], clicks: 0, impressions: 1, ctr: 0, position: 1 }])).toEqual([])
    expect(buildQueryDetailUpsertRows("2026-08-05", [{ keys: ["not-a-url", "화환"], clicks: 0, impressions: 1, ctr: 0, position: 1 }])).toEqual([])
    expect(pageUrlToPath("not-a-url")).toBeNull()
    expect(pageUrlToPath("https://place.example.com/places/a?x=1")).toBe("/places/a?x=1")
  })
})

describe("지표 계산", () => {
  it("maps average position to the Google result page number (10 results per page)", () => {
    expect(searchResultPageNumber(1)).toBe(1)
    expect(searchResultPageNumber(10)).toBe(1)
    expect(searchResultPageNumber(10.5)).toBe(2)
    expect(searchResultPageNumber(55.4)).toBe(6)
    expect(searchResultPageNumber(0)).toBe(0)
  })

  it("computes rank delta as positive-when-rising and null without a baseline", () => {
    // 12위 → 4위 = 8계단 상승(양수)
    expect(positionDelta(4, 12)).toBe(8)
    expect(positionDelta(12, 4)).toBe(-8)
    expect(positionDelta(4, null)).toBeNull()
    expect(positionDelta(4, 0)).toBeNull()
    expect(positionDelta(0, 4)).toBeNull()
  })

  it("targets the previous N days for sync (기본 7일 — GSC 지연 4일 실측 + 여유)", () => {
    expect(syncTargetDates(new Date("2026-08-07T05:00:00Z"), 3)).toEqual(["2026-08-06", "2026-08-05", "2026-08-04"])
    expect(syncTargetDates(new Date("2026-08-07T05:00:00Z"))).toHaveLength(7)
    expect(syncTargetDates(new Date("2026-08-07T05:00:00Z")).at(-1)).toBe("2026-07-31")
  })
})
