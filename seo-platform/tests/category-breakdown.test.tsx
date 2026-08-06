// 업종별 현황 — 수집 편중과 배포 진행을 화면에서 읽을 수 있어야 한다.
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { CategoryBreakdownSection } from "@/components/admin/category-breakdown-section"
import type { CategoryBreakdown } from "@/lib/admin/category-breakdown"

const BREAKDOWN: CategoryBreakdown = {
  rows: [
    { category: "funeral", contentMode: "condolence", total: 380, published: 39, verified: 61 },
    { category: "숙박/행사", contentMode: "celebration", total: 1634, published: 2, verified: 5 },
    { category: "hospital", contentMode: null, total: 5163, published: 0, verified: 0 },
  ],
  totalPlaces: 20552,
  totalPublished: 44,
  supportedTotal: 8332,
  unsupportedTotal: 12220,
}

describe("업종별 현황 표", () => {
  it("shows collected / verified / published counts and the published share per category", () => {
    const markup = renderToStaticMarkup(<CategoryBreakdownSection breakdown={BREAKDOWN} />)
    expect(markup).toContain("업종별 현황")
    expect(markup).toContain("funeral")
    expect(markup).toContain("380")
    expect(markup).toContain("39")
    // 380곳 중 39곳 공개 = 10.3%
    expect(markup).toContain("10.3%")
    // 공개 0인 업종은 비율 대신 '-'
    expect(markup).toContain("hospital")
    expect(markup).toContain("미지원")
  })

  it("summarises how much of the collection is even generatable", () => {
    const markup = renderToStaticMarkup(<CategoryBreakdownSection breakdown={BREAKDOWN} />)
    expect(markup).toContain("20,552")
    expect(markup).toContain("8,332")
    // 8,332 / 20,552 = 41%
    expect(markup).toContain("41%")
    expect(markup).toContain("44")
  })
})
