// Enrich 외부 예약 dispatch — 한 번의 호출이 지키는 순서와 GitHub 호출 계약.
import { describe, expect, it, vi } from "vitest"

import { countActiveEnrichRuns, dispatchEnrichWorkflow } from "@/lib/enrich-dispatch/github-client"
import {
  runEnrichDispatchTick,
  type DispatchControl,
  type EnrichDispatchDependencies,
  type GithubDispatchResult,
  type LedgerUpdate,
  type SlotClaim,
} from "@/lib/enrich-dispatch/service"

const NOW_MS = Date.parse("2026-11-10T03:02:00Z")
const SLOT = "2026-11-10T03:00:00.000Z"

type Overrides = {
  control?: DispatchControl
  claim?: SlotClaim
  activeRuns?: number | Error
  dispatch?: GithubDispatchResult | Error
  recordFailsOn?: LedgerUpdate["status"]
}

function makeDeps(overrides: Overrides = {}) {
  const records: LedgerUpdate[] = []
  const dispatched: Record<string, string>[] = []
  const calls: string[] = []
  const deps: EnrichDispatchDependencies = {
    readControl: () => {
      calls.push("readControl")
      return Promise.resolve(overrides.control ?? { enabled: true, mode: "live" })
    },
    claimSlot: (slot, dispatchId) => {
      calls.push(`claimSlot:${slot}:${dispatchId}`)
      return Promise.resolve(overrides.claim ?? "claimed")
    },
    recordSlot: (_slot, update) => {
      calls.push(`record:${update.status}`)
      if (overrides.recordFailsOn === update.status) return Promise.reject(new Error("ledger down"))
      records.push(update)
      return Promise.resolve()
    },
    countActiveRuns: () => {
      calls.push("countActiveRuns")
      if (overrides.activeRuns instanceof Error) return Promise.reject(overrides.activeRuns)
      return Promise.resolve(overrides.activeRuns ?? 0)
    },
    dispatchWorkflow: (inputs) => {
      calls.push("dispatch")
      dispatched.push(inputs)
      if (overrides.dispatch instanceof Error) return Promise.reject(overrides.dispatch)
      return Promise.resolve(overrides.dispatch ?? { kind: "accepted", httpStatus: 204, runId: null })
    },
    newDispatchId: () => "dispatch-id-1",
  }
  return { deps, records, dispatched, calls }
}

