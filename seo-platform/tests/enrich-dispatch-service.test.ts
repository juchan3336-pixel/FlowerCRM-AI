// Enrich 외부 예약 dispatch — 한 번의 호출이 지키는 순서, 경쟁 상황, GitHub 호출 계약.
//
// DB는 migration의 세 RPC(claim / prepare / finish)와 같은 규칙으로 동작하는 메모리 모델이다.
// 상태를 공유하므로 두 호출을 겹쳐 돌려 경쟁을 재현할 수 있다. 실제 PostgreSQL의 잠금 동작
// 자체는 여기서 증명하지 않는다 — 그것은 적용 전 실측 항목이다.
import { describe, expect, it, vi } from "vitest"

import { countActiveEnrichRuns, dispatchEnrichWorkflow } from "@/lib/enrich-dispatch/github-client"
import type { EnrichDispatchMode } from "@/lib/enrich-dispatch/policy"
import {
  MIN_DISPATCH_BUDGET_MS,
  runEnrichDispatchTick,
  type DispatchPreparation,
  type EnrichDispatchDependencies,
  type GithubDispatchResult,
  type LedgerFinish,
  type SlotClaim,
} from "@/lib/enrich-dispatch/service"

const SLOT_A = "2026-11-10T01:30:00.000Z"
const SLOT_B = "2026-11-10T03:00:00.000Z"
const FAR_DEADLINE = Date.now() + 60_000

type Row = { dispatchId: string; status: string; mode: EnrichDispatchMode | null; httpStatus: number | null; runId: number | null }

/** migrations/202611100003_enrich_dispatch_control.sql 의 규칙을 그대로 옮긴 모델. */
function makeDb(initial: { enabled?: boolean; mode?: EnrichDispatchMode } = {}) {
  const control: { enabled: boolean; mode: EnrichDispatchMode } = { enabled: initial.enabled ?? true, mode: initial.mode ?? "live" }
  const rows = new Map<string, Row>()
  const open = () => [...rows.values()].some((row) => ["claimed", "dispatching", "unknown"].includes(row.status))
  return {
    control,
    rows,
    claim(slot: string, dispatchId: string): SlotClaim {
      if (!control.enabled) return "disabled"
      if (open()) return "blocked"
      if (rows.has(slot)) return "duplicate"
      rows.set(slot, { dispatchId, status: "claimed", mode: null, httpStatus: null, runId: null })
      return "claimed"
    },
    prepare(slot: string, dispatchId: string): DispatchPreparation {
      const row = rows.get(slot)
      const owned = row?.dispatchId === dispatchId && row.status === "claimed" ? row : undefined
      if (!control.enabled) {
        if (owned !== undefined) owned.status = "cancelled"
        return "disabled"
      }
      if (owned === undefined) return "lost"
      owned.status = "dispatching"
      owned.mode = control.mode
      return control.mode
    },
    finish(slot: string, dispatchId: string, finish: LedgerFinish): boolean {
      const row = rows.get(slot)
      if (row?.dispatchId !== dispatchId || row.status !== finish.from) return false
      row.status = finish.status
      row.httpStatus = "httpStatus" in finish ? finish.httpStatus : null
      row.runId = "runId" in finish ? finish.runId : null
      return true
    },
  }
}

type Hooks = {
  countActiveRuns?: () => Promise<number>
  dispatch?: (inputs: Record<string, string>) => Promise<GithubDispatchResult>
  finishFails?: boolean
}

function makeDeps(db: ReturnType<typeof makeDb>, id: string, hooks: Hooks = {}) {
  const posts: Record<string, string>[] = []
  const deps: EnrichDispatchDependencies = {
    claimSlot: (slot, dispatchId) => Promise.resolve(db.claim(slot, dispatchId)),
    prepareDispatch: (slot, dispatchId) => Promise.resolve(db.prepare(slot, dispatchId)),
    finishSlot: (slot, dispatchId, finish) => (hooks.finishFails === true ? Promise.resolve(false) : Promise.resolve(db.finish(slot, dispatchId, finish))),
    countActiveRuns: hooks.countActiveRuns ?? (() => Promise.resolve(0)),
    dispatchWorkflow: (inputs) => {
      posts.push(inputs)
      return hooks.dispatch === undefined ? Promise.resolve({ kind: "accepted", httpStatus: 204, runId: null }) : hooks.dispatch(inputs)
    },
    newDispatchId: () => id,
  }
  return { deps, posts }
}

