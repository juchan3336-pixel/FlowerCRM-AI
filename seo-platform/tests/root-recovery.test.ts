import { describe, expect, it } from "vitest"

import { buildRootRecoveryRedirect } from "@/app/page"

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
})