describe("runEnrichDispatchTick", () => {
  it("꺼져 있으면 slot도 잡지 않고 GitHub도 부르지 않는다", async () => {
    const { deps, calls } = makeDeps({ control: { enabled: false, mode: "live" } })
    expect(await runEnrichDispatchTick(deps, { nowMs: NOW_MS })).toEqual({ kind: "noop", reason: "disabled" })
    expect(calls).toEqual(["readControl"])
  })

  it("정상 경로: slot 확보 → 상태 확인 → 보내는 중 기록 → dispatch → 결과 기록", async () => {
    const { deps, calls, dispatched } = makeDeps({ dispatch: { kind: "accepted", httpStatus: 200, runId: 987 } })
    expect(await runEnrichDispatchTick(deps, { nowMs: NOW_MS })).toEqual({ kind: "sent", slot: SLOT, mode: "live", runId: 987 })
    expect(calls).toEqual(["readControl", `claimSlot:${SLOT}:dispatch-id-1`, "countActiveRuns", "record:dispatching", "dispatch", "record:sent"])
    expect(dispatched).toEqual([{ limit: "50", dry_run: "false", from_start: "false", dispatch_id: "dispatch-id-1" }])
  })

  it("dry_run 모드에서는 쓰기 없는 실행을 요청한다", async () => {
    const { deps, dispatched } = makeDeps({ control: { enabled: true, mode: "dry_run" } })
    const outcome = await runEnrichDispatchTick(deps, { nowMs: NOW_MS })
    expect(outcome).toMatchObject({ kind: "sent", mode: "dry_run" })
    expect(dispatched[0]?.["dry_run"]).toBe("true")
  })

  it("같은 slot의 두 번째 호출은 보내지 않는다", async () => {
    const { deps, calls } = makeDeps({ claim: "duplicate" })
    expect(await runEnrichDispatchTick(deps, { nowMs: NOW_MS })).toEqual({ kind: "noop", reason: "duplicate-slot" })
    expect(calls).not.toContain("dispatch")
    expect(calls).not.toContain("countActiveRuns")
  })

  it("결과를 모르는 과거 dispatch가 남아 있으면 보내지 않는다", async () => {
    const { deps, calls } = makeDeps({ claim: "blocked_unknown" })
    expect(await runEnrichDispatchTick(deps, { nowMs: NOW_MS })).toEqual({ kind: "noop", reason: "blocked-unknown" })
    expect(calls).not.toContain("dispatch")
  })

  it("진행·대기 중인 run이 있으면 이번 slot을 건너뛴다", async () => {
    const { deps, calls, records } = makeDeps({ activeRuns: 1 })
    expect(await runEnrichDispatchTick(deps, { nowMs: NOW_MS })).toEqual({ kind: "noop", reason: "busy" })
    expect(calls).not.toContain("dispatch")
    expect(records).toEqual([{ status: "busy" }])
  })

  it("run 상태를 확인하지 못하면 보내지 않는다", async () => {
    const { deps, calls, records } = makeDeps({ activeRuns: new Error("github down") })
    expect(await runEnrichDispatchTick(deps, { nowMs: NOW_MS })).toEqual({ kind: "noop", reason: "check-failed" })
    expect(calls).not.toContain("dispatch")
    expect(records).toEqual([{ status: "check_failed" }])
  })

  it("보내는 중 기록에 실패하면 보내지 않는다", async () => {
    const { deps, calls } = makeDeps({ recordFailsOn: "dispatching" })
    await expect(runEnrichDispatchTick(deps, { nowMs: NOW_MS })).rejects.toThrow("ledger down")
    expect(calls).not.toContain("dispatch")
  })

  it("GitHub이 거절하면 rejected로 남는다 — 보내지지 않은 것이 확실하다", async () => {
    for (const httpStatus of [401, 403, 404, 422, 429]) {
      const { deps, records } = makeDeps({ dispatch: { kind: "rejected", httpStatus } })
      expect(await runEnrichDispatchTick(deps, { nowMs: NOW_MS })).toEqual({ kind: "rejected", slot: SLOT, httpStatus })
      expect(records.at(-1)).toEqual({ status: "rejected", httpStatus })
    }
  })

  it("응답을 못 받았거나 5xx면 unknown으로 남고, 다시 보내지 않는다", async () => {
    for (const httpStatus of [null, 500, 502, 503]) {
      const { deps, records, dispatched } = makeDeps({ dispatch: { kind: "unknown", httpStatus } })
      expect(await runEnrichDispatchTick(deps, { nowMs: NOW_MS })).toEqual({ kind: "unknown", slot: SLOT })
      expect(records.at(-1)).toEqual({ status: "unknown", httpStatus })
      expect(dispatched).toHaveLength(1)
    }
  })

  it("dispatch 뒤 기록에 실패하면 행은 dispatching으로 남는다 (다음 호출의 claim이 막는다)", async () => {
    const { deps, records, dispatched } = makeDeps({ recordFailsOn: "sent" })
    await expect(runEnrichDispatchTick(deps, { nowMs: NOW_MS })).rejects.toThrow("ledger down")
    expect(dispatched).toHaveLength(1)
    expect(records.at(-1)).toEqual({ status: "dispatching" })
  })

  it("dispatch 호출이 던져도 다시 시도하지 않는다", async () => {
    const { deps, dispatched, records } = makeDeps({ dispatch: new Error("process interrupted") })
    await expect(runEnrichDispatchTick(deps, { nowMs: NOW_MS })).rejects.toThrow("process interrupted")
    expect(dispatched).toHaveLength(1)
    expect(records.at(-1)).toEqual({ status: "dispatching" })
  })
})

