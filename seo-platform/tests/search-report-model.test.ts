// 검색 성과 리포트 순수 계층 — GSC 행 매핑·지표 계산 계약.
import { describe, expect, it } from "vitest"

import { buildUpsertRows, PAGE_TOTAL_QUERY, pageUrlToPath, positionDelta, searchResultPageNumber, syncTargetDates } from "@/lib/search-report/report-model"

describe("GSC 행 → 저장 행 매핑", () => {
  it("converts absolute page URLs to paths and builds a weighted page-total row", () => {
    const rows = buildUpsertRows("2026-08-05", [
      { keys: ["https://place.example.com/places/a", "a 근조화환"], clicks: 2, impressions: 10, ctr: 0.2, position: 4 },
      { keys: ["https://place.example.com/places/a", "a 화환 주문"], clicks: 1, impressions: 30, ctr: 0.03, position: 12 },
      { keys: ["https://place.example.com/places/b", "b 화환"], clicks: 0, impressions: 5, ctr: 0, position: 55.4 },
    ])

    const totalA = rows.find((row) => row.page_path === "/places/a" && row.query === PAGE_TOTAL_QUERY)
    // 합계 position은 노출수 가중 평균: (4*10 + 12*30) / 40 = 10
    expect(totalA).toEqual({ date: "2026-08-05", page_path: "/places/a", query: "", impressions: 40, clicks: 3, position: 10 })
    expect(rows.filter((row) => row.query !== PAGE_TOTAL_QUERY)).toHaveLength(3)
    expect(rows.find((row) => row.page_path === "/places/b" && row.query === PAGE_TOTAL_QUERY)?.position).toBe(55.4)
  })

  it("drops malformed page URLs instead of throwing", () => {
    const rows = buildUpsertRows("2026-08-05", [{ keys: ["not-a-url", "화환"], clicks: 0, impressions: 1, ctr: 0, position: 1 }])
    expect(rows).toEqual([])
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

  it("targets the previous N days for sync (GSC data lags 2-3 days)", () => {
    expect(syncTargetDates(new Date("2026-08-07T05:00:00Z"), 3)).toEqual(["2026-08-06", "2026-08-05", "2026-08-04"])
    expect(syncTargetDates(new Date("2026-08-07T05:00:00Z"))).toHaveLength(5)
  })
})
