import { beforeEach, describe, expect, it, vi } from "vitest"

// 후보 조회는 server-only + supabase 의존 — 쿼리 빌더를 대역으로 바꿔
// 검색어가 서버 쿼리(name ilike)에 반영되는 계약만 검증한다.
vi.mock("server-only", () => ({}))

const ilikeCalls: { column: string; pattern: string }[] = []
let queryCount = 0

function createFakeQuery() {
  const query = {
    eq: () => query,
    in: () => query,
    ilike: (column: string, pattern: string) => {
      ilikeCalls.push({ column, pattern })
      return query
    },
    order: () => query,
    limit: () => Promise.resolve({ data: [], error: null }),
  }
  return query
}

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({
      select: () => {
        queryCount += 1
        return createFakeQuery()
      },
    }),
  }),
}))

import { listApprovalCandidates, normalizeApprovalSearchTerm } from "@/lib/batch/approval-candidates"

describe("normalizeApprovalSearchTerm", () => {
  it("앞뒤 공백을 제거한다", () => {
    expect(normalizeApprovalSearchTerm("  진주  ")).toBe("진주")
  })

  it("PostgREST 예약문자·ilike 와일드카드를 제거한다", () => {
    expect(normalizeApprovalSearchTerm("진%주_장(례)식,장'\"\\")).toBe("진주장례식장")
  })

  it("정규화 후 빈 문자열이면 검색 없음(null)으로 취급한다", () => {
    expect(normalizeApprovalSearchTerm("%%__,()")).toBeNull()
    expect(normalizeApprovalSearchTerm("   ")).toBeNull()
    expect(normalizeApprovalSearchTerm("")).toBeNull()
  })

  it("null·undefined는 그대로 검색 없음이다", () => {
    expect(normalizeApprovalSearchTerm(null)).toBeNull()
    expect(normalizeApprovalSearchTerm(undefined)).toBeNull()
  })
})

describe("listApprovalCandidates 검색", () => {
  beforeEach(() => {
    ilikeCalls.length = 0
    queryCount = 0
  })

  it("검색어가 없으면 ilike를 적용하지 않는다", async () => {
    await listApprovalCandidates()
    expect(queryCount).toBe(3)
    expect(ilikeCalls).toHaveLength(0)
  })

  it("검색어는 모든 모드 쿼리에 업체명 부분 일치(ilike)로 반영된다", async () => {
    await listApprovalCandidates(60, "진주")
    expect(queryCount).toBe(3)
    expect(ilikeCalls).toHaveLength(3)
    for (const call of ilikeCalls) {
      expect(call).toEqual({ column: "name", pattern: "%진주%" })
    }
  })

  it("예약문자를 제거한 검색어로 조회한다", async () => {
    await listApprovalCandidates(60, " 진%주_ ")
    expect(ilikeCalls[0]).toEqual({ column: "name", pattern: "%진주%" })
  })

  it("정규화 후 빈 검색어는 검색 없음으로 취급한다", async () => {
    await listApprovalCandidates(60, "%%__")
    expect(ilikeCalls).toHaveLength(0)
  })
})
