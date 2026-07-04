import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import LoginPage from "@/app/login/page"
import { buildAuthCallbackUrl, normalizeNextPath, requestMagicLink, type MagicLinkAuthClient } from "@/lib/auth/login"

const AUTH_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  ADMIN_EMAIL_ALLOWLIST: "admin@example.com",
} as const

describe("admin login", () => {
  it("renders a magic-link login form without service-role secrets", async () => {
    // Given: the login page in credential-free build mode.
    const page = await LoginPage({ searchParams: Promise.resolve({ setup: "missing" }) })

    // When: the page is rendered to static markup.
    const markup = renderToStaticMarkup(page)

    // Then: the magic-link form is visible and secret names are absent.
    expect(markup).toContain("Request admin magic link")
    expect(markup).toContain("Admin email")
    expect(markup).toContain("Send magic link")
    expect(markup).toContain("Supabase public URL and anon key are not configured yet")
    expect(markup).not.toContain("SUPABASE_SERVICE_ROLE_KEY")
    expect(markup).not.toContain("service_role")
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
