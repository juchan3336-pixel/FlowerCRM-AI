import { describe, expect, it, vi } from "vitest"

import { ALLOWED_EXEC_BASE_URL } from "@/lib/batch/approval-execution-policy"
import {
  KICK_BYPASS_HEADER,
  classifyKickStatus,
  kickApprovalActivation,
  kickFailureMessage,
  resolveKickEnvironment,
} from "@/lib/batch/approval-kick"

const BYPASS = "bypass-secret-value"
const TOKEN = "activation-token-value"

describe("kick 환경 계약", () => {
  it("uses the pinned preview alias from code, not an env var", () => {
    // Given / When: bypass secret만 주어진다.
    const decision = resolveKickEnvironment({ VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS })

    // Then: 대상 URL은 exact-pin 상수와 동일하다 (오설정으로 다른 배포에 secret이 가지 않는다).
    expect(decision.ok).toBe(true)
    expect(decision.ok && decision.baseUrl).toBe(ALLOWED_EXEC_BASE_URL)
    expect(ALLOWED_EXEC_BASE_URL).toBe("https://flowercrm-seo-git-preview-latest-juchans-projects-ecbdf050.vercel.app")
  })

  it("blocks when the automation bypass secret is missing or blank", () => {
    expect(resolveKickEnvironment({})).toEqual({ ok: false, blockedBy: "bypass-secret-missing" })
    expect(resolveKickEnvironment({ VERCEL_AUTOMATION_BYPASS_SECRET: "   " })).toEqual({ ok: false, blockedBy: "bypass-secret-missing" })
  })
})

describe("응답 분류", () => {
  it("maps execute endpoint statuses to safe codes", () => {
    expect(classifyKickStatus(200)).toEqual({ kind: "started" })
    expect(classifyKickStatus(401)).toEqual({ kind: "failed", code: "unauthorized" })
    expect(classifyKickStatus(409)).toEqual({ kind: "failed", code: "conflict" })
    expect(classifyKickStatus(410)).toEqual({ kind: "failed", code: "expired" })
    expect(classifyKickStatus(500)).toEqual({ kind: "failed", code: "server-error" })
    expect(classifyKickStatus(418)).toEqual({ kind: "failed", code: "unexpected-status" })
  })

  it("gives Korean guidance that states AI generation did not start", () => {
    for (const code of ["unauthorized", "conflict", "expired", "server-error", "unreachable", "bypass-secret-missing", "unexpected-status"] as const) {
      const message = kickFailureMessage(code)
      expect(message).toContain("시작되지 않았습니다")
      // secret·token·내부 코드가 사용자 문구로 새지 않는다.
      expect(message).not.toContain(BYPASS)
      expect(message).not.toContain("Bearer")
    }
  })
})

describe("kick 요청", () => {
  it("posts activate to the pinned alias with bypass header and refuses redirects", async () => {
    // Given: 성공 응답을 돌려주는 fetch 대역.
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url, init: init ?? {} })
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    }) as unknown as typeof fetch

    // When: kick을 발사한다.
    const outcome = await kickApprovalActivation({ activationToken: TOKEN, bypassSecret: BYPASS, baseUrl: ALLOWED_EXEC_BASE_URL, fetchImpl })

    // Then: 고정 별칭 + activate + bypass 헤더 + redirect 거부로 나간다.
    expect(outcome).toEqual({ kind: "started" })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${ALLOWED_EXEC_BASE_URL}/api/batch/execute`)
    const init = calls[0]?.init as RequestInit & { headers: Record<string, string> }
    expect(init.method).toBe("POST")
    expect(init.redirect).toBe("error")
    expect(init.headers[KICK_BYPASS_HEADER]).toBe(BYPASS)
    expect(init.headers["authorization"]).toBe(`Bearer ${TOKEN}`)
    expect(init.body).toBe(JSON.stringify({ mode: "activate" }))
  })

  it("classifies 401/409/410/500 responses without leaking the response body", async () => {
    for (const [status, code] of [
      [401, "unauthorized"],
      [409, "conflict"],
      [410, "expired"],
      [500, "server-error"],
    ] as const) {
      const fetchImpl = vi.fn(() => Promise.resolve(new Response("internal detail with secret", { status }))) as unknown as typeof fetch
      const outcome = await kickApprovalActivation({ activationToken: TOKEN, bypassSecret: BYPASS, baseUrl: ALLOWED_EXEC_BASE_URL, fetchImpl })
      expect(outcome).toEqual({ kind: "failed", code })
      expect(JSON.stringify(outcome)).not.toContain("secret")
    }
  })

  it("treats network failure, timeout, and refused redirect as unreachable", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("redirect not allowed: stack trace"))) as unknown as typeof fetch
    const outcome = await kickApprovalActivation({ activationToken: TOKEN, bypassSecret: BYPASS, baseUrl: ALLOWED_EXEC_BASE_URL, fetchImpl })
    expect(outcome).toEqual({ kind: "failed", code: "unreachable" })
    expect(JSON.stringify(outcome)).not.toContain("stack trace")
  })
})
