// 게시와 콘텐츠 보정의 상호 배제 계약.
//  - publish_lock: 실행 소유권(만료 있음). 게시 한 건과 보정 작업이 서로 배타적으로 쥔다.
//  - publish_freeze: 게시 금지 상태(만료 없음). 보정이 중단되면 사람이 내릴 때까지 남는다.
// 모르면(읽기 실패·값 깨짐) 게시하지 않는 쪽으로 판정한다.
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

type Row = { key: string; value: unknown }
let rows: Row[] = []
let failRead = false
let insertError: { message: string; code?: string } | null = null

function builder() {
  const filters: { column: string; value: unknown }[] = []
  let mode: "select" | "delete" | "update" = "select"
  let patch: Partial<Row> = {}
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
    if (mode === "update") {
      for (const row of targets) {
        Object.assign(row, patch)
      }
    }
    return { data: targets.map((row) => ({ ...row })), error: null }
  }
  const api = {
    select: () => api,
    delete: () => {
      mode = "delete"
      return api
    },
    update: (next: Partial<Row>) => {
      mode = "update"
      patch = next
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

// 게시 RPC 대역 — 원하는 시점까지 붙잡아 둘 수 있다.
let publishGate: Promise<void> = Promise.resolve()
const publishPlacePage = vi.fn(async () => {
  await publishGate
  return { kind: "published", path: "/places/x" }
})
vi.mock("@/lib/seo-pages/place-publish", () => ({ publishPlacePage: () => publishPlacePage() }))
vi.mock("@/lib/seo-pages/supabase-place-publish", () => ({ createSupabasePlacePublishRepository: () => ({}) }))
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }))

const NOW = "2026-11-10T07:00:00.000Z"
const lockRow = (by: string, until: string): Row => ({ key: "publish_lock", value: { by, until } })
const freezeRow = (by: string): Row => ({ key: "publish_freeze", value: { by, reason: "test", at: NOW } })
const FAR = "2999-01-01T00:00:00.000Z"
const PAST = "2026-11-10T06:00:00.000Z"
const find = (key: string): Row | undefined => rows.find((row) => row.key === key)

async function hold() {
  return import("@/lib/seo-pages/publish-hold")
}
async function publish() {
  const { runPlacePublish } = await import("@/lib/seo-pages/publish-runner")
  return runPlacePublish("place-1", { registerAfter: () => undefined })
}

beforeEach(() => {
  rows = []
  failRead = false
  insertError = null
  publishGate = Promise.resolve()
  publishPlacePage.mockClear()
})

describe("게시 lock (실행 소유권)", () => {
  it("비어 있으면 얻는다", async () => {
    const { acquirePublishLock } = await hold()
    expect(await acquirePublishLock({ by: "a", ttlMs: 60_000, nowIso: NOW })).toBe(true)
    expect(find("publish_lock")?.value).toEqual({ by: "a", until: "2026-11-10T07:01:00.000Z" })
  })

  it("살아 있는 lock이 있으면 얻지 못하고, 그 lock을 건드리지 않는다", async () => {
    const { acquirePublishLock } = await hold()
    rows = [lockRow("a", FAR)]
    expect(await acquirePublishLock({ by: "b", ttlMs: 60_000, nowIso: NOW })).toBe(false)
    expect(rows).toEqual([lockRow("a", FAR)])
  })

  it("만료된 lock은 치우고 다시 얻는다 (죽은 소유자)", async () => {
    const { acquirePublishLock } = await hold()
    rows = [lockRow("dead", PAST)]
    expect(await acquirePublishLock({ by: "b", ttlMs: 60_000, nowIso: NOW })).toBe(true)
    expect((find("publish_lock")?.value as Record<string, unknown>)["by"]).toBe("b")
  })

  it.each([
    ["문자열", "on"],
    ["JSON null", null],
    ["by 없음", { until: FAR }],
    ["until 해석 불가", { by: "a", until: "soon" }],
  ])("값이 깨진 lock(%s)은 치우지 않고, 얻지도 못한다", async (_label, value) => {
    const { acquirePublishLock } = await hold()
    rows = [{ key: "publish_lock", value }]
    expect(await acquirePublishLock({ by: "b", ttlMs: 60_000, nowIso: NOW })).toBe(false)
    expect(rows).toHaveLength(1)
  })

  it("동시에 얻으려는 다른 요청이 먼저 넣었으면 진다", async () => {
    const { acquirePublishLock } = await hold()
    insertError = { message: "duplicate key", code: "23505" }
    expect(await acquirePublishLock({ by: "b", ttlMs: 60_000, nowIso: NOW })).toBe(false)
  })

  it("자기가 쥔 lock만 놓는다", async () => {
    const { releasePublishLock } = await hold()
    rows = [lockRow("a", FAR)]
    await releasePublishLock("b")
    expect(rows).toHaveLength(1)
    await releasePublishLock("a")
    expect(rows).toHaveLength(0)
  })
})

