// 공개 캐시 갱신 요청 — Preview에서 고친 공개 콘텐츠를 Production이 갱신하게 하는 통로.
// 임의 경로의 캐시를 흔드는 수단이 되면 안 되고, 갱신이 실패한 요청은 사라지면 안 된다.
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

type Row = { key: string; value: unknown }
let rows: Row[] = []
let insertError: { message: string; code?: string } | null = null
let deleteFails = false

function builder() {
  let pattern: RegExp | null = null
  let key: string | null = null
  let remove = false
  let max = Infinity
  const selected = (): Row[] => rows.filter((row) => (pattern === null || pattern.test(row.key)) && (key === null || row.key === key))
  const run = (): { data: Row[] | null; error: { message: string } | null } => {
    if (remove) {
      if (deleteFails) {
        return { data: null, error: { message: "delete failed" } }
      }
      const targets = selected()
      rows = rows.filter((row) => !targets.includes(row))
      return { data: targets, error: null }
    }
    return { data: selected().slice(0, max), error: null }
  }
  const api = {
    select: () => api,
    // PostgreSQL LIKE 규칙 그대로: '_'는 임의 한 글자, '%'는 임의 길이. (startsWith로 흉내 내면 와일드카드 오류가 숨는다.)
    like: (_column: string, likePattern: string) => {
      const source = [...likePattern].map((char) => (char === "%" ? ".*" : char === "_" ? "." : char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("")
      pattern = new RegExp(`^${source}$`)
      return api
    },
    order: () => api,
    limit: (count: number) => {
      max = count
      return api
    },
    eq: (_column: string, value: string) => {
      key = value
      return api
    },
    delete: () => {
      remove = true
      return api
    },
    insert: (row: Row) => {
      if (insertError !== null) {
        return Promise.resolve({ error: insertError })
      }
      if (rows.some((existing) => existing.key === row.key)) {
        return Promise.resolve({ error: { message: "duplicate", code: "23505" } })
      }
      rows.push(row)
      return Promise.resolve({ error: null })
    },
    then: (onFulfilled: (value: { data: Row[] | null; error: { message: string } | null }) => unknown) => Promise.resolve(run()).then(onFulfilled),
  }
  return api
}
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceRoleClient: () => ({ from: () => builder() }) }))

const NOW = "2026-11-10T09:00:00.000Z"
const PATH = "/places/area-seoul-test"

beforeEach(() => {
  rows = []
  insertError = null
  deleteFails = false
})

describe("요청 남기기", () => {
  it("공개 장소 경로의 요청을 남긴다", async () => {
    const { requestPublicRevalidation } = await import("@/lib/seo-pages/revalidate-requests")
    expect(await requestPublicRevalidation({ id: "faq-fix-1-0", path: PATH, by: "ops:faq-fix", nowIso: NOW })).toBe(true)
    expect(rows).toEqual([{ key: "revalidate-request:faq-fix-1-0", value: { path: PATH, by: "ops:faq-fix", requested_at: NOW } }])
  })

  it("같은 요청이 이미 있으면 그대로 두고 성공으로 본다", async () => {
    const { requestPublicRevalidation } = await import("@/lib/seo-pages/revalidate-requests")
    await requestPublicRevalidation({ id: "faq-fix-1-0", path: PATH, by: "ops:faq-fix", nowIso: NOW })
    expect(await requestPublicRevalidation({ id: "faq-fix-1-0", path: PATH, by: "ops:faq-fix", nowIso: NOW })).toBe(true)
    expect(rows).toHaveLength(1)
  })

  it.each([["/admin"], ["/places/"], ["/places/a/b"], ["/places/A"], ["/"], ["places/x"], ["/places/x?y=1"], ["https://evil.example/places/x"]])("장소 경로가 아니면 남기지 않는다: %s", async (path) => {
    const { requestPublicRevalidation } = await import("@/lib/seo-pages/revalidate-requests")
    expect(await requestPublicRevalidation({ id: "faq-fix-1-0", path, by: "ops:faq-fix", nowIso: NOW })).toBe(false)
    expect(rows).toEqual([])
  })

  it("ID 형식이 어긋나거나 저장이 실패하면 false", async () => {
    const { requestPublicRevalidation } = await import("@/lib/seo-pages/revalidate-requests")
    expect(await requestPublicRevalidation({ id: "A B", path: PATH, by: "ops:faq-fix", nowIso: NOW })).toBe(false)
    insertError = { message: "down" }
    expect(await requestPublicRevalidation({ id: "faq-fix-1-0", path: PATH, by: "ops:faq-fix", nowIso: NOW })).toBe(false)
  })
})

