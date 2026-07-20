import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

import LoginPage from "@/app/login/page"
import type { AdminAuthUser } from "@/lib/auth/admin-middleware"
import { buildAuthCallbackUrl, normalizeNextPath, requestMagicLink, requestPasswordLogin, shouldUseSecureCookies, type MagicLinkAuthClient, type PasswordLoginAuthClient } from "@/lib/auth/login"

const AUTH_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  ADMIN_EMAIL_ALLOWLIST: "admin@example.com",
} as const

describe("admin login", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders password login as the primary form and keeps magic link as backup without service-role secrets", async () => {
    // Given: the login page in credential-free build mode.
    const page = await LoginPage({ searchParams: Promise.resolve({ setup: "missing" }) })

    // When: the page is rendered to static markup.
    const markup = renderToStaticMarkup(page)

    // Then: password login is the default path, magic link remains available, and secret names are absent.
    expect(markup).toContain("Admin password login")
    expect(markup).toContain("Password")
    expect(markup).toContain("Remember me")
    expect(markup).toContain("로그인")
    expect(markup).toContain("Magic link backup")
    expect(markup).toContain("Send magic link")
    expect(markup).toContain("admin login is disabled in this environment")
    expect(markup).not.toContain("SUPABASE_SERVICE_ROLE_KEY")
    expect(markup).not.toContain("service_role")
  })

  it("signs in with password and redirects to the admin dashboard by default", async () => {
    // Given: an allowlisted admin email and password credentials.
    const formData = new FormData()
    formData.set("email", " admin@example.com ")
    formData.set("password", "correct-password")
    const signInRequests: { readonly email: string; readonly password: string }[] = []
    const authClient = createPasswordAuthClient({
      user: { id: "user_1", email: "admin@example.com", role: "authenticated" },
      onSignIn(input) {
        signInRequests.push(input)
      },
    })

    // When: the password login request is handled.
    const result = await requestPasswordLogin({ formData, nextPath: null, env: AUTH_ENV, authClient })

    // Then: Supabase receives trimmed credentials and the safe dashboard redirect is returned.
    expect(result).toEqual({ kind: "signed_in", email: "admin@example.com", nextPath: "/admin/dashboard", remember: false })
    expect(signInRequests).toEqual([{ email: "admin@example.com", password: "correct-password" }])
  })

  it("keeps remember-me intent while password login still lands on the dashboard", async () => {
    // Given: an allowlisted admin choosing persistent login.
    const formData = new FormData()
    formData.set("email", "admin@example.com")
    formData.set("password", "correct-password")
    formData.set("remember", "on")
    const authClient = createPasswordAuthClient({ user: { id: "user_1", email: "admin@example.com", role: "authenticated" } })

    // When: the password login request is handled.
    const result = await requestPasswordLogin({ formData, nextPath: "/admin/seo-pages", env: AUTH_ENV, authClient })

    // Then: remember-me intent is preserved and password login lands on the dashboard.
    expect(result).toEqual({ kind: "signed_in", email: "admin@example.com", nextPath: "/admin/dashboard", remember: true })
  })

  it("rejects password login for non-allowlisted email after the auth stages", async () => {
    // Given: credentials for an email outside the admin allowlist.
    const formData = new FormData()
    formData.set("email", "viewer@example.com")
    formData.set("password", "correct-password")
    let providerCalled = false
    let signOutCalled = false
    const authClient = createPasswordAuthClient({
      user: { id: "user_2", email: "viewer@example.com", role: "authenticated" },
      onSignIn() {
        providerCalled = true
      },
      onSignOut() {
        signOutCalled = true
      },
    })
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined)

    // When: the password login request is handled.
    const result = await requestPasswordLogin({ formData, nextPath: "/admin/dashboard", env: AUTH_ENV, authClient })

    // Then: sign-in, session, and user lookup happen before allowlist rejection.
    expect(result).toEqual({ kind: "unauthorized_email" })
    expect(providerCalled).toBe(true)
    expect(signOutCalled).toBe(true)
    expect(infoSpy.mock.calls.map((call): string => String(call[0]))).toEqual([
      "[admin-auth][password] Password OK",
      "[admin-auth][password] Session OK",
      "[admin-auth][password] User OK",
      "[admin-auth][password] Allowlist FAIL",
      "[admin-auth][password] Unauthorized",
    ])
  })

  it("classifies rejected credentials as invalid_credentials without exposing raw messages", async () => {
    // Given: wrong-password credentials rejected by Supabase Auth.
    const formData = new FormData()
    formData.set("email", "admin@example.com")
    formData.set("password", "wrong-password")
    const authClient = createPasswordAuthClient({ signInError: "Invalid login credentials", user: null })

    // When: the password login request is handled.
    const result = await requestPasswordLogin({ formData, nextPath: "/outside", env: AUTH_ENV, authClient })

    // Then: the failure is a user credential error, not a server error, and carries no raw message.
    expect(result).toEqual({ kind: "invalid_credentials" })
  })

  it("keeps non-credential auth failures as provider_error", async () => {
    // Given: Supabase rejecting for a non-credential reason (e.g. service outage).
    const formData = new FormData()
    formData.set("email", "admin@example.com")
    formData.set("password", "correct-password")
    const authClient = createPasswordAuthClient({ signInError: "Database connection lost", user: null })

    // When: the password login request is handled.
    const result = await requestPasswordLogin({ formData, nextPath: null, env: AUTH_ENV, authClient })

    // Then: the failure maps to the generic server error path.
    expect(result).toEqual({ kind: "provider_error" })
  })

  it("does not call Supabase when public auth environment is missing", async () => {
    // Given: a magic-link request without public Supabase auth env.
    const formData = new FormData()
    formData.set("email", "admin@example.com")
    const authClient: MagicLinkAuthClient = {
      signInWithOtp() {
        return Promise.resolve({ error: null })
      },
    }

    // When: the request is handled.
    const result = await requestMagicLink({ formData, origin: "https://seo.example.test", nextPath: "/admin", env: {}, authClient })

    // Then: missing configuration is reported before provider calls are required.
    expect(result).toEqual({ kind: "configured_missing" })
  })

  it("accepts a signed-in admin role even when the email allowlist misses", async () => {
    // Given: a valid password login where the user carries an admin role claim.
    const formData = new FormData()
    formData.set("email", "operator@example.com")
    formData.set("password", "correct-password")
    const authClient = createPasswordAuthClient({ user: { id: "user_admin", email: "operator@example.com", role: "admin" } })

    // When: the password login request is handled.
    const result = await requestPasswordLogin({ formData, nextPath: "/admin/dashboard", env: AUTH_ENV, authClient })

    // Then: the admin role can pass even without allowlist membership.
    expect(result).toEqual({ kind: "signed_in", email: "operator@example.com", nextPath: "/admin/dashboard", remember: false })
  })

  it("sends a magic link with a sanitized admin redirect path", async () => {
    // Given: a configured auth environment and a non-admin next path.
    const formData = new FormData()
    formData.set("email", " admin@example.com ")
    const sentRequests: { readonly email: string; readonly redirectTo: string }[] = []
    const authClient: MagicLinkAuthClient = {
      signInWithOtp(input) {
        sentRequests.push({ email: input.email, redirectTo: input.options.emailRedirectTo })
        return Promise.resolve({ error: null })
      },
    }

    // When: the request is handled.
    const result = await requestMagicLink({
      formData,
      origin: "https://seo.example.test",
      nextPath: "/products/product-funeral-flower",
      env: AUTH_ENV,
      authClient,
    })

    // Then: the provider receives a trimmed email and safe callback redirect URL.
    expect(result).toEqual({ kind: "sent", email: "admin@example.com", nextPath: "/admin" })
    expect(sentRequests).toEqual([{ email: "admin@example.com", redirectTo: "https://seo.example.test/auth/callback?next=%2Fadmin" }])
  })

  it("rejects emails outside the admin allowlist before provider calls", async () => {
    // Given: a configured auth environment and a non-admin email.
    const formData = new FormData()
    formData.set("email", "viewer@example.com")
    const authClient: MagicLinkAuthClient = {
      signInWithOtp() {
        return Promise.resolve({ error: null })
      },
    }

    // When: the request is handled.
    const result = await requestMagicLink({
      formData,
      origin: "https://seo.example.test",
      nextPath: "/admin",
      env: AUTH_ENV,
      authClient,
    })

    // Then: only allowlisted admins can request login links.
    expect(result).toEqual({ kind: "unauthorized_email" })
  })

  it("rejects invalid email input before provider calls", async () => {
    // Given: invalid email input and configured env.
    const formData = new FormData()
    formData.set("email", "not-an-email")
    const authClient: MagicLinkAuthClient = {
      signInWithOtp() {
        return Promise.resolve({ error: null })
      },
    }

    // When: the request is handled.
    const result = await requestMagicLink({
      formData,
      origin: "https://seo.example.test",
      nextPath: "/admin/settings",
      env: AUTH_ENV,
      authClient,
    })

    // Then: validation fails at the boundary.
    expect(result).toEqual({ kind: "invalid_email" })
  })

  it("normalizes next paths to admin routes only", () => {
    // Given / When / Then: only admin paths are accepted as post-login destinations.
    expect(normalizeNextPath("/admin/sync")).toBe("/admin/sync")
    expect(normalizeNextPath("/administrator")).toBe("/admin")
    expect(normalizeNextPath("/funeral/funeral-seoul-seocho")).toBe("/admin")
    expect(normalizeNextPath(null)).toBe("/admin")
    expect(buildAuthCallbackUrl("https://seo.example.test", "/admin/sync")).toBe("https://seo.example.test/auth/callback?next=%2Fadmin%2Fsync")
  })

  it("uses secure remember cookies only on HTTPS origins or production without origin", () => {
    // Given / When / Then: cookie security follows the request origin.
    expect(shouldUseSecureCookies("https://seo.example.test")).toBe(true)
    expect(shouldUseSecureCookies("http://localhost:3000")).toBe(false)
    expect(shouldUseSecureCookies(null)).toBe(false)
  })
})

function createPasswordAuthClient(input: Readonly<{
  user: AdminAuthUser | null
  signInError?: string | null
  onSignIn?: (input: Readonly<{ email: string; password: string }>) => void
  onSignOut?: () => void
}>): PasswordLoginAuthClient {
  return {
    signInWithPassword(signInInput) {
      input.onSignIn?.(signInInput)
      return Promise.resolve({
        data: { session: null },
        error: input.signInError === undefined || input.signInError === null ? null : { message: input.signInError },
      })
    },
    getSession() {
      return Promise.resolve({ data: { session: null }, error: null })
    },
    setSession() {
      return Promise.resolve({ error: null })
    },
    getUser() {
      return Promise.resolve({ data: { user: input.user }, error: null })
    },
    signOut() {
      input.onSignOut?.()
      return Promise.resolve({ error: null })
    },
  }
}