describe("게시 금지 (freeze)", () => {
  it("행이 없으면 금지가 아니다", async () => {
    const { isPublishFrozen } = await hold()
    expect(await isPublishFrozen()).toBe(false)
  })

  it.each([
    ["정상 값", { by: "ops-task:a", reason: "x", at: NOW }],
    ["문자열", "on"],
    ["JSON null", null],
    ["빈 객체", {}],
  ])("행이 존재하면 값(%s)과 무관하게 금지다", async (_label, value) => {
    const { isPublishFrozen } = await hold()
    rows = [{ key: "publish_freeze", value }]
    expect(await isPublishFrozen()).toBe(true)
  })

  it("읽지 못하면 금지로 본다", async () => {
    const { isPublishFrozen } = await hold()
    failRead = true
    expect(await isPublishFrozen()).toBe(true)
  })

  // 중단된 보정의 중간 상태가 "시간이 지났다"는 이유로 게시되면 안 된다.
  it("만료가 없다 — 아주 오래된 금지도 금지다", async () => {
    const { isPublishFrozen } = await hold()
    rows = [{ key: "publish_freeze", value: { by: "ops-task:a", reason: "x", at: "2020-01-01T00:00:00.000Z" } }]
    expect(await isPublishFrozen()).toBe(true)
  })

  it("비어 있으면 세운다", async () => {
    const { setPublishFreeze } = await hold()
    expect(await setPublishFreeze({ by: "ops-task:a", reason: "r", nowIso: NOW })).toBe("set")
    expect(find("publish_freeze")?.value).toEqual({ by: "ops-task:a", reason: "r", at: NOW })
  })

  it("남이 세운 금지는 건드리지 않는다", async () => {
    const { setPublishFreeze } = await hold()
    rows = [freezeRow("ops-task:old")]
    expect(await setPublishFreeze({ by: "ops-task:new", reason: "r", nowIso: NOW })).toBe("held-by-other")
    expect(await setPublishFreeze({ by: "ops-task:new", reason: "r", nowIso: NOW, inheritFrom: "ops-task:someone-else" })).toBe("held-by-other")
    expect(rows).toEqual([freezeRow("ops-task:old")])
  })

  it("지정한 소유자의 금지는 넘겨받는다 (중단된 작업의 잔여를 잇는 경우)", async () => {
    const { setPublishFreeze, clearPublishFreeze } = await hold()
    rows = [freezeRow("ops-task:old")]
    expect(await setPublishFreeze({ by: "ops-task:new", reason: "resume", nowIso: NOW, inheritFrom: "ops-task:old" })).toBe("inherited")
    expect((find("publish_freeze")?.value as Record<string, unknown>)["by"]).toBe("ops-task:new")
    // 넘겨받은 뒤에는 옛 소유자 이름으로 내릴 수 없다.
    expect(await clearPublishFreeze("ops-task:old")).toBe(false)
    expect(await clearPublishFreeze("ops-task:new")).toBe(true)
    expect(rows).toHaveLength(0)
  })
})

describe("게시 코어 — lock을 쥐고 게시한다", () => {
  it("평소에는 게시하고, 끝나면 lock을 놓는다", async () => {
    expect(await publish()).toMatchObject({ kind: "published" })
    expect(find("publish_lock")).toBeUndefined()
  })

  it("게시 금지 중이면 게시하지 않고 lock을 놓는다", async () => {
    rows = [freezeRow("ops-task:a")]
    expect(await publish()).toEqual({ kind: "blocked" })
    expect(publishPlacePage).not.toHaveBeenCalled()
    expect(find("publish_lock")).toBeUndefined()
  })

  it("다른 소유자(보정 작업·다른 게시)가 lock을 쥐고 있으면 게시하지 않는다", async () => {
    rows = [lockRow("ops-task:a", FAR)]
    expect(await publish()).toEqual({ kind: "blocked" })
    expect(publishPlacePage).not.toHaveBeenCalled()
    expect(rows).toEqual([lockRow("ops-task:a", FAR)])
  })

  it("lock 상태를 읽지 못하면 게시하지 않는다", async () => {
    failRead = true
    expect(await publish()).toEqual({ kind: "blocked" })
    expect(publishPlacePage).not.toHaveBeenCalled()
  })

  it("게시가 실패해 던져도 lock은 놓는다", async () => {
    publishPlacePage.mockRejectedValueOnce(new Error("rpc exploded"))
    await expect(publish()).rejects.toThrow()
    expect(find("publish_lock")).toBeUndefined()
  })
})

