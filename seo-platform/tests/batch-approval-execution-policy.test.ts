import { describe, expect, it } from "vitest"

import {
  extractBearerToken,
  httpStatusForOutcome,
  isAllowedExecBaseUrl,
  isTickWithinLimit,
  maxTicksFor,
  parseExecuteRequest,
  resolveExecuteEnvironment,
  safeResponseBody,
  verifyBypassHeader,
  type ExecuteEnvironment,
  type ExecuteOutcome,
} from "@/lib/batch/approval-execution-policy"

const VALID: ExecuteEnvironment = {
  VERCEL_ENV: "preview",
  AI_PROVIDER: "openai",
  OPENAI_API_KEY: "sk-test",
  OPENAI_MODEL: "gpt-4.1-mini",
  BATCH_CHAIN_SECRET: "chain-secret-0123456789abcdef0123456789",
  PREVIEW_EXEC_BASE_URL: "https://flowercrm-seo-git-preview-latest-x.vercel.app",
  VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret-value",
}

describe("실행 환경 게이트", () => {
  it("passes only when every gate is satisfied", () => {
    const decision = resolveExecuteEnvironment(VALID)
    expect(decision.ok).toBe(true)
    expect(decision.ok && decision.chainSecret).toBe(VALID.BATCH_CHAIN_SECRET)
    expect(decision.ok && decision.bypassSecret).toBe(VALID.VERCEL_AUTOMATION_BYPASS_SECRET)
  })

  it("hard-rejects production deployment", () => {
    expect(resolveExecuteEnvironment({ ...VALID, VERCEL_ENV: "production" })).toEqual({ ok: false, blockedBy: "production-blocked" })
  })

  it("rejects non-openai providers (fake·미설정)", () => {
    expect(resolveExecuteEnvironment({ ...VALID, AI_PROVIDER: "fake" })).toEqual({ ok: false, blockedBy: "provider-not-openai" })
    expect(resolveExecuteEnvironment({ ...VALID, AI_PROVIDER: undefined })).toEqual({ ok: false, blockedBy: "provider-not-openai" })
  })

  it("rejects short or missing chain secret", () => {
    expect(resolveExecuteEnvironment({ ...VALID, BATCH_CHAIN_SECRET: "short" })).toEqual({ ok: false, blockedBy: "chain-secret-missing" })
    expect(resolveExecuteEnvironment({ ...VALID, BATCH_CHAIN_SECRET: undefined })).toEqual({ ok: false, blockedBy: "chain-secret-missing" })
  })

  it("rejects missing or non-allowlisted base url", () => {
    expect(resolveExecuteEnvironment({ ...VALID, PREVIEW_EXEC_BASE_URL: undefined })).toEqual({ ok: false, blockedBy: "base-url-missing" })
    expect(resolveExecuteEnvironment({ ...VALID, PREVIEW_EXEC_BASE_URL: "https://evil.example.com" })).toEqual({ ok: false, blockedBy: "base-url-missing" })
  })

  it("rejects missing bypass secret", () => {
    expect(resolveExecuteEnvironment({ ...VALID, VERCEL_AUTOMATION_BYPASS_SECRET: undefined })).toEqual({ ok: false, blockedBy: "bypass-secret-missing" })
  })
})

describe("base url allowlist", () => {
  it("allows only vercel.app https and localhost", () => {
    expect(isAllowedExecBaseUrl("https://x.vercel.app")).toBe(true)
    expect(isAllowedExecBaseUrl("https://flowercrm-seo-git-preview-latest-x.vercel.app")).toBe(true)
    expect(isAllowedExecBaseUrl("http://localhost:3000")).toBe(true)
    expect(isAllowedExecBaseUrl("http://x.vercel.app")).toBe(false)
    expect(isAllowedExecBaseUrl("https://evil.com")).toBe(false)
    expect(isAllowedExecBaseUrl("https://vercel.app.evil.com")).toBe(false)
    expect(isAllowedExecBaseUrl("not-a-url")).toBe(false)
  })
})

