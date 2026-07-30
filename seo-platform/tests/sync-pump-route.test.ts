// pump endpoint 계약 — 인증·접수 즉시 202·배치 1회·자기 호출 0회.
//
// 이전 self-chain 구조는 Vercel이 같은 함수의 재귀 호출을 4회 초과에서 508로 차단해
// 재개마다 배치 4개에서 멈췄다 (2026-07-30 실측: chain-dispatch-http-508).
// 이 파일의 핵심은 "pump가 다음 pump를 부르지 않는다"를 고정하는 것이다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const claimPumpLease = vi.fn<(deps: unknown, input: unknown) => Promise<unknown>>()
const runLeasedBatch = vi.fn<(deps: unknown, input: unknown) => Promise<unknown>>()
vi.mock("@/lib/sync/job-service", () => ({
  claimPumpLease: (deps: unknown, input: unknown) => claimPumpLease(deps, input),
  runLeasedBatch: (deps: unknown, input: unknown) => runLeasedBatch(deps, input),
}))

vi.mock("@/lib/sync/job-dependencies", () => ({ createLiveSyncJobDependencies: () => ({ live: false }) }))

// after()가 예약한 콜백을 모아 두고 원하는 시점에 실행한다 (응답 시점과 배치 시점을 분리 검증).
const afterCallbacks: (() => unknown)[] = []
vi.mock("next/server", () => ({ after: (cb: () => unknown) => afterCallbacks.push(cb) }))

const markPumpBatchCrashed = vi.fn<(input: unknown) => Promise<void>>(() => Promise.resolve())
vi.mock("@/lib/sync/pump-recovery", () => ({ markPumpBatchCrashed: (input: unknown) => markPumpBatchCrashed(input) }))

const JOB_ID = "80f3b9ca-fc8a-426c-9e7b-ced948e0967f"
const SECRET = "pump-secret-value"
const LEASE_HASH = "a".repeat(64)

const ENV_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_SPREADSHEET_ID",
  "SYNC_PUMP_SECRET",
]

function setValidEnv(): void {
  process.env["NEXT_PUBLIC_SUPABASE_URL"] = "https://project.supabase.co"
  process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] = "anon"
  process.env["SUPABASE_SERVICE_ROLE_KEY"] = "service"
  process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] = "{}"
  process.env["GOOGLE_SPREADSHEET_ID"] = "sheet"
  process.env["SYNC_PUMP_SECRET"] = SECRET
}

function req(headers: Record<string, string> = { "x-sync-pump-secret": SECRET }): Request {
  return new Request("https://flowercrm-seo.vercel.app/api/sync/pump", { method: "POST", headers })
}

async function callPost(request: Request): Promise<{ status: number; body: Record<string, unknown> }> {
  const { POST } = await import("@/app/api/sync/pump/route")
  const res = await POST(request)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

function claimed(): void {
  claimPumpLease.mockResolvedValue({ kind: "claimed", job: { id: JOB_ID }, leaseTokenHash: LEASE_HASH })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  claimPumpLease.mockReset()
  runLeasedBatch.mockReset()
  markPumpBatchCrashed.mockClear()
  afterCallbacks.length = 0
  setValidEnv()
  // 자기 호출이 0회임을 증명하려면 fetch 자체를 감시해야 한다.
  fetchMock = vi.fn(() => Promise.resolve(new Response("", { status: 200 })))
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const key of ENV_KEYS) {
    Reflect.deleteProperty(process.env, key)
  }
})

describe("인증", () => {
  it("시크릿이 없으면 401이고 claim조차 하지 않는다", async () => {
    const res = await callPost(req({}))
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ ok: false, reason: "pump-secret" })
    expect(claimPumpLease).not.toHaveBeenCalled()
  })

  it("시크릿이 틀리면 401이다", async () => {
    const res = await callPost(req({ "x-sync-pump-secret": "wrong" }))
    expect(res.status).toBe(401)
    expect(claimPumpLease).not.toHaveBeenCalled()
  })

  it("Authorization Bearer로도 통과한다", async () => {
    claimed()
    runLeasedBatch.mockResolvedValue({ outcome: { kind: "processed" } })
    const res = await callPost(req({ authorization: `Bearer ${SECRET}` }))
    expect(res.status).toBe(202)
  })

  it("응답 본문에 시크릿·해시가 담기지 않는다", async () => {
    claimed()
    runLeasedBatch.mockResolvedValue({ outcome: { kind: "processed" } })
    const res = await callPost(req())
    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain(SECRET)
    expect(serialized).not.toContain(LEASE_HASH)
    expect(serialized).not.toContain(JOB_ID)
  })

  it("환경변수가 없으면 409로 막고 claim하지 않는다", async () => {
    Reflect.deleteProperty(process.env, "SYNC_PUMP_SECRET")
    const res = await callPost(req())
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ reason: "pump-secret-missing" })
    expect(claimPumpLease).not.toHaveBeenCalled()
  })

  it("Google 자격이 없으면 409다", async () => {
    Reflect.deleteProperty(process.env, "GOOGLE_SPREADSHEET_ID")
    const res = await callPost(req())
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ reason: "google-env-missing" })
  })
})

