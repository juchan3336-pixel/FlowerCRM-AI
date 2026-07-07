import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import LoginPage from "@/app/login/page"
import { buildAuthCallbackUrl, normalizeNextPath, requestMagicLink, requestPasswordLogin, type MagicLinkAuthClient, type PasswordLoginAuthClient } from "@/lib/auth/login"

const AUTH_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  ADMIN_EMAIL_ALLOWLIST: "admin@example.com",
} as const

describe("admin login", () => {
  it("renders password login as the primary form and keeps magic link as backup without service-role secrets", async () => {
    // Given: the login page in credential-free build mode.
    const page = await LoginPage({ searchParams: Promise.resolve({ setup: "missing" }) })

    // When: the page is rendered to static markup.
    const markup = renderToStaticMarkup(page)

    // Then: password login is the default path, magic link remains available, and secret names are absent.
    expect(markup).toContain("Admin password login")
    expect(markup).toContain("Password")
    expect(markup).toContain("Remember me")
    expect(markup).toContain("Sign in")
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
    const authClient: PasswordLoginAuthClient = {
      signInWithPassword(input) {
        signInRequests.push(input)
        return Promise.resolve({ error: null })
      },
    }

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
    const authClient: PasswordLoginAuthClient = {
      signInWithPassword() {
        return Promise.resolve({ error: null })
      },
    }

    // When: the password login request is handled.
    const result = await requestPasswordLogin({ formData, nextPath: "/admin/seo-pages", env: AUTH_ENV, authClient })

    // Then: remember-me intent is preserved and password login lands on the dashboard.
    expect(result).toEqual({ kind: "signed_in", email: "admin@example.com", nextPath: "/admin/dashboard", remember: true })
  })

  it("rejects password login for non-allowlisted email before provider calls", async () => {
    // Given: credentials for an email outside the admin allowlist.
    const formData = new FormData()
    formData.set("email", "viewer@example.com")
    formData.set("password", "correct-password")
    let providerCalled = false
    const authClient: PasswordLoginAuthClient = {
      signInWithPassword() {
        providerCalled = true
        return Promise.resolve({ error: null })
      },
    }

    // When: the password login request is handled.
    const result = await requestPasswordLogin({ formData, nextPath: "/admin/dashboard", env: AUTH_ENV, authClient })

    // Then: allowlist rejection happens before Supabase sign-in.
    expect(result).toEqual({ kind: "unauthorized_email" })
    expect(providerCalled).toBe(false)
  })

  it("reports provider errors from password login without exposing raw messages", async () => {
    // Given: valid admin credentials rejected by Supabase Auth.
    const formData = new FormData()
    formData.set("email", "admin@example.com")
    formData.set("password", "wrong-password")
    const authClient: PasswordLoginAuthClient = {
      signInWithPassword() {
        return Promise.resolve({ error: { message: "Invalid login credentials" } })
      },
    }

    // When: the password login request is handled.
    const result = await requestPasswordLogin({ formData, nextPath: "/outside", env: AUTH_ENV, authClient })

    // Then: the domain result is generic for the action redirect layer.
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
})
