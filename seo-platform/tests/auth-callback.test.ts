import { describe, expect, it } from "vitest"

import { handleAuthCallback, normalizeAuthCallbackNextPath, type AuthCodeExchangeClient } from "@/lib/auth/callback"

describe("auth callback", () => {
  it("skips code exchange when public Supabase auth env is missing", async () => {
    // Given: a callback URL with a code but no public Supabase auth env.
    const requestUrl = new URL("https://seo.example.test/auth/callback?code=abc&next=/admin")
    const authClient: AuthCodeExchangeClient = {
      exchangeCodeForSession() {
        return Promise.resolve({ error: null })
      },
    }

    // When: the callback is handled.
    const result = await handleAuthCallback({ requestUrl, env: {}, authClient })

    // Then: missing setup is reported without requiring a provider exchange.
    expect(result).toEqual({ kind: "configured_missing", redirectPath: "/login?setup=missing" })
  })

  it("rejects callbacks without an auth code", async () => {
    // Given: a callback URL without the Supabase code parameter.
    const requestUrl = new URL("https://seo.example.test/auth/callback?next=/admin")
    const authClient: AuthCodeExchangeClient = {
      exchangeCodeForSession() {
        return Promise.resolve({ error: null })
      },
    }

    // When: the callback is handled with auth env configured.
    const result = await handleAuthCallback({
      requestUrl,
      env: { NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key" },
      authClient,
    })

    // Then: the user is sent back to login with a missing-code error.
    expect(result).toEqual({ kind: "missing_code", redirectPath: "/login?error=missing-code" })
  })

  it("exchanges a code and redirects to a safe admin next path", async () => {
    // Given: a callback URL with a code and a nested admin destination.
    const requestUrl = new URL("https://seo.example.test/auth/callback?code=abc&next=/admin/settings")
    const exchangedCodes: string[] = []
    const authClient: AuthCodeExchangeClient = {
      exchangeCodeForSession(code) {
        exchangedCodes.push(code)
        return Promise.resolve({ error: null })
      },
    }

    // When: the callback is handled.
    const result = await handleAuthCallback({
      requestUrl,
      env: { NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key" },
      authClient,
    })

    // Then: the code is exchanged and redirect remains inside admin.
    expect(result).toEqual({ kind: "exchanged", redirectPath: "/admin/settings" })
    expect(exchangedCodes).toEqual(["abc"])
  })

  it("verifies recovery token hashes and redirects to reset password", async () => {
    // Given: Supabase sends the documented password recovery callback URL.
    const requestUrl = new URL("https://seo.example.test/auth/callback?token_hash=hashed-token&type=recovery&next=/reset-password")
    const verifiedOtps: { readonly tokenHash: string; readonly type: string }[] = []
    const authClient: AuthCodeExchangeClient = {
      exchangeCodeForSession() {
        return Promise.resolve({ error: null })
      },
      verifyOtp(params) {
        verifiedOtps.push({ tokenHash: params.token_hash, type: params.type })
        return Promise.resolve({ error: null })
      },
    }

    // When: the callback is handled.
    const result = await handleAuthCallback({
      requestUrl,
      env: { NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key" },
      authClient,
    })

    // Then: the recovery token is verified and the user continues to reset-password.
    expect(result).toEqual({ kind: "recovered", redirectPath: "/reset-password" })
    expect(verifiedOtps).toEqual([{ tokenHash: "hashed-token", type: "recovery" }])
  })

  it("exchanges recovery codes and redirects to reset password", async () => {
    // Given: Supabase sends a PKCE recovery code through the auth callback.
    const requestUrl = new URL("https://seo.example.test/auth/callback?code=recovery-code&type=recovery&next=/reset-password")
    const exchangedCodes: string[] = []
    const authClient: AuthCodeExchangeClient = {
      exchangeCodeForSession(code) {
        exchangedCodes.push(code)
        return Promise.resolve({ error: null })
      },
    }

    // When: the callback is handled.
    const result = await handleAuthCallback({
      requestUrl,
      env: { NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key" },
      authClient,
    })

    // Then: the recovery code is exchanged and normal admin redirects are bypassed.
    expect(result).toEqual({ kind: "recovered", redirectPath: "/reset-password" })
    expect(exchangedCodes).toEqual(["recovery-code"])
  })

  it("exchanges a recovery code arriving with only the reset-password next path", async () => {
    // Given: the reset email redirectTo lands on the callback without a type parameter.
    const requestUrl = new URL("https://seo.example.test/auth/callback?code=recovery-code&next=/reset-password")
    const exchangedCodes: string[] = []
    const authClient: AuthCodeExchangeClient = {
      exchangeCodeForSession(code) {
        exchangedCodes.push(code)
        return Promise.resolve({ error: null })
      },
    }

    // When: the callback is handled.
    const result = await handleAuthCallback({
      requestUrl,
      env: { NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key" },
      authClient,
    })

    // Then: the session is created and the user continues to reset-password.
    expect(result).toEqual({ kind: "recovered", redirectPath: "/reset-password" })
    expect(exchangedCodes).toEqual(["recovery-code"])
  })

  it("returns provider failures without exposing provider internals in redirect path", async () => {
    // Given: a provider exchange failure.
    const requestUrl = new URL("https://seo.example.test/auth/callback?code=abc&next=/admin")
    const authClient: AuthCodeExchangeClient = {
      exchangeCodeForSession() {
        return Promise.resolve({ error: { message: "provider failure detail" } })
      },
    }

    // When: the callback is handled.
    const result = await handleAuthCallback({
      requestUrl,
      env: { NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key" },
      authClient,
    })

    // Then: the UI redirect is generic while the typed result retains detail for server logs later.
    expect(result).toEqual({ kind: "exchange_failed", redirectPath: "/login?error=callback", message: "provider failure detail" })
  })

  it("normalizes callback destinations to admin routes and the reset-password page only", () => {
    // Given / When / Then: only admin destinations and the exact reset-password path survive normalization.
    expect(normalizeAuthCallbackNextPath("/admin/sitemap")).toBe("/admin/sitemap")
    expect(normalizeAuthCallbackNextPath("/reset-password")).toBe("/reset-password")
    expect(normalizeAuthCallbackNextPath("/reset-password/evil")).toBe("/admin")
    expect(normalizeAuthCallbackNextPath("/administrator")).toBe("/admin")
    expect(normalizeAuthCallbackNextPath("/products/product-funeral-flower")).toBe("/admin")
    expect(normalizeAuthCallbackNextPath("https://evil.example.com/reset-password")).toBe("/admin")
    expect(normalizeAuthCallbackNextPath(null)).toBe("/admin")
  })
})