describe("접수와 배치 분리", () => {
  it("처리 대상이 없으면 200 noop이고 배치를 예약하지 않는다", async () => {
    claimPumpLease.mockResolvedValue({ kind: "idle" })

    const res = await callPost(req())

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, noop: true, reason: "idle" })
    expect(afterCallbacks).toHaveLength(0)
    expect(runLeasedBatch).not.toHaveBeenCalled()
  })

  it("배치가 끝나지 않았는데도 202로 먼저 응답한다", async () => {
    claimed()
    let release: (() => void) | undefined
    runLeasedBatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve({ outcome: { kind: "processed" } })
          }
        }),
    )

    const res = await callPost(req())

    expect(res.status).toBe(202)
    expect(res.body).toEqual({ ok: true, accepted: true })
    expect(runLeasedBatch).not.toHaveBeenCalled()
    expect(afterCallbacks).toHaveLength(1)

    const pending = afterCallbacks[0]?.()
    expect(runLeasedBatch).toHaveBeenCalledTimes(1)
    release?.()
    await pending
  })

  it("after() 1회 실행에 배치도 정확히 1회만 돈다", async () => {
    claimed()
    runLeasedBatch.mockResolvedValue({ outcome: { kind: "processed" } })

    await callPost(req())
    await afterCallbacks[0]?.()

    expect(claimPumpLease).toHaveBeenCalledTimes(1)
    expect(runLeasedBatch).toHaveBeenCalledTimes(1)
    const passed = runLeasedBatch.mock.calls[0]?.[1] as { job: { id: string }; leaseTokenHash: string }
    expect(passed.job.id).toBe(JOB_ID)
    expect(passed.leaseTokenHash).toBe(LEASE_HASH)
  })

  it("claim이 터지면 500이고 배치를 예약하지 않는다", async () => {
    claimPumpLease.mockRejectedValue(new Error("db down"))
    const res = await callPost(req())
    expect(res.status).toBe(500)
    expect(res.body).toMatchObject({ ok: false, errorCode: "internal" })
    expect(afterCallbacks).toHaveLength(0)
  })
})

// 이 구조의 존재 이유 — 재귀 호출이 0이어야 508이 다시 발생하지 않는다.
describe("자기 호출 없음", () => {
  it("배치를 끝낸 뒤에도 어떤 HTTP 요청도 보내지 않는다", async () => {
    claimed()
    runLeasedBatch.mockResolvedValue({ outcome: { kind: "processed" } })

    await callPost(req())
    await afterCallbacks[0]?.()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("잔여가 남아 있어도 다음 실행을 스스로 발사하지 않는다", async () => {
    claimed()
    runLeasedBatch.mockResolvedValue({ outcome: { kind: "processed", remaining: 5_100 } })

    await callPost(req())
    await afterCallbacks[0]?.()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(afterCallbacks).toHaveLength(1)
  })

  it("완료된 뒤에도 발사하지 않는다", async () => {
    claimed()
    runLeasedBatch.mockResolvedValue({ outcome: { kind: "completed" } })

    await callPost(req())
    await afterCallbacks[0]?.()

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("배치 실행 실패", () => {
  it("배치가 터지면 lease 보유자 조건으로 표식만 남기고 발사하지 않는다", async () => {
    claimed()
    runLeasedBatch.mockRejectedValue(new Error("boom"))

    await callPost(req())
    await afterCallbacks[0]?.()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(markPumpBatchCrashed).toHaveBeenCalledWith({ jobId: JOB_ID, leaseTokenHash: LEASE_HASH })
  })

  it("표식 기록마저 실패해도 after() 콜백은 던지지 않는다", async () => {
    claimed()
    runLeasedBatch.mockRejectedValue(new Error("boom"))
    markPumpBatchCrashed.mockRejectedValue(new Error("db down"))

    await callPost(req())
    await expect(afterCallbacks[0]?.()).resolves.toBeUndefined()
  })
})
