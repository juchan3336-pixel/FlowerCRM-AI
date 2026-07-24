import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { deriveChainTickToken, mintActivationToken } from "@/lib/batch/approval-policy"

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

const CHAIN_SECRET = "chain-secret-0123456789abcdef0123456789"
const BYPASS = "bypass-secret-value"
const BASE_URL = "https://flowercrm-seo-git-preview-latest-x.vercel.app"
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
  afterCallbacks.length = 0
  setValidEnv()
})
afterEach(() => {
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
    const res = await callPost(req({ mode: "activate" }, { "x-vercel-protection-bypass": "wrong", authorization: "Bearer abc" }))
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ reason: "bypass" })
    expect(executeActivate).not.toHaveBeenCalled()
  })

  it("rejects a missing bearer token with 401", async () => {
    const res = await callPost(req({ mode: "activate" }, { "x-vercel-protection-bypass": BYPASS }))
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ reason: "missing-token" })
  })

  it("rejects a forged chain token with 401 before calling the tick service", async () => {
    const res = await callPost(req({ mode: "tick", approvalId: APPROVAL_ID, tick: 1 }, { "x-vercel-protection-bypass": BYPASS, authorization: "Bearer forged" }))
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ reason: "chain-token" })
    expect(executeTick).not.toHaveBeenCalled()
  })
})

describe("정상 dispatch + self-chain 예약", () => {
  it("passes the activation token to executeActivate and returns the mapped status", async () => {
    const minted = mintActivationToken()
    executeActivate.mockResolvedValue({ outcome: { kind: "processed", done: false, approvalStatus: "running" }, nextTick: { approvalId: APPROVAL_ID, tick: 1 } })
    const res = await callPost(req({ mode: "activate" }, { "x-vercel-protection-bypass": BYPASS, authorization: `Bearer ${minted.token}` }))

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, done: false })
    expect(executeActivate).toHaveBeenCalledWith(expect.objectContaining({ activationToken: minted.token }))
    // self-chain이 예약됐다
    expect(afterCallbacks).toHaveLength(1)
  })

  it("accepts a valid chain token and does not schedule when nextTick is null", async () => {
    const token = deriveChainTickToken(CHAIN_SECRET, APPROVAL_ID, 2)
    executeTick.mockResolvedValue({ outcome: { kind: "completed", approvalStatus: "completed" }, nextTick: null })
    const res = await callPost(req({ mode: "tick", approvalId: APPROVAL_ID, tick: 2 }, { "x-vercel-protection-bypass": BYPASS, authorization: `Bearer ${token}` }))

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, done: true, approvalStatus: "completed" })
    expect(executeTick).toHaveBeenCalledWith(expect.objectContaining({ approvalId: APPROVAL_ID, tick: 2 }))
    expect(afterCallbacks).toHaveLength(0)
  })

  it("maps expired to 410 and failed to 500 without leaking internals", async () => {
    executeActivate.mockResolvedValue({ outcome: { kind: "expired" }, nextTick: null })
    const minted = mintActivationToken()
    const expired = await callPost(req({ mode: "activate" }, { "x-vercel-protection-bypass": BYPASS, authorization: `Bearer ${minted.token}` }))
    expect(expired.status).toBe(410)

    executeActivate.mockRejectedValue(new Error("boom stack trace secret"))
    const failed = await callPost(req({ mode: "activate" }, { "x-vercel-protection-bypass": BYPASS, authorization: `Bearer ${minted.token}` }))
    expect(failed.status).toBe(500)
    expect(failed.body).toMatchObject({ ok: false, errorCode: "internal" })
    expect(JSON.stringify(failed.body)).not.toContain("boom")
  })

  it("rejects a malformed body with 409", async () => {
    const res = await callPost(req({ mode: "bogus" }, { "x-vercel-protection-bypass": BYPASS, authorization: "Bearer abc" }))
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ reason: "invalid-body" })
  })
})
