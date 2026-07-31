import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ALLOWED_EXEC_BASE_URL } from "@/lib/batch/approval-execution-policy"

// route는 환경 게이트·bypass·토큰 인증·응답 매핑·self-chain 예약을 담당한다.
// 서비스는 대역으로 바꿔 라우트의 게이트·인증 분기만 검증한다 (서비스 오케스트레이션은 별도 테스트).
vi.mock("server-only", () => ({}))

const executeActivate = vi.fn<(input: unknown) => Promise<unknown>>()
const executeTick = vi.fn<(input: unknown) => Promise<unknown>>()
vi.mock("@/lib/batch/approval-execution-service", () => ({
  executeActivate: (input: unknown) => executeActivate(input),
  executeTick: (input: unknown) => executeTick(input),
}))

// after()가 예약한 콜백을 즉시 실행하지 않고 수집만 한다 (self-chain 예약 여부 검증용).
const afterCallbacks: (() => unknown)[] = []
vi.mock("next/server", () => ({ after: (cb: () => unknown) => afterCallbacks.push(cb) }))

// self-chain fetch 실패 시 정체 표식(F2) 검증용 — route가 catch에서 dynamic import로 호출한다.
const recordChainDispatchError = vi.fn<(approvalId: string, code: string) => Promise<unknown>>(() => Promise.resolve(null))
vi.mock("@/lib/batch/supabase-approval-repository", () => ({
  createSupabaseApprovalRepository: () => ({ recordChainDispatchError }),
}))

let fetchMock: ReturnType<typeof vi.fn>
const CHAIN_SECRET = "chain-secret-0123456789abcdef0123456789"
const BYPASS = "bypass-secret-value"
const BASE_URL = ALLOWED_EXEC_BASE_URL
const APPROVAL_ID = "11111111-1111-1111-1111-111111111111"

function setValidEnv(): void {
  process.env["VERCEL_ENV"] = "preview"
  process.env["AI_PROVIDER"] = "openai"
  process.env["OPENAI_API_KEY"] = "sk-test"
  process.env["OPENAI_MODEL"] = "gpt-4.1-mini"
  process.env["BATCH_CHAIN_SECRET"] = CHAIN_SECRET
  process.env["PREVIEW_EXEC_BASE_URL"] = BASE_URL
  process.env["VERCEL_AUTOMATION_BYPASS_SECRET"] = BYPASS
}

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://preview.vercel.app/api/batch/execute", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
}

async function callPost(request: Request): Promise<{ status: number; body: Record<string, unknown> }> {
  const { POST } = await import("@/app/api/batch/execute/route")
  const res = await POST(request)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const ENV_KEYS = ["VERCEL_ENV", "AI_PROVIDER", "OPENAI_API_KEY", "OPENAI_MODEL", "BATCH_CHAIN_SECRET", "PREVIEW_EXEC_BASE_URL", "VERCEL_AUTOMATION_BYPASS_SECRET"]

beforeEach(() => {
  executeActivate.mockReset()
  executeTick.mockReset()
  recordChainDispatchError.mockClear()
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

describe("환경 게이트", () => {
  it("hard-rejects production with 409 and never calls the service", async () => {
    process.env["VERCEL_ENV"] = "production"
    const res = await callPost(req({ mode: "activate" }, { "x-vercel-protection-bypass": BYPASS, authorization: "Bearer abc" }))
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ ok: false, reason: "production-blocked" })
    expect(executeActivate).not.toHaveBeenCalled()
  })

  it("rejects fake provider with 409", async () => {
    process.env["AI_PROVIDER"] = "fake"
    const res = await callPost(req({ mode: "activate" }, { "x-vercel-protection-bypass": BYPASS, authorization: "Bearer abc" }))
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ reason: "provider-not-openai" })
  })
})

describe("bypass·토큰 인증", () => {
  it("rejects a wrong bypass header with 401", async () => {
    const res = await callPost(req({ mode: "activate" }, { "x-vercel-protection-bypass": "nope", authorization: "Bearer abc" }))
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ reason: "bypass" })
    expect(executeActivate).not.toHaveBeenCalled()
  })

  it("rejects a missing bearer token with 401", async () => {
    const res = await callPost(req({ mode: "activate" }, { "x-vercel-protection-bypass": BYPASS }))
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ reason: "missing-token" })
  })
})

describe("activate 접수 전용", () => {
  it("passes the activation token to executeActivate and returns the mapped status", async () => {
    executeActivate.mockResolvedValue({ outcome: { kind: "accepted", approvalStatus: "running" } })
    const res = await callPost(req({ mode: "activate" }, { "x-vercel-protection-bypass": BYPASS, authorization: "Bearer activation-token" }))

    expect(res.status).toBe(202)
    expect(res.body).toMatchObject({ ok: true, accepted: true, done: false, approvalStatus: "running" })
    expect(executeActivate).toHaveBeenCalledTimes(1)
    const passed = executeActivate.mock.calls[0]?.[0] as { activationToken: string }
    expect(passed.activationToken).toBe("activation-token")
  })

  it("maps expired to 410 and failed to 500 without leaking internals", async () => {
    executeActivate.mockResolvedValue({ outcome: { kind: "expired" } })
    const expired = await callPost(req({ mode: "activate" }, { "x-vercel-protection-bypass": BYPASS, authorization: "Bearer t" }))
    expect(expired.status).toBe(410)
    expect(expired.body).toMatchObject({ reason: "approval-expired" })

    executeActivate.mockRejectedValue(new Error("boom"))
    const failed = await callPost(req({ mode: "activate" }, { "x-vercel-protection-bypass": BYPASS, authorization: "Bearer t" }))
    expect(failed.status).toBe(500)
    expect(failed.body).toEqual({ ok: false, errorCode: "internal" })
  })

  it("rejects a malformed body with 409", async () => {
    const res = await callPost(req({ mode: "nope" }, { "x-vercel-protection-bypass": BYPASS, authorization: "Bearer t" }))
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ reason: "invalid-body" })
    expect(executeActivate).not.toHaveBeenCalled()
  })

  // tick 모드는 self-chain과 함께 제거됐다 — 지연 도착한 예전 요청이 실행을 재개시키면 안 된다.
  it("rejects a leftover tick request without touching the service", async () => {
    const res = await callPost(
      req({ mode: "tick", approvalId: APPROVAL_ID, tick: 2 }, { "x-vercel-protection-bypass": BYPASS, authorization: "Bearer t" }),
    )
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ reason: "invalid-body" })
    expect(executeActivate).not.toHaveBeenCalled()
  })
})

// 이 endpoint가 존재하는 이유가 바뀌었다 — 접수만 하고 아무것도 발사하지 않는다.
// item 처리는 Cron이 부르는 /api/batch/pump가 1건씩 맡는다.
describe("자기 호출 없음", () => {
  it("activate가 성공해도 어떤 HTTP 요청도 보내지 않는다", async () => {
    executeActivate.mockResolvedValue({ outcome: { kind: "accepted", approvalStatus: "running" } })

    await callPost(req({ mode: "activate" }, { "x-vercel-protection-bypass": BYPASS, authorization: "Bearer t" }))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(afterCallbacks).toHaveLength(0)
  })

  it("activate가 실패해도 발사하지 않는다", async () => {
    executeActivate.mockResolvedValue({ outcome: { kind: "conflict", reason: "already-consumed" } })

    const res = await callPost(req({ mode: "activate" }, { "x-vercel-protection-bypass": BYPASS, authorization: "Bearer t" }))

    expect(res.status).toBe(409)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(afterCallbacks).toHaveLength(0)
  })
})
