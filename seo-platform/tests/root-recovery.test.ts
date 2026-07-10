import { describe, expect, it } from "vitest"

import { buildRootCodeRecoveryRedirect, buildRootRecoveryRedirect } from "@/app/page"

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