describe("bypass 헤더·Bearer 추출", () => {
  it("compares the bypass header in constant time and rejects mismatch", () => {
    expect(verifyBypassHeader("bypass-secret-value", "bypass-secret-value")).toBe(true)
    expect(verifyBypassHeader("wrong", "bypass-secret-value")).toBe(false)
    expect(verifyBypassHeader(null, "bypass-secret-value")).toBe(false)
    expect(verifyBypassHeader("x", "")).toBe(false)
  })

  it("extracts the bearer token", () => {
    expect(extractBearerToken("Bearer abc.def")).toBe("abc.def")
    expect(extractBearerToken("Bearer   spaced  ")).toBe("spaced")
    expect(extractBearerToken("Basic abc")).toBeNull()
    expect(extractBearerToken(null)).toBeNull()
    expect(extractBearerToken("Bearer")).toBeNull()
  })
})

describe("tick 상한", () => {
  it("caps ticks at placeCount + 2", () => {
    expect(maxTicksFor(5)).toBe(7)
    expect(isTickWithinLimit(0, 5)).toBe(true)
    expect(isTickWithinLimit(7, 5)).toBe(true)
    expect(isTickWithinLimit(8, 5)).toBe(false)
    expect(isTickWithinLimit(-1, 5)).toBe(false)
    expect(isTickWithinLimit(1.5, 5)).toBe(false)
  })
})

describe("요청 파싱", () => {
  it("parses activate and tick, rejects malformed", () => {
    expect(parseExecuteRequest({ mode: "activate" })).toEqual({ mode: "activate" })
    expect(parseExecuteRequest({ mode: "tick", approvalId: "11111111-1111-1111-1111-111111111111", tick: 2 })).toEqual({
      mode: "tick",
      approvalId: "11111111-1111-1111-1111-111111111111",
      tick: 2,
    })
    expect(parseExecuteRequest({ mode: "tick", approvalId: "not-a-uuid", tick: 2 }).mode).toBe("invalid")
    expect(parseExecuteRequest({ mode: "tick", approvalId: "11111111-1111-1111-1111-111111111111", tick: -1 }).mode).toBe("invalid")
    expect(parseExecuteRequest({ mode: "tick", approvalId: "11111111-1111-1111-1111-111111111111", tick: 1.5 }).mode).toBe("invalid")
    expect(parseExecuteRequest({ mode: "bogus" }).mode).toBe("invalid")
    expect(parseExecuteRequest(null).mode).toBe("invalid")
    expect(parseExecuteRequest("string").mode).toBe("invalid")
    expect(parseExecuteRequest([]).mode).toBe("invalid")
  })
})

describe("응답 매핑 — secret·stack trace 미노출", () => {
  it("maps outcomes to the correct HTTP status", () => {
    const cases: [ExecuteOutcome, number][] = [
      [{ kind: "processed", done: false, approvalStatus: "running" }, 200],
      [{ kind: "completed", approvalStatus: "completed" }, 200],
      [{ kind: "noop", reason: "duplicate-tick" }, 200],
      [{ kind: "unauthorized", reason: "invalid-token" }, 401],
      [{ kind: "conflict", reason: "not-running" }, 409],
      [{ kind: "expired" }, 410],
      [{ kind: "failed", errorCode: "internal" }, 500],
    ]
    for (const [outcome, status] of cases) {
      expect(httpStatusForOutcome(outcome)).toBe(status)
    }
  })

  it("never leaks secrets, tokens, stack traces in the safe body", () => {
    const bodies = [
      safeResponseBody({ kind: "processed", done: false, approvalStatus: "running" }),
      safeResponseBody({ kind: "completed", approvalStatus: "completed" }),
      safeResponseBody({ kind: "noop", reason: "duplicate-tick" }),
      safeResponseBody({ kind: "unauthorized", reason: "chain-token" }),
      safeResponseBody({ kind: "conflict", reason: "production-blocked" }),
      safeResponseBody({ kind: "expired" }),
      safeResponseBody({ kind: "failed", errorCode: "internal" }),
    ]
    for (const body of bodies) {
      const serialized = JSON.stringify(body)
      expect(serialized).not.toMatch(/secret|token_hash|Bearer|Error:|at \w+/i)
    }
  })
})
