// chain endpoint의 응답 시점 계약 — "배치 완료를 기다리지 않고 접수 즉시 202".
//
// 2026-07-29 Production 장애의 재발 방지 테스트다. 당시 route는 배치(실측 40.9초)를 끝낸 뒤 응답했고,
// 발사한 쪽은 30초에 타임아웃해 정상 진행 중인 job을 interrupted로 닫았다.
// 여기서는 배치를 끝내지 않은 상태로 붙잡아 두고, 그 사이에 응답이 이미 나왔는지를 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { hashTickToken } from "@/lib/sync/job-policy"

vi.mock("server-only", () => ({}))

const acceptSyncTick = vi.fn<(deps: unknown, input: unknown) => Promise<unknown>>()
const runSyncTickBatch = vi.fn<(deps: unknown, input: unknown) => Promise<unknown>>()
vi.mock("@/lib/sync/job-service", () => ({
  acceptSyncTick: (deps: unknown, input: unknown) => acceptSyncTick(deps, input),
  runSyncTickBatch: (deps: unknown, input: unknown) => runSyncTickBatch(deps, input),
}))

vi.mock("@/lib/sync/job-dependencies", () => ({ createLiveSyncJobDependencies: () => ({ live: false }) }))

// after()가 예약한 콜백을 모아 두고 테스트가 원하는 시점에 실행한다 (응답 시점과 배치 시점을 분리 검증).
const afterCallbacks: (() => unknown)[] = []
vi.mock("next/server", () => ({ after: (cb: () => unknown) => afterCallbacks.push(cb) }))

// markUnconfirmedDispatch가 dynamic import로 잡는 repository.
const markInterrupted = vi.fn<(input: unknown) => Promise<void>>(() => Promise.resolve())
vi.mock("@/lib/sync/supabase-job-repository", () => ({
  createSupabaseSyncJobRepository: () => ({ markInterrupted }),
}))

const JOB_ID = "80f3b9ca-fc8a-426c-9e7b-ced948e0967f"
const NEXT_JOB_ID = "22222222-2222-4222-8222-222222222222"
const TOKEN = "tick-token-raw"
const NEXT_TOKEN = "next-tick-token-raw"

const ENV_KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_SPREADSHEET_ID"]

function setValidEnv(): void {
  process.env["NEXT_PUBLIC_SUPABASE_URL"] = "https://project.supabase.co"
  process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] = "anon"
  process.env["SUPABASE_SERVICE_ROLE_KEY"] = "service"
  process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = "{}"
  process.env["GOOGLE_SPREADSHEET_ID"] = "sheet"
}

function req(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }): Request {
  return new Request("https://flowercrm-seo.vercel.app/api/sync/chain", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

async function callPost(request: Request): Promise<{ status: number; body: Record<string, unknown> }> {
  const { POST } = await import("@/app/api/sync/chain/route")
  const res = await POST(request)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

// 접수 성공 대역 — claimed/minted는 route가 그대로 배치에 넘기기만 한다.
function acceptedOnce(): void {
  acceptSyncTick.mockResolvedValue({
    kind: "accepted",
    claimed: { id: JOB_ID },
    minted: { token: NEXT_TOKEN, tokenHash: hashTickToken(NEXT_TOKEN) },
  })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  acceptSyncTick.mockReset()
  runSyncTickBatch.mockReset()
  markInterrupted.mockClear()
  afterCallbacks.length = 0
  setValidEnv()
  fetchMock = vi.fn(() => Promise.resolve(new Response("", { status: 202 })))
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const key of ENV_KEYS) {
    Reflect.deleteProperty(process.env, key)
  }
})

describe("접수 즉시 응답", () => {
  it("배치가 끝나지 않았는데도 202로 먼저 응답한다", async () => {
    acceptedOnce()
    let releaseBatch: (() => void) | undefined
    runSyncTickBatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseBatch = () => {
            resolve({ outcome: { kind: "processed" }, nextTick: null })
          }
        }),
    )

    const res = await callPost(req({ mode: "tick", jobId: JOB_ID }))

    // 응답 시점: 배치는 아직 호출조차 되지 않았다 (after()는 예약만 됐다).
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ ok: true, accepted: true })
    expect(runSyncTickBatch).not.toHaveBeenCalled()
    expect(afterCallbacks).toHaveLength(1)

    const pending = afterCallbacks[0]?.()
    expect(runSyncTickBatch).toHaveBeenCalledTimes(1)
    releaseBatch?.()
    await pending
  })

  it("배치가 40초 걸려도 응답은 발사 타임아웃(30초)보다 훨씬 먼저 나간다", async () => {
    vi.useFakeTimers()
    try {
      acceptedOnce()
      runSyncTickBatch.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({ outcome: { kind: "processed" }, nextTick: null })
            }, 40_000)
          }),
      )

      const res = await callPost(req({ mode: "tick", jobId: JOB_ID }))
      expect(res.status).toBe(202)

      const pending = afterCallbacks[0]?.()
      await vi.advanceTimersByTimeAsync(40_000)
      await pending
      expect(runSyncTickBatch).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("after() 콜백 1회 실행에 배치도 1회만 돈다", async () => {
    acceptedOnce()
    runSyncTickBatch.mockResolvedValue({ outcome: { kind: "processed" }, nextTick: null })

    await callPost(req({ mode: "tick", jobId: JOB_ID }))
    await afterCallbacks[0]?.()

    expect(acceptSyncTick).toHaveBeenCalledTimes(1)
    expect(runSyncTickBatch).toHaveBeenCalledTimes(1)
  })
})