/** 밖에서 풀어 줄 때까지 기다리는 promise. */
function gate<T>() {
  let open: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

const tick = (deps: EnrichDispatchDependencies, slot: string, deadlineAtMs = FAR_DEADLINE) => runEnrichDispatchTick(deps, { slot, deadlineAtMs })

describe("runEnrichDispatchTick — 한 호출", () => {
  it("정상 경로: slot을 잡고, 확인하고, 준비된 mode로 한 번 보내고, sent로 끝난다", async () => {
    const db = makeDb({ mode: "live" })
    const { deps, posts } = makeDeps(db, "id-1", { dispatch: () => Promise.resolve({ kind: "accepted", httpStatus: 200, runId: 987 }) })
    expect(await tick(deps, SLOT_A)).toEqual({ kind: "sent", slot: SLOT_A, mode: "live", runId: 987 })
    expect(posts).toEqual([{ limit: "50", dry_run: "false", from_start: "false", dispatch_id: "id-1" }])
    expect(db.rows.get(SLOT_A)).toMatchObject({ status: "sent", mode: "live", httpStatus: 200, runId: 987 })
  })

  it("dry_run 모드에서는 쓰기 없는 실행을 요청한다", async () => {
    const db = makeDb({ mode: "dry_run" })
    const { deps, posts } = makeDeps(db, "id-1")
    expect(await tick(deps, SLOT_A)).toMatchObject({ kind: "sent", mode: "dry_run" })
    expect(posts[0]?.["dry_run"]).toBe("true")
  })

  it("꺼져 있으면 기록도 남기지 않고 GitHub도 부르지 않는다", async () => {
    const db = makeDb({ enabled: false })
    const countActiveRuns = vi.fn(() => Promise.resolve(0))
    const { deps, posts } = makeDeps(db, "id-1", { countActiveRuns })
    expect(await tick(deps, SLOT_A)).toEqual({ kind: "noop", reason: "disabled" })
    expect(countActiveRuns).not.toHaveBeenCalled()
    expect(posts).toEqual([])
    expect(db.rows.size).toBe(0)
  })

  it("같은 slot의 두 번째 호출은 보내지 않는다", async () => {
    const db = makeDb()
    expect((await tick(makeDeps(db, "id-1").deps, SLOT_A)).kind).toBe("sent")
    const second = makeDeps(db, "id-2")
    expect(await tick(second.deps, SLOT_A)).toEqual({ kind: "noop", reason: "duplicate-slot" })
    expect(second.posts).toEqual([])
  })

  it("진행·대기 중인 run이 있으면 건너뛰고 slot을 놓는다", async () => {
    const db = makeDb()
    const { deps, posts } = makeDeps(db, "id-1", { countActiveRuns: () => Promise.resolve(1) })
    expect(await tick(deps, SLOT_A)).toEqual({ kind: "noop", reason: "busy" })
    expect(posts).toEqual([])
    expect(db.rows.get(SLOT_A)?.status).toBe("busy")
    // 놓았으므로 다음 slot은 막히지 않는다.
    expect((await tick(makeDeps(db, "id-2").deps, SLOT_B)).kind).toBe("sent")
  })

  it("run 상태를 확인하지 못하면 보내지 않는다", async () => {
    const db = makeDb()
    const { deps, posts } = makeDeps(db, "id-1", { countActiveRuns: () => Promise.reject(new Error("github down")) })
    expect(await tick(deps, SLOT_A)).toEqual({ kind: "noop", reason: "check-failed" })
    expect(posts).toEqual([])
    expect(db.rows.get(SLOT_A)?.status).toBe("check_failed")
  })

  it("GitHub이 거절하면 rejected로 끝난다 — 보내지지 않은 것이 확실하므로 다음 slot을 막지 않는다", async () => {
    for (const httpStatus of [401, 403, 404, 422, 429]) {
      const db = makeDb()
      const { deps } = makeDeps(db, "id-1", { dispatch: () => Promise.resolve({ kind: "rejected", httpStatus }) })
      expect(await tick(deps, SLOT_A)).toEqual({ kind: "rejected", slot: SLOT_A, httpStatus })
      expect(db.rows.get(SLOT_A)).toMatchObject({ status: "rejected", httpStatus })
      expect((await tick(makeDeps(db, "id-2").deps, SLOT_B)).kind).toBe("sent")
    }
  })

  it("응답을 못 받았거나 5xx면 unknown으로 남고, 그 뒤의 모든 slot이 막힌다", async () => {
    for (const httpStatus of [null, 500, 502, 503]) {
      const db = makeDb()
      const first = makeDeps(db, "id-1", { dispatch: () => Promise.resolve({ kind: "unknown", httpStatus }) })
      expect(await tick(first.deps, SLOT_A)).toEqual({ kind: "unknown", slot: SLOT_A })
      expect(first.posts).toHaveLength(1)
      expect(db.rows.get(SLOT_A)?.status).toBe("unknown")

      const next = makeDeps(db, "id-2")
      expect(await tick(next.deps, SLOT_B)).toEqual({ kind: "noop", reason: "blocked" })
      expect(next.posts).toEqual([])
    }
  })

  it("dispatch가 던지면(프로세스 중단 등) 행은 dispatching으로 남아 이후를 막고, 다시 보내지 않는다", async () => {
    const db = makeDb()
    const first = makeDeps(db, "id-1", { dispatch: () => Promise.reject(new Error("process interrupted")) })
    await expect(tick(first.deps, SLOT_A)).rejects.toThrow("process interrupted")
    expect(first.posts).toHaveLength(1)
    expect(db.rows.get(SLOT_A)?.status).toBe("dispatching")

    const next = makeDeps(db, "id-2")
    expect(await tick(next.deps, SLOT_B)).toEqual({ kind: "noop", reason: "blocked" })
    expect(next.posts).toEqual([])
  })

  it("접수됐는데 기록이 한 행도 바뀌지 않으면 실패로 드러낸다 (행은 dispatching으로 남는다)", async () => {
    const db = makeDb()
    const { deps, posts } = makeDeps(db, "id-1", { finishFails: true })
    await expect(tick(deps, SLOT_A)).rejects.toThrow(/ledger row could not be updated/)
    expect(posts).toHaveLength(1)
    expect(db.rows.get(SLOT_A)?.status).toBe("dispatching")
  })
})

describe("runEnrichDispatchTick — 경쟁", () => {
  it("이전 slot의 호출이 확인 단계에서 기다리는 동안 다음 slot의 호출이 와도 dispatch는 한 번이다", async () => {
    const db = makeDb()
    const waiting = gate<number>()
    const slow = makeDeps(db, "id-A", { countActiveRuns: () => waiting.promise })
    const pending = tick(slow.deps, SLOT_A) // slot A를 잡고 상태 조회에서 멈춰 있다

    const fast = makeDeps(db, "id-B")
    expect(await tick(fast.deps, SLOT_B)).toEqual({ kind: "noop", reason: "blocked" })

    waiting.open(0)
    expect((await pending).kind).toBe("sent")
    expect(slow.posts.length + fast.posts.length).toBe(1)
  })

  it("확인하는 동안 꺼지면 보내지 않는다", async () => {
    const db = makeDb({ mode: "live" })
    const waiting = gate<number>()
    const { deps, posts } = makeDeps(db, "id-1", { countActiveRuns: () => waiting.promise })
    const pending = tick(deps, SLOT_A)

    db.control.enabled = false
    waiting.open(0)

    expect(await pending).toEqual({ kind: "noop", reason: "disabled" })
    expect(posts).toEqual([])
    expect(db.rows.get(SLOT_A)?.status).toBe("cancelled")
  })

  it("확인하는 동안 live가 dry_run으로 바뀌면 dry_run으로 나간다 — 처음 읽은 값이 아니다", async () => {
    const db = makeDb({ mode: "live" })
    const waiting = gate<number>()
    const { deps, posts } = makeDeps(db, "id-1", { countActiveRuns: () => waiting.promise })
    const pending = tick(deps, SLOT_A)

    db.control.mode = "dry_run"
    waiting.open(0)

    expect(await pending).toMatchObject({ kind: "sent", mode: "dry_run" })
    expect(posts[0]?.["dry_run"]).toBe("true")
    expect(db.rows.get(SLOT_A)?.mode).toBe("dry_run")
  })

  it("기다리는 사이 slot을 잃은 호출은 보내지 않는다", async () => {
    const db = makeDb()
    const waiting = gate<number>()
    const { deps, posts } = makeDeps(db, "id-1", { countActiveRuns: () => waiting.promise })
    const pending = tick(deps, SLOT_A)

    // 2분 넘게 claimed로 남아 정리된 경우와 같다.
    const row = db.rows.get(SLOT_A)
    if (row !== undefined) row.status = "abandoned"
    waiting.open(0)

    expect(await pending).toEqual({ kind: "noop", reason: "lost-claim" })
    expect(posts).toEqual([])
  })

  it("같은 slot에 두 호출이 동시에 와도 한쪽만 보낸다", async () => {
    const db = makeDb()
    const first = makeDeps(db, "id-1")
    const second = makeDeps(db, "id-2")
    const outcomes = await Promise.all([tick(first.deps, SLOT_A), tick(second.deps, SLOT_A)])
    expect(outcomes.filter((outcome) => outcome.kind === "sent")).toHaveLength(1)
    expect(first.posts.length + second.posts.length).toBe(1)
  })
})

describe("runEnrichDispatchTick — 시간", () => {
  it("확인이 끝났을 때 남은 시간이 부족하면 보내지 않고 slot을 놓는다", async () => {
    const db = makeDb()
    let clock = 0
    const { deps, posts } = makeDeps(db, "id-1", {
      countActiveRuns: () => {
        clock = 25_000 - MIN_DISPATCH_BUDGET_MS + 1
        return Promise.resolve(0)
      },
    })
    expect(await runEnrichDispatchTick(deps, { slot: SLOT_A, deadlineAtMs: 25_000, now: () => clock })).toEqual({ kind: "noop", reason: "out-of-time" })
    expect(posts).toEqual([])
    expect(db.rows.get(SLOT_A)?.status).toBe("out_of_time")
  })

  it("남은 시간이 충분하면 보낸다", async () => {
    const db = makeDb()
    let clock = 0
    const { deps, posts } = makeDeps(db, "id-1", {
      countActiveRuns: () => {
        clock = 25_000 - MIN_DISPATCH_BUDGET_MS
        return Promise.resolve(0)
      },
    })
    expect((await runEnrichDispatchTick(deps, { slot: SLOT_A, deadlineAtMs: 25_000, now: () => clock })).kind).toBe("sent")
    expect(posts).toHaveLength(1)
  })

  it("각 단계에는 남은 시간만큼만 유효한 신호가 전달된다", async () => {
    const db = makeDb()
    const signals: AbortSignal[] = []
    const { deps } = makeDeps(db, "id-1")
    const recording: EnrichDispatchDependencies = {
      ...deps,
      claimSlot: (slot, id, signal) => (signals.push(signal), deps.claimSlot(slot, id, signal)),
      countActiveRuns: (signal) => (signals.push(signal), deps.countActiveRuns(signal)),
      prepareDispatch: (slot, id, signal) => (signals.push(signal), deps.prepareDispatch(slot, id, signal)),
      dispatchWorkflow: (inputs, signal) => (signals.push(signal), deps.dispatchWorkflow(inputs, signal)),
    }
    await tick(recording, SLOT_A)
    expect(signals).toHaveLength(4)
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal)
  })
})