describe("요청 처리 (Production)", () => {
  it("갱신에 성공한 요청만 지운다", async () => {
    const { processRevalidateRequests } = await import("@/lib/seo-pages/revalidate-requests")
    rows = [
      { key: "revalidate-request:a-0", value: { path: "/places/a" } },
      { key: "revalidate-request:b-0", value: { path: "/places/b" } },
      { key: "ops_task", value: { id: "other" } },
    ]
    const revalidated: string[] = []
    const outcome = await processRevalidateRequests((path) => {
      revalidated.push(path)
      return path !== "/places/b"
    })

    expect(outcome).toEqual({ processed: 1, failed: 1, discarded: 0 })
    expect(revalidated).toEqual(["/places/a", "/places/b"])
    // 실패한 요청은 남아 다음 주기에 다시 시도된다. 다른 설정 행은 건드리지 않는다.
    expect(rows.map((row) => row.key)).toEqual(["revalidate-request:b-0", "ops_task"])
  })

  it("형식이 잘못된 요청은 갱신 없이 지운다", async () => {
    const { processRevalidateRequests } = await import("@/lib/seo-pages/revalidate-requests")
    rows = [
      { key: "revalidate-request:x-0", value: { path: "/admin" } },
      { key: "revalidate-request:y-0", value: "not an object" },
    ]
    const revalidate = vi.fn<(path: string) => boolean>(() => true)

    expect(await processRevalidateRequests(revalidate)).toEqual({ processed: 0, failed: 0, discarded: 2 })
    expect(revalidate).not.toHaveBeenCalled()
    expect(rows).toEqual([])
  })

  it("큐 접두사에는 SQL LIKE 와일드카드가 없다", async () => {
    const { REVALIDATE_REQUEST_PREFIX } = await import("@/lib/seo-pages/revalidate-requests")
    expect(REVALIDATE_REQUEST_PREFIX).not.toMatch(/[_%]/)
  })

  it("이름이 비슷한 다른 설정 행은 조회하지도 지우지도 않는다", async () => {
    const { processRevalidateRequests } = await import("@/lib/seo-pages/revalidate-requests")
    const others = [
      { key: "revalidateXrequest:other-feature", value: { note: "path 없음" } },
      { key: "revalidate_request:legacy", value: { path: "/places/legacy" } },
      { key: "revalidate-requests", value: { path: "/places/a" } },
      { key: "xrevalidate-request:a", value: { path: "/places/a" } },
      { key: "revalidate-request:", value: { path: "/places/a" } },
    ]
    rows = [...others.map((row) => ({ ...row })), { key: "revalidate-request:real-0", value: { path: "/places/real" } }]
    const revalidated: string[] = []

    const outcome = await processRevalidateRequests((path) => {
      revalidated.push(path)
      return true
    })

    expect(outcome).toEqual({ processed: 1, failed: 0, discarded: 0 })
    expect(revalidated).toEqual(["/places/real"])
    expect(rows).toEqual(others)
  })

  it("한 주기에 5건까지만 처리한다", async () => {
    const { processRevalidateRequests } = await import("@/lib/seo-pages/revalidate-requests")
    rows = Array.from({ length: 8 }, (_unused, index) => ({ key: `revalidate-request:r-${String(index)}`, value: { path: `/places/p${String(index)}` } }))

    expect((await processRevalidateRequests(() => true)).processed).toBe(5)
    expect(rows).toHaveLength(3)
  })

  it("갱신은 됐지만 행을 지우지 못하면 처리 완료로 세지 않는다", async () => {
    const { processRevalidateRequests } = await import("@/lib/seo-pages/revalidate-requests")
    rows = [{ key: "revalidate-request:a-0", value: { path: "/places/a" } }]
    deleteFails = true

    expect(await processRevalidateRequests(() => true)).toEqual({ processed: 0, failed: 1, discarded: 0 })
    expect(rows).toHaveLength(1)
  })
})