describe("다음 tick 발사", () => {
  it("배치가 끝나면 다음 tick을 운영 호스트로 발사한다", async () => {
    acceptedOnce()
    runSyncTickBatch.mockResolvedValue({ outcome: { kind: "processed" }, nextTick: { jobId: NEXT_JOB_ID, token: NEXT_TOKEN } })

    await callPost(req({ mode: "tick", jobId: JOB_ID }))
    expect(fetchMock).not.toHaveBeenCalled()

    await afterCallbacks[0]?.()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }]
    expect(url).toBe("https://flowercrm-seo.vercel.app/api/sync/chain")
    expect(init.headers["authorization"]).toBe(`Bearer ${NEXT_TOKEN}`)
    expect(init.body).toBe(JSON.stringify({ mode: "tick", jobId: NEXT_JOB_ID }))
    // 접수(2xx)됐으므로 정체 표식을 남기지 않는다.
    expect(markInterrupted).not.toHaveBeenCalled()
  })

  it("잔여가 없으면 발사하지 않는다", async () => {
    acceptedOnce()
    runSyncTickBatch.mockResolvedValue({ outcome: { kind: "completed" }, nextTick: null })

    await callPost(req({ mode: "tick", jobId: JOB_ID }))
    await afterCallbacks[0]?.()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(markInterrupted).not.toHaveBeenCalled()
  })

  it("다음 tick이 5xx면 재시도하고, 재시도가 접수되면 표식을 남기지 않는다", async () => {
    acceptedOnce()
    runSyncTickBatch.mockResolvedValue({ outcome: { kind: "processed" }, nextTick: { jobId: NEXT_JOB_ID, token: NEXT_TOKEN } })
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 })).mockResolvedValueOnce(new Response("", { status: 202 }))

    await callPost(req({ mode: "tick", jobId: JOB_ID }))
    await afterCallbacks[0]?.()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(markInterrupted).not.toHaveBeenCalled()
  })

  it("재시도가 모두 5xx면 상태 코드가 담긴 코드·요약으로 표식한다", async () => {
    acceptedOnce()
    runSyncTickBatch.mockResolvedValue({ outcome: { kind: "processed" }, nextTick: { jobId: NEXT_JOB_ID, token: NEXT_TOKEN } })
    fetchMock.mockResolvedValue(new Response("", { status: 500 }))

    await callPost(req({ mode: "tick", jobId: JOB_ID }))
    await afterCallbacks[0]?.()

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(markInterrupted).toHaveBeenCalledTimes(1)
    const recorded = markInterrupted.mock.calls[0]?.[0] as { errorCode: string; errorMessage: string; expectedTokenHash: string; jobId: string }
    expect(recorded.jobId).toBe(NEXT_JOB_ID)
    expect(recorded.errorCode).toBe("chain-dispatch-http-500")
    expect(recorded.errorMessage).toContain("HTTP 500")
    expect(recorded.expectedTokenHash).toBe(hashTickToken(NEXT_TOKEN))
    // 저장되는 문장에 토큰·본문·URL이 섞이지 않는다.
    expect(`${recorded.errorCode} ${recorded.errorMessage}`).not.toContain(NEXT_TOKEN)
    expect(`${recorded.errorCode} ${recorded.errorMessage}`).not.toMatch(/Bearer|https?:\/\//i)
  })

  it("401은 재시도 없이 즉시 표식한다", async () => {
    acceptedOnce()
    runSyncTickBatch.mockResolvedValue({ outcome: { kind: "processed" }, nextTick: { jobId: NEXT_JOB_ID, token: NEXT_TOKEN } })
    fetchMock.mockResolvedValue(new Response("", { status: 401 }))

    await callPost(req({ mode: "tick", jobId: JOB_ID }))
    await afterCallbacks[0]?.()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(markInterrupted).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "chain-dispatch-http-401" }))
  })

  it("첫 요청이 접수됐는데 응답만 유실돼도 표식은 조건부(토큰 해시)로만 나간다", async () => {
    acceptedOnce()
    runSyncTickBatch.mockResolvedValue({ outcome: { kind: "processed" }, nextTick: { jobId: NEXT_JOB_ID, token: NEXT_TOKEN } })
    fetchMock.mockRejectedValue(new Error("socket hang up"))

    await callPost(req({ mode: "tick", jobId: JOB_ID }))
    await afterCallbacks[0]?.()

    // 무조건 interrupted로 바꾸지 않는다 — expectedTokenHash가 함께 나가고,
    // 상대가 이미 접수해 토큰이 회전됐다면 DB 조건에서 0행이 되어 진행 중 job은 보존된다.
    expect(markInterrupted).toHaveBeenCalledWith(
      expect.objectContaining({ expectedTokenHash: hashTickToken(NEXT_TOKEN), errorCode: "chain-dispatch-network" }),
    )
  })
})

