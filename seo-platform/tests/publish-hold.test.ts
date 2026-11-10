// 게시 보류 계약 — 게시 준비 콘텐츠를 보정하는 동안 어떤 경로의 게시도 시작되지 않는다.
// 모르면(읽기 실패·값 깨짐) 게시하지 않는 쪽으로 판정한다.
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

type Row = { key: string; value: unknown }
let rows: Row[] = []
let failRead = false
let insertError: { message: string; code?: string } | null = null

function builder() {
  const filters: { column: string; value: unknown }[] = []
  let mode: "select" | "delete" = "select"
  const matched = (): Row[] =>
    rows.filter((row) =>
      filters.every((filter) => {
        if (filter.column === "key") {
          return row.key === filter.value
        }
        const field = /^value->>(.+)$/.exec(filter.column)?.[1]
        return field !== undefined && typeof row.value === "object" && row.value !== null && (row.value as Record<string, unknown>)[field] === filter.value
      }),
    )
  const run = (): { data: Row[] | null; error: { message: string } | null } => {
    if (failRead) {
      return { data: null, error: { message: "read failed" } }
    }
    const targets = matched()
    if (mode === "delete") {
      rows = rows.filter((row) => !targets.includes(row))
    }
    return { data: targets, error: null }
  }
  const api = {
    select: () => api,
    delete: () => {
      mode = "delete"
      return api
    },
    eq: (column: string, value: unknown) => {
      filters.push({ column, value })
      return api
    },
    insert: (row: Row) => {
      if (insertError !== null) {
        return Promise.resolve({ error: insertError })
      }
      if (rows.some((existing) => existing.key === row.key)) {
        return Promise.resolve({ error: { message: "duplicate key", code: "23505" } })
      }
      rows.push({ ...row })
      return Promise.resolve({ error: null })
    },
    maybeSingle: () => {
      const result = run()
      return Promise.resolve({ data: result.data?.[0] ?? null, error: result.error })
    },
    then: (onFulfilled: (value: ReturnType<typeof run>) => unknown, onRejected?: (reason: unknown) => unknown) => Promise.resolve(run()).then(onFulfilled, onRejected),
  }
  return api
}
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceRoleClient: () => ({ from: () => builder() }) }))

const publishPlacePage = vi.fn(() => Promise.resolve({ kind: "published", path: "/places/x" }))
vi.mock("@/lib/seo-pages/place-publish", () => ({ publishPlacePage: () => publishPlacePage() }))
vi.mock("@/lib/seo-pages/supabase-place-publish", () => ({ createSupabasePlacePublishRepository: () => ({}) }))
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }))

const NOW = "2026-11-10T07:00:00.000Z"
const LATER = "2026-11-10T07:30:00.000Z"
const PAST = "2026-11-10T06:00:00.000Z"
const hold = (by: string, until: string): Row => ({ key: "publish_hold", value: { by, until } })

beforeEach(() => {
  rows = []
  failRead = false
  insertError = null
  publishPlacePage.mockClear()
})

describe("보류 판정", () => {
  it("행이 없으면 보류가 아니다", async () => {
    const { isPublishHoldActive } = await import("@/lib/seo-pages/publish-hold")
    expect(isPublishHoldActive(undefined, NOW)).toBe(false)
    expect(isPublishHoldActive(null, NOW)).toBe(false)
  })

  it("만료 전이면 보류, 만료 시각부터는 보류가 아니다", async () => {
    const { isPublishHoldActive } = await import("@/lib/seo-pages/publish-hold")
    expect(isPublishHoldActive({ by: "ops-task:a", until: LATER }, NOW)).toBe(true)
    expect(isPublishHoldActive({ by: "ops-task:a", until: NOW }, NOW)).toBe(false)
    expect(isPublishHoldActive({ by: "ops-task:a", until: PAST }, NOW)).toBe(false)
  })

  it.each([
    ["문자열", "on"],
    ["배열", []],
    ["by 없음", { until: LATER }],
    ["until 해석 불가", { by: "ops-task:a", until: "soon" }],
  ])("값이 깨져 있으면(%s) 보류로 본다", async (_label, value) => {
    const { isPublishHoldActive } = await import("@/lib/seo-pages/publish-hold")
    expect(isPublishHoldActive(value, NOW)).toBe(true)
  })

  it("읽지 못하면 보류로 본다", async () => {
    const { isPublishHeld } = await import("@/lib/seo-pages/publish-hold")
    failRead = true
    expect(await isPublishHeld(NOW)).toBe(true)
  })
})