// "보류 표식을 한 번 읽고 진행"으로는 막을 수 없던 순서. 읽은 뒤 RPC까지의 지연에는 상한이 없다.
describe("게시와 보정이 겹치는 순서", () => {
  it("게시가 진입한 뒤 오래 지연돼도, 그동안 보정은 lock을 얻지 못해 쓰기 구간에 들어가지 못한다", async () => {
    const { acquirePublishLock, setPublishFreeze, clearPublishFreeze } = await hold()
    let releasePublish: (() => void) | undefined
    publishGate = new Promise<void>((resolve) => {
      releasePublish = resolve
    })

    // 1) 게시가 lock을 얻고 금지 확인을 통과한 뒤 RPC에서 멈춰 있다.
    const publishing = publish()
    await vi.waitFor(() => {
      expect(publishPlacePage).toHaveBeenCalledTimes(1)
    })

    // 2) 그 사이 보정 작업이 시작한다: 금지를 세우고 lock을 얻으려 한다 — 게시가 끝나지 않은 한 얻지 못한다.
    // (5초 대기 같은 "충분히 기다림"이 아니라 소유권이다: 30초 뒤에 다시 시도해도 마찬가지다.)
    expect(await setPublishFreeze({ by: "ops-task:a", reason: "r", nowIso: NOW })).toBe("set")
    expect(await acquirePublishLock({ by: "ops-task:a", ttlMs: 180_000, nowIso: new Date().toISOString() })).toBe(false)
    expect(await acquirePublishLock({ by: "ops-task:a", ttlMs: 180_000, nowIso: new Date(Date.now() + 30_000).toISOString() })).toBe(false)
    // 보정은 아무것도 쓰지 않고 방금 세운 금지를 내리고 물러난다.
    expect(await clearPublishFreeze("ops-task:a")).toBe(true)

    // 3) 게시가 재개돼 끝난다. 보정은 그 뒤 주기에 lock을 얻는다.
    releasePublish?.()
    expect(await publishing).toMatchObject({ kind: "published" })
    expect(await acquirePublishLock({ by: "ops-task:a", ttlMs: 180_000, nowIso: new Date().toISOString() })).toBe(true)
  })

  it("보정이 금지를 세운 뒤에 시작한 게시는, lock을 얻더라도 금지를 보고 물러난다", async () => {
    const { setPublishFreeze } = await hold()
    await setPublishFreeze({ by: "ops-task:a", reason: "r", nowIso: NOW })

    expect(await publish()).toEqual({ kind: "blocked" })
    expect(publishPlacePage).not.toHaveBeenCalled()
  })

  it("보정이 lock을 쥔 동안 시작한 게시는 물러난다", async () => {
    const { setPublishFreeze, acquirePublishLock } = await hold()
    await setPublishFreeze({ by: "ops-task:a", reason: "r", nowIso: NOW })
    expect(await acquirePublishLock({ by: "ops-task:a", ttlMs: 180_000, nowIso: new Date().toISOString() })).toBe(true)

    expect(await publish()).toEqual({ kind: "blocked" })
    expect(publishPlacePage).not.toHaveBeenCalled()
  })

  it("보정이 중단돼 lock을 놓아도, 금지가 남아 있는 한 게시는 열리지 않는다", async () => {
    const { setPublishFreeze, acquirePublishLock, releasePublishLock } = await hold()
    await setPublishFreeze({ by: "ops-task:a", reason: "r", nowIso: NOW })
    await acquirePublishLock({ by: "ops-task:a", ttlMs: 180_000, nowIso: new Date().toISOString() })
    await releasePublishLock("ops-task:a")

    expect(await publish()).toEqual({ kind: "blocked" })
    expect(publishPlacePage).not.toHaveBeenCalled()
  })

  it("동시에 들어온 두 게시는 하나만 진행한다", async () => {
    let releasePublish: (() => void) | undefined
    publishGate = new Promise<void>((resolve) => {
      releasePublish = resolve
    })
    const first = publish()
    await vi.waitFor(() => {
      expect(publishPlacePage).toHaveBeenCalledTimes(1)
    })

    expect(await publish()).toEqual({ kind: "blocked" })
    releasePublish?.()
    expect(await first).toMatchObject({ kind: "published" })
    expect(publishPlacePage).toHaveBeenCalledTimes(1)
  })
})
