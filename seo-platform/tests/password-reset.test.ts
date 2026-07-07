import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import ForgotPasswordPage from "@/app/forgot-password/page"
import LoginPage from "@/app/login/page"
import ResetPasswordPage from "@/app/reset-password/page"
import { requestPasswordReset, type PasswordResetEmailClient } from "@/lib/auth/password-reset"

const AUTH_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
} as const

describe("password reset", () => {
  it("renders a forgot-password link from the default login screen", async () => {
    // Given: the default login page.
    const page = await LoginPage({ searchParams: Promise.resolve({}) })

    // When: the page is rendered.
    const markup = renderToStaticMarkup(page)

    // Then: password login stays primary and the Korean reset link is visible.
    expect(markup).toContain("Admin password login")
    expect(markup).toContain("비밀번호를 잊으셨나요?")
    expect(markup).toContain("href=\"/forgot-password\"")
    expect(markup).toContain("Magic link backup")
  })

  it("shows reset success feedback on the login page", async () => {
    // Given: the login page after password reset success.
    const page = await LoginPage({ searchParams: Promise.resolve({ reset: "success" }) })

    // When: the page is rendered.
    const markup = renderToStaticMarkup(page)

    // Then: a clear success message is visible.
    expect(markup).toContain("Password updated. Sign in with your new password.")
  })

  it("renders the forgot-password email request form", async () => {
    // Given: the forgot password page.
    const page = await ForgotPasswordPage({ searchParams: Promise.resolve({}) })

    // When: the page is rendered.
    const markup = renderToStaticMarkup(page)

    // Then: the reset email request surface is visible.
    expect(markup).toContain("Reset admin password")
    expect(markup).toContain("Admin email")
    expect(markup).toContain("Send reset email")
  })

  it("requests a reset email with the production reset redirect", async () => {
    // Given: a valid email and a fake Supabase reset client.
    const formData = new FormData()
    formData.set("email", " admin@example.com ")
    const requests: { readonly email: string; readonly redirectTo: string }[] = []
    const authClient: PasswordResetEmailClient = {
      resetPasswordForEmail(email, options) {
        requests.push({ email, redirectTo: options.redirectTo })
        return Promise.resolve({ error: null })
      },
    }

    // When: the request is handled.
    const result = await requestPasswordReset({ formData, env: AUTH_ENV, authClient })

    // Then: Supabase receives the exact production reset-password redirect.
    expect(result).toEqual({ kind: "sent", email: "admin@example.com" })
    expect(requests).toEqual([{ email: "admin@example.com", redirectTo: "https://flowercrm-seo.vercel.app/reset-password" }])
  })

  it("rejects invalid reset email input before provider calls", async () => {
    // Given: invalid email input.
    const formData = new FormData()
    formData.set("email", "not-an-email")
    let providerCalled = false
    const authClient: PasswordResetEmailClient = {
      resetPasswordForEmail() {
        providerCalled = true
        return Promise.resolve({ error: null })
      },
    }

    // When: the request is handled.
    const result = await requestPasswordReset({ formData, env: AUTH_ENV, authClient })

    // Then: validation fails at the boundary.
    expect(result).toEqual({ kind: "invalid_email" })
    expect(providerCalled).toBe(false)
  })

  it("renders reset-password fields and expired-link guidance", async () => {
    // Given: the reset page receives a recovery error code.
    const page = await ResetPasswordPage({ searchParams: Promise.resolve({ error_code: "otp_expired" }) })

    // When: the page is rendered.
    const markup = renderToStaticMarkup(page)

    // Then: password fields and expired-link guidance are visible.
    expect(markup).toContain("Choose a new password")
    expect(markup).toContain("New password")
    expect(markup).toContain("Confirm password")
    expect(markup).toContain("The reset link is invalid or expired")
  })
})