describe("접수 거부", () => {
  it("이미 회전된 토큰은 200 no-op이고 배치를 예약하지 않는다", async () => {
    acceptSyncTick.mockResolvedValue({ kind: "rejected", outcome: { kind: "noop", reason: "stale-tick-token" } })

    const res = await callPost(req({ mode: "tick", jobId: JOB_ID }))

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, noop: true, reason: "stale-tick-token" })
    expect(afterCallbacks).toHaveLength(0)
    expect(runSyncTickBatch).not.toHaveBeenCalled()
  })

  it("종료된 job에 도착한 지연 요청은 no-op이다", async () => {
    acceptSyncTick.mockResolvedValue({ kind: "rejected", outcome: { kind: "noop", reason: "terminal-interrupted" } })

    const res = await callPost(req({ mode: "tick", jobId: JOB_ID }))

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ noop: true, reason: "terminal-interrupted" })
    expect(runSyncTickBatch).not.toHaveBeenCalled()
  })

  it("모르는 job은 401이다", async () => {
    acceptSyncTick.mockResolvedValue({ kind: "rejected", outcome: { kind: "unauthorized", reason: "unknown-job" } })
    const res = await callPost(req({ mode: "tick", jobId: JOB_ID }))
    expect(res.status).toBe(401)
    expect(afterCallbacks).toHaveLength(0)
  })

  it("토큰 없는 요청은 접수 판정까지 가지 않는다", async () => {
    const res = await callPost(req({ mode: "tick", jobId: JOB_ID }, {}))
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ reason: "missing-token" })
    expect(acceptSyncTick).not.toHaveBeenCalled()
  })

  it("형식이 틀린 본문은 409이고 접수하지 않는다", async () => {
    const res = await callPost(req({ mode: "start" }))
    expect(res.status).toBe(409)
    expect(acceptSyncTick).not.toHaveBeenCalled()
  })

  it("환경변수가 없으면 409로 막고 접수하지 않는다", async () => {
    Reflect.deleteProperty(process.env, "GOOGLE_SPREADSHEET_ID")
    const res = await callPost(req({ mode: "tick", jobId: JOB_ID }))
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ reason: "google-env-missing" })
    expect(acceptSyncTick).not.toHaveBeenCalled()
  })

  it("접수 단계가 터지면 500이고 배치를 예약하지 않는다", async () => {
    acceptSyncTick.mockRejectedValue(new Error("db down"))
    const res = await callPost(req({ mode: "tick", jobId: JOB_ID }))
    expect(res.status).toBe(500)
    expect(res.body).toMatchObject({ ok: false, errorCode: "internal" })
    expect(afterCallbacks).toHaveLength(0)
  })
})

describe("배치 실행 실패", () => {
  it("배치가 예기치 않게 터지면 발사 실패와 구분되는 코드로 표식하고 발사하지 않는다", async () => {
    acceptedOnce()
    runSyncTickBatch.mockRejectedValue(new Error("boom"))

    await callPost(req({ mode: "tick", jobId: JOB_ID }))
    await afterCallbacks[0]?.()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(markInterrupted).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: JOB_ID, errorCode: "chain-tick-crashed", expectedTokenHash: hashTickToken(NEXT_TOKEN) }),
    )
  })

  it("표식 기록마저 실패해도 after() 콜백은 던지지 않는다", async () => {
    acceptedOnce()
    runSyncTickBatch.mockRejectedValue(new Error("boom"))
    markInterrupted.mockRejectedValue(new Error("db down"))

    await callPost(req({ mode: "tick", jobId: JOB_ID }))
    await expect(afterCallbacks[0]?.()).resolves.toBeUndefined()
  })
})
