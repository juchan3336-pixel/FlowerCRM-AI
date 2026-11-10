import { describe, expect, it } from "vitest"

import { buildRootCodeRecoveryRedirect, buildRootRecoveryRedirect } from "@/app/page"
import { resolveRootRecoveryRedirect } from "@/lib/root-recovery"

describe("root recovery redirect", () => {
  it("redirects a recovery hash to reset-password", () => {
    // Given: Supabase lands a recovery hash on the root route.
    const hash = "#access_token=access&refresh_token=refresh&type=recovery"

    // When: the root redirect helper evaluates the URL hash.
    const redirectPath = buildRootRecoveryRedirect(hash)

    // Then: the user is forwarded to the reset-password route with the hash intact.
    expect(redirectPath).toBe("/reset-password#access_token=access&refresh_token=refresh&type=recovery")
  })

  it("ignores non-recovery hashes", () => {
    // Given: a normal root hash that is not password recovery.
    const hash = "#access_token=access&refresh_token=refresh&type=email"

    // When: the root redirect helper evaluates the URL hash.
    const redirectPath = buildRootRecoveryRedirect(hash)

    // Then: the root route stays put.
    expect(redirectPath).toBeNull()
  })

  it("forwards a legacy root recovery code to the auth callback with the reset destination", () => {
    // Given: an old reset email link lands on the root route with only a code.
    const search = "?code=recovery-code-123"

    // When: the root redirect helper evaluates the query string.
    const redirectPath = buildRootCodeRecoveryRedirect(search)

    // Then: the code is handed to the auth callback with the validated reset-password next path.
    expect(redirectPath).toBe("/auth/callback?code=recovery-code-123&next=/reset-password")
  })

  it("url-encodes recovery codes when forwarding to the auth callback", () => {
    // Given: a code containing URL-sensitive characters.
    const search = "?code=abc%2Fdef&other=1"

    // When: the root redirect helper evaluates the query string.
    const redirectPath = buildRootCodeRecoveryRedirect(search)

    // Then: the code survives round-tripping through the redirect URL.
    expect(redirectPath).toBe("/auth/callback?code=abc%2Fdef&next=/reset-password")
  })

  it("stays on the root route when no recovery code is present", () => {
    // Given: a plain root visit without auth parameters.
    const search = "?utm_source=mail"

    // When: the root redirect helper evaluates the query string.
    const redirectPath = buildRootCodeRecoveryRedirect(search)

    // Then: the foundation page renders normally.
    expect(redirectPath).toBeNull()
  })
})

// 공통 컴포넌트(RootRecoveryRedirect)가 쓰는 단일 판정 — 기존 검증 함수 조합 그대로, 표면과 무관하게 동작한다.
describe("resolveRootRecoveryRedirect (공통 판정)", () => {
  it("stays put on a plain visit — 일반 URL은 리다이렉트가 없다", () => {
    expect(resolveRootRecoveryRedirect("", "")).toBeNull()
    expect(resolveRootRecoveryRedirect("#section-2", "?utm_source=mail&ref=home")).toBeNull()
  })

  it("forwards a recovery hash to reset-password (내부 경로만)", () => {
    const redirectPath = resolveRootRecoveryRedirect("#access_token=a&refresh_token=r&type=recovery", "")
    expect(redirectPath).toBe("/reset-password#access_token=a&refresh_token=r&type=recovery")
    expect(redirectPath?.startsWith("/")).toBe(true)
  })

  it("forwards a legacy recovery code to the auth callback (내부 경로만)", () => {
    const redirectPath = resolveRootRecoveryRedirect("", "?code=recovery-code-123")
    expect(redirectPath).toBe("/auth/callback?code=recovery-code-123&next=/reset-password")
    expect(redirectPath?.startsWith("/")).toBe(true)
  })

  it("prefers the hash flow when both hash and code are present", () => {
    expect(resolveRootRecoveryRedirect("#access_token=a&refresh_token=r&type=recovery", "?code=x")).toBe(
      "/reset-password#access_token=a&refresh_token=r&type=recovery",
    )
  })

  it("rejects malformed input — 토큰 누락·빈 code·비recovery 타입·쓰레기 문자열", () => {
    expect(resolveRootRecoveryRedirect("#type=recovery", "")).toBeNull() // 토큰 없음
    expect(resolveRootRecoveryRedirect("#access_token=a&type=recovery", "")).toBeNull() // refresh_token 없음
    expect(resolveRootRecoveryRedirect("#access_token=a&refresh_token=r&type=email", "")).toBeNull() // recovery 아님
    expect(resolveRootRecoveryRedirect("", "?code=")).toBeNull() // 빈 code
    expect(resolveRootRecoveryRedirect("#%%%not-a-hash", "?&&&=broken")).toBeNull() // 형식 붕괴 입력
  })
})