describe("GitHub 호출", () => {
  const TOKEN = "github-token-value"
  type FetchCall = { readonly url: string; readonly init: RequestInit }
  const live = () => AbortSignal.timeout(5000)
  const respond = (body: string | null, status: number) => () => Promise.resolve(new Response(body, { status }))
  const okCount = (count: number) => new Response(JSON.stringify({ total_count: count, workflow_runs: [] }), { status: 200 })

  function recordingFetch(reply: (url: string) => Response) {
    const calls: FetchCall[] = []
    const fetchImpl = (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return Promise.resolve(reply(url))
    }
    return { calls, fetchImpl }
  }

  it("다섯 가지 진행·대기 상태를 모두 조회해 합친다", async () => {
    const signal = live()
    const { calls, fetchImpl } = recordingFetch((url) => okCount(url.includes("status=in_progress") ? 1 : url.includes("status=queued") ? 2 : 0))
    expect(await countActiveEnrichRuns(TOKEN, signal, fetchImpl)).toBe(3)
    expect(calls.map(({ url }) => new URL(url).searchParams.get("status")).sort()).toEqual(["in_progress", "pending", "queued", "requested", "waiting"])
    for (const { url, init } of calls) {
      expect(url.startsWith("https://api.github.com/repos/juchan3336-pixel/FlowerCRM-AI/actions/workflows/enrich.yml/runs?")).toBe(true)
      expect(init.method).toBe("GET")
      expect(init.signal).toBe(signal)
      // branch·event로 좁히지 않는다 — 누가 어떤 ref로 시작했든 run은 run이다.
      expect(url).not.toMatch(/branch=|event=/)
    }
  })

  it("다섯 조회는 동시에 나간다 — 걸리는 시간이 다섯 배가 되지 않는다", async () => {
    const release = gate<Response>()
    let started = 0
    const fetchImpl = () => {
      started += 1
      return release.promise.then(() => okCount(0))
    }
    const pending = countActiveEnrichRuns(TOKEN, live(), fetchImpl)
    await Promise.resolve()
    expect(started).toBe(5)
    release.open(okCount(0))
    expect(await pending).toBe(0)
  })

  it("하나라도 확인하지 못하면 0을 돌려주지 않고 던진다", async () => {
    await expect(countActiveEnrichRuns(TOKEN, live(), respond("", 500))).rejects.toThrow()
    await expect(countActiveEnrichRuns(TOKEN, live(), respond("{}", 200))).rejects.toThrow()
    await expect(countActiveEnrichRuns(TOKEN, live(), respond(JSON.stringify({ total_count: "3" }), 200))).rejects.toThrow()
    await expect(countActiveEnrichRuns(TOKEN, live(), () => Promise.reject(new Error("network")))).rejects.toThrow()
    const oneFails = (url: string) => Promise.resolve(url.includes("status=waiting") ? new Response("", { status: 502 }) : okCount(0))
    await expect(countActiveEnrichRuns(TOKEN, live(), oneFails)).rejects.toThrow()
  })

  it("dispatch는 고정된 저장소·워크플로·ref로만 간다", async () => {
    const signal = live()
    const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }))
    const result = await dispatchEnrichWorkflow(TOKEN, { limit: "50", dry_run: "true", from_start: "false", dispatch_id: "id" }, signal, fetchImpl)
    expect(result).toEqual({ kind: "accepted", httpStatus: 204, runId: null })
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call?.url).toBe("https://api.github.com/repos/juchan3336-pixel/FlowerCRM-AI/actions/workflows/enrich.yml/dispatches")
    expect(call?.init.method).toBe("POST")
    expect(call?.init.signal).toBe(signal)
    const sentBody = call?.init.body
    expect(typeof sentBody).toBe("string")
    expect(JSON.parse(typeof sentBody === "string" ? sentBody : "null")).toEqual({
      ref: "main",
      inputs: { limit: "50", dry_run: "true", from_start: "false", dispatch_id: "id" },
    })
  })

  it("기한이 이미 지났으면 요청을 시작하지 않는다 — 보내지 않은 것이 확실하다", async () => {
    const fetchImpl = vi.fn(respond(null, 204))
    expect(await dispatchEnrichWorkflow(TOKEN, {}, AbortSignal.abort(), fetchImpl)).toEqual({ kind: "rejected", httpStatus: 0 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("2xx 본문에 run id가 있으면 읽고, 없거나 깨져 있어도 접수로 본다", async () => {
    const inputs = { dry_run: "true" }
    expect(await dispatchEnrichWorkflow(TOKEN, inputs, live(), respond(JSON.stringify({ workflow_run_id: 4242 }), 200))).toEqual({
      kind: "accepted",
      httpStatus: 200,
      runId: 4242,
    })
    expect(await dispatchEnrichWorkflow(TOKEN, inputs, live(), respond("not json", 200))).toEqual({ kind: "accepted", httpStatus: 200, runId: null })
    expect(await dispatchEnrichWorkflow(TOKEN, inputs, live(), respond(JSON.stringify({ workflow_run_id: "4242" }), 201))).toEqual({
      kind: "accepted",
      httpStatus: 201,
      runId: null,
    })
  })

  it("4xx는 rejected, 5xx와 연결 실패는 unknown — 어느 쪽도 다시 보내지 않는다", async () => {
    for (const status of [401, 403, 404, 422, 429]) {
      const fetchImpl = vi.fn(respond(JSON.stringify({ message: "secret detail" }), status))
      expect(await dispatchEnrichWorkflow(TOKEN, {}, live(), fetchImpl)).toEqual({ kind: "rejected", httpStatus: status })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
    for (const status of [500, 502, 503]) {
      expect(await dispatchEnrichWorkflow(TOKEN, {}, live(), respond("", status))).toEqual({ kind: "unknown", httpStatus: status })
    }
    const failing = vi.fn(() => Promise.reject(new Error("timeout")))
    expect(await dispatchEnrichWorkflow(TOKEN, {}, live(), failing)).toEqual({ kind: "unknown", httpStatus: null })
    expect(failing).toHaveBeenCalledTimes(1)
  })

  it("결과에 토큰이나 GitHub 오류 원문이 실리지 않는다", async () => {
    const result = await dispatchEnrichWorkflow(TOKEN, {}, live(), respond(JSON.stringify({ message: `bad credentials ${TOKEN}` }), 401))
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(JSON.stringify(result)).not.toContain("bad credentials")
  })
})