describe("획득과 해제", () => {
  it("비어 있으면 잡는다", async () => {
    const { acquirePublishHold, isPublishHeld } = await import("@/lib/seo-pages/publish-hold")
    expect(await acquirePublishHold({ by: "ops-task:a", until: LATER, nowIso: NOW })).toBe(true)
    expect(await isPublishHeld(NOW)).toBe(true)
  })

  it("살아 있는 보류가 있으면 잡지 못하고, 기존 보류를 건드리지 않는다", async () => {
    const { acquirePublishHold } = await import("@/lib/seo-pages/publish-hold")
    rows = [hold("ops-task:a", LATER)]
    expect(await acquirePublishHold({ by: "ops-task:b", until: LATER, nowIso: NOW })).toBe(false)
    expect(rows).toEqual([hold("ops-task:a", LATER)])
  })

  it("만료된 보류는 치우고 다시 잡는다", async () => {
    const { acquirePublishHold } = await import("@/lib/seo-pages/publish-hold")
    rows = [hold("ops-task:dead", PAST)]
    expect(await acquirePublishHold({ by: "ops-task:b", until: LATER, nowIso: NOW })).toBe(true)
    expect(rows).toEqual([hold("ops-task:b", LATER)])
  })

  it("값이 깨진 보류는 치우지 않는다 (무엇을 막으려던 것인지 모른다)", async () => {
    const { acquirePublishHold } = await import("@/lib/seo-pages/publish-hold")
    rows = [{ key: "publish_hold", value: "on" }]
    expect(await acquirePublishHold({ by: "ops-task:b", until: LATER, nowIso: NOW })).toBe(false)
    expect(rows).toHaveLength(1)
  })

  it("동시에 잡으려는 다른 요청이 먼저 넣었으면 진다", async () => {
    const { acquirePublishHold } = await import("@/lib/seo-pages/publish-hold")
    insertError = { message: "duplicate key", code: "23505" }
    expect(await acquirePublishHold({ by: "ops-task:b", until: LATER, nowIso: NOW })).toBe(false)
  })

  it("자기가 잡은 보류만 해제한다", async () => {
    const { releasePublishHold } = await import("@/lib/seo-pages/publish-hold")
    rows = [hold("ops-task:a", LATER)]
    await releasePublishHold("ops-task:b")
    expect(rows).toHaveLength(1)
    await releasePublishHold("ops-task:a")
    expect(rows).toHaveLength(0)
  })
})

describe("게시 코어", () => {
  it("보류 중이면 게시를 시작하지 않는다 (단건·배치·자동 게시 공용 진입점)", async () => {
    rows = [hold("ops-task:a", "2999-01-01T00:00:00.000Z")]
    const { runPlacePublish } = await import("@/lib/seo-pages/publish-runner")

    expect(await runPlacePublish("place-1", { registerAfter: () => undefined })).toEqual({ kind: "blocked" })
    expect(publishPlacePage).not.toHaveBeenCalled()
  })

  it("보류 상태를 읽지 못해도 게시하지 않는다", async () => {
    failRead = true
    const { runPlacePublish } = await import("@/lib/seo-pages/publish-runner")

    expect(await runPlacePublish("place-1", { registerAfter: () => undefined })).toEqual({ kind: "blocked" })
    expect(publishPlacePage).not.toHaveBeenCalled()
  })
})