describe("GitHub 호출", () => {
  const TOKEN = "github-token-value"
  type FetchCall = { readonly url: string; readonly init: RequestInit }
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
    const { calls, fetchImpl } = recordingFetch((url) => okCount(url.includes("status=in_progress") ? 1 : url.includes("status=queued") ? 2 : 0))
    expect(await countActiveEnrichRuns(TOKEN, fetchImpl)).toBe(3)
    expect(calls.map(({ url }) => new URL(url).searchParams.get("status"))).toEqual(["queued", "in_progress", "requested", "waiting", "pending"])
    for (const { url, init } of calls) {
      expect(url.startsWith("https://api.github.com/repos/juchan3336-pixel/FlowerCRM-AI/actions/workflows/enrich.yml/runs?")).toBe(true)
      expect(init.method).toBe("GET")
      expect(init.signal).toBeInstanceOf(AbortSignal)
      // branch·event로 좁히지 않는다 — 누가 어떤 ref로 시작했든 run은 run이다.
      expect(url).not.toMatch(/branch=|event=/)
    }
  })

  it("하나라도 확인하지 못하면 0을 돌려주지 않고 던진다", async () => {
    await expect(countActiveEnrichRuns(TOKEN, respond("", 500))).rejects.toThrow()
    await expect(countActiveEnrichRuns(TOKEN, respond("{}", 200))).rejects.toThrow()
    await expect(countActiveEnrichRuns(TOKEN, respond(JSON.stringify({ total_count: "3" }), 200))).rejects.toThrow()
    await expect(countActiveEnrichRuns(TOKEN, () => Promise.reject(new Error("network")))).rejects.toThrow()
  })

  it("dispatch는 고정된 저장소·워크플로·ref로만 간다", async () => {
    const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 204 }))
    const result = await dispatchEnrichWorkflow(TOKEN, { limit: "50", dry_run: "true", from_start: "false", dispatch_id: "id" }, fetchImpl)
    expect(result).toEqual({ kind: "accepted", httpStatus: 204, runId: null })
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call?.url).toBe("https://api.github.com/repos/juchan3336-pixel/FlowerCRM-AI/actions/workflows/enrich.yml/dispatches")
    expect(call?.init.method).toBe("POST")
    expect(call?.init.signal).toBeInstanceOf(AbortSignal)
    const sentBody = call?.init.body
    expect(typeof sentBody).toBe("string")
    expect(JSON.parse(typeof sentBody === "string" ? sentBody : "null")).toEqual({
      ref: "main",
      inputs: { limit: "50", dry_run: "true", from_start: "false", dispatch_id: "id" },
    })
  })

  it("2xx 본문에 run id가 있으면 읽고, 없거나 깨져 있어도 접수로 본다", async () => {
    const inputs = { dry_run: "true" }
    expect(await dispatchEnrichWorkflow(TOKEN, inputs, respond(JSON.stringify({ workflow_run_id: 4242 }), 200))).toEqual({
      kind: "accepted",
      httpStatus: 200,
      runId: 4242,
    })
    expect(await dispatchEnrichWorkflow(TOKEN, inputs, respond("not json", 200))).toEqual({ kind: "accepted", httpStatus: 200, runId: null })
    expect(await dispatchEnrichWorkflow(TOKEN, inputs, respond(JSON.stringify({ workflow_run_id: "4242" }), 201))).toEqual({
      kind: "accepted",
      httpStatus: 201,
      runId: null,
    })
  })

  it("4xx는 rejected, 5xx와 연결 실패는 unknown — 어느 쪽도 다시 보내지 않는다", async () => {
    for (const status of [401, 403, 404, 422, 429]) {
      const fetchImpl = vi.fn(respond(JSON.stringify({ message: "secret detail" }), status))
      expect(await dispatchEnrichWorkflow(TOKEN, {}, fetchImpl)).toEqual({ kind: "rejected", httpStatus: status })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
    for (const status of [500, 502, 503]) {
      expect(await dispatchEnrichWorkflow(TOKEN, {}, respond("", status))).toEqual({ kind: "unknown", httpStatus: status })
    }
    const failing = vi.fn(() => Promise.reject(new Error("timeout")))
    expect(await dispatchEnrichWorkflow(TOKEN, {}, failing)).toEqual({ kind: "unknown", httpStatus: null })
    expect(failing).toHaveBeenCalledTimes(1)
  })

  it("결과에 토큰이나 GitHub 오류 원문이 실리지 않는다", async () => {
    const result = await dispatchEnrichWorkflow(TOKEN, {}, respond(JSON.stringify({ message: `bad credentials ${TOKEN}` }), 401))
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(JSON.stringify(result)).not.toContain("bad credentials")
  })
})
