import { NextRequest } from "next/server"
import { describe, expect, it } from "vitest"

import { hasAdminAuthEnvironment, hasAnyAdminSupabaseEnvironment, isAllowedAdminEmail, protectAdminRequest } from "@/lib/auth/admin-middleware"

const AUTH_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  ADMIN_EMAIL_ALLOWLIST: "admin@example.com, owner@example.com",
} as const

describe("admin auth middleware", () => {
  it("skips admin auth when Supabase public auth env is absent", async () => {
    // Given: an admin request in local credential-free mode.
    const request = new NextRequest("https://seo.example.test/admin")

    // When: the middleware guard runs without public Supabase auth env.
    const response = await protectAdminRequest(request, {
      env: {},
      getUser() {
        return Promise.resolve(null)
      },
    })

    // Then: the request is allowed through for build/test without live credentials.
    expect(response.status).toBe(200)
    expect(response.headers.get("location")).toBeNull()
  })

  it("redirects unauthenticated admin requests to login when auth env is configured", async () => {
    // Given: a protected admin request with public Supabase auth env configured.
    const request = new NextRequest("https://seo.example.test/admin/settings")

    // When: Supabase returns no verified user.
    const response = await protectAdminRequest(request, {
      env: AUTH_ENV,
      getUser() {
        return Promise.resolve(null)
      },
    })

    // Then: the user is redirected to the build-safe login page with the original admin path preserved.
    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe("https://seo.example.test/login?next=%2Fadmin%2Fsettings")
  })

  it("allows authenticated admin requests when Supabase returns an allowed admin email", async () => {
    // Given: a protected admin request with auth env configured.
    const request = new NextRequest("https://seo.example.test/admin/sync")

    // When: the auth seam returns a verified user.
    const response = await protectAdminRequest(request, {
      env: AUTH_ENV,
      getUser() {
        return Promise.resolve({ id: "user_1", email: "Admin@Example.com" })
      },
    })

    // Then: the admin request continues without redirect.
    expect(response.status).toBe(200)
    expect(response.headers.get("location")).toBeNull()
  })

  it("redirects authenticated users whose email is not allowlisted", async () => {
    // Given: a protected admin request with a non-admin authenticated user.
    const request = new NextRequest("https://seo.example.test/admin/sync")

    // When: the auth seam returns a user outside the admin allowlist.
    const response = await protectAdminRequest(request, {
      env: AUTH_ENV,
      getUser() {
        return Promise.resolve({ id: "user_2", email: "viewer@example.com" })
      },
    })

    // Then: the user is not allowed through to service-role-backed admin pages.
    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe("https://seo.example.test/login?next=%2Fadmin%2Fsync")
  })

  it("allows authenticated users with an admin role even when the email allowlist misses", async () => {
    // Given: a protected admin request with auth env configured.
    const request = new NextRequest("https://seo.example.test/admin/sync")

    // When: the auth seam returns a verified user with an admin role claim.
    const response = await protectAdminRequest(request, {
      env: AUTH_ENV,
      getUser() {
        return Promise.resolve({ id: "user_3", email: "operator@example.com", role: "admin" })
      },
    })

    // Then: the role-based admin path is allowed through.
    expect(response.status).toBe(200)
    expect(response.headers.get("location")).toBeNull()
  })

  it("redirects partial Supabase admin environment to setup instead of allowing service-role reads", async () => {
    // Given: a partial production-like environment with only service-role data access configured.
    const request = new NextRequest("https://seo.example.test/admin/places")

    // When: the admin guard sees incomplete auth configuration.
    const response = await protectAdminRequest(request, {
      env: { NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role" },
      getUser() {
        return Promise.resolve({ id: "user_1", email: "admin@example.com" })
      },
    })

    // Then: admin data is not exposed until the auth environment is complete.
    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe("https://seo.example.test/login?setup=missing")
  })

  it("does not protect non-admin routes", async () => {
    // Given: a public route request with auth env configured.
    const request = new NextRequest("https://seo.example.test/funeral/funeral-seoul-seocho")

    // When: the middleware guard evaluates the route.
    const response = await protectAdminRequest(request, {
      env: AUTH_ENV,
      getUser() {
        return Promise.resolve(null)
      },
    })

    // Then: public pages are never redirected by the admin auth guard.
    expect(response.status).toBe(200)
    expect(response.headers.get("location")).toBeNull()
  })

  it("detects whether public Supabase auth environment is complete", () => {
    // Given: partial and complete public auth environment shapes.
    const missingAnon = { NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co" }
    const complete = AUTH_ENV

    // When / Then: both public values must exist before middleware enforces admin auth.
    expect(hasAdminAuthEnvironment(missingAnon)).toBe(false)
    expect(hasAdminAuthEnvironment(complete)).toBe(true)
    expect(hasAnyAdminSupabaseEnvironment({ SUPABASE_SERVICE_ROLE_KEY: "service-role" })).toBe(true)
    expect(isAllowedAdminEmail("OWNER@example.com", AUTH_ENV.ADMIN_EMAIL_ALLOWLIST)).toBe(true)
    expect(isAllowedAdminEmail("viewer@example.com", AUTH_ENV.ADMIN_EMAIL_ALLOWLIST)).toBe(false)
  })
})
