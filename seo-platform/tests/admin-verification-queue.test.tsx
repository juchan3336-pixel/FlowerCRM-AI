import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import {
  VerificationQueueFormView,
  filterVerificationCandidates,
  quickSelectVerificationCandidates,
  type VerificationQueueItem,
} from "@/components/admin/verification-queue-form"
import { isVerificationQueueCandidate } from "@/lib/admin/verification-queue"

vi.mock("server-only", () => ({}))
vi.mock("@/app/admin/verify/actions", () => ({
  markPlacesVerifiedAction: () => undefined,
}))

function item(id: string, name: string, overrides: Partial<VerificationQueueItem> = {}): VerificationQueueItem {
  return {
    placeId: id,
    name,
    region: "경북 · 포항시",
    address: "경북 포항시 북구 테스트로 1",
    phone: "054-000-0000",
    homepage: "https://example.test/",
    category: "funeral",
    contentMode: "condolence",
    ...overrides,
  }
}

describe("검증 큐 하드 조건", () => {
  const base = { status: "draft" as const, homepage: "https://example.test/", address: "주소 1", category: "funeral", official_verification_status: null }

  it("accepts a draft unverified place with a homepage, address, and mappable category", () => {
    expect(isVerificationQueueCandidate(base)).toBe(true)
  })

  it("rejects published, already-verified, homepage-less, address-less, and unmappable-category places", () => {
    expect(isVerificationQueueCandidate({ ...base, status: "published" })).toBe(false)
    expect(isVerificationQueueCandidate({ ...base, official_verification_status: "verified" })).toBe(false)
    expect(isVerificationQueueCandidate({ ...base, official_verification_status: "excluded" })).toBe(false)
    expect(isVerificationQueueCandidate({ ...base, homepage: null })).toBe(false)
    expect(isVerificationQueueCandidate({ ...base, homepage: "  " })).toBe(false)
    expect(isVerificationQueueCandidate({ ...base, address: null })).toBe(false)
    // 병원 등 모드 미지원 업종은 큐에 넣지 않는다 — 검증해도 생성 승인이 불가능하다.
    expect(isVerificationQueueCandidate({ ...base, category: "hospital" })).toBe(false)
  })
})

describe("검증 큐 카테고리 필터·수량 자동 선택", () => {
  const candidates = [
    item("f1", "장례1"),
    item("h1", "호텔1", { category: "호텔", contentMode: "celebration" }),
    item("f2", "장례2"),
    item("c1", "공장1", { category: "제조", contentMode: "corporate-celebration" }),
    ...Array.from({ length: 12 }, (_, i) => item(`f${String(i + 3)}`, `장례${String(i + 3)}`)),
  ]

  it("filters by content mode and keeps selection semantics", () => {
    expect(filterVerificationCandidates(candidates, "celebration").map((candidate) => candidate.placeId)).toEqual(["h1"])
    expect(filterVerificationCandidates(candidates, "all")).toHaveLength(16)
  })

  it("picks the top N of the chosen category and caps at the per-run limit of 10", () => {
    expect(quickSelectVerificationCandidates(candidates, "condolence", 3)).toEqual(["f1", "f2", "f3"])
    expect(quickSelectVerificationCandidates(candidates, "condolence", 99)).toHaveLength(10)
    expect(quickSelectVerificationCandidates(candidates, "corporate-celebration", 5)).toEqual(["c1"])
    expect(quickSelectVerificationCandidates(candidates, "all", 0)).toEqual([])
  })
})

describe("검증 큐 화면 렌더링", () => {
  it("renders the filter chips, quick-select controls, homepage links, and the confirm checkbox", () => {
    const markup = renderToStaticMarkup(
      createElement(VerificationQueueFormView, { candidates: [item("p1", "포항테스트장례식장")], isPending: false }),
    )
    expect(markup).toContain("검증 후보 필터")
    expect(markup).toContain("선택 수량")
    expect(markup).toContain("자동 선택")
    expect(markup).toContain("선택 해제")
    expect(markup).toContain("공식 홈페이지 확인")
    expect(markup).toContain('href="https://example.test/"')
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain("공식 검증(verified) 반영을 승인합니다")
    expect(markup).toContain("포항테스트장례식장")
  })

  it("shows the empty state when there are no candidates", () => {
    const markup = renderToStaticMarkup(createElement(VerificationQueueFormView, { candidates: [], isPending: false }))
    expect(markup).toContain("검증 대기 후보가 없습니다")
  })
})
