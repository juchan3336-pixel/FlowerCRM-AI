import { renderToStaticMarkup } from "react-dom/server"
import React from "react"
import { describe, expect, it, vi } from "vitest"

import ForgotPasswordPage from "@/app/forgot-password/page"
import LoginPage from "@/app/login/page"
import ResetPasswordPage from "@/app/reset-password/page"
import {
  PASSWORD_RESET_SUCCESS_PATH,
  ResetPasswordForm,
  recoverPasswordResetSession,
  submitPasswordReset,
  type PasswordResetRecoveryClient,
  type PasswordResetUpdateClient,
} from "@/app/reset-password/reset-password-form"
import { buildPasswordResetRedirectTo, requestPasswordReset, type PasswordResetEmailClient } from "@/lib/auth/password-reset"

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: vi.fn(),
  }),
}))

vi.mock("@supabase/ssr", () => ({
  createBrowserClient: () => ({
    auth: {},
  }),
}))

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

  it("requests a reset email with a redirect derived from the request origin", async () => {
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
    const result = await requestPasswordReset({ formData, env: AUTH_ENV, redirectTo: buildPasswordResetRedirectTo("https://seo.example.test"), authClient })

    // Then: Supabase receives the auth-callback redirect carrying the reset-password next path.
    expect(result).toEqual({ kind: "sent", email: "admin@example.com" })
    expect(requests).toEqual([{ email: "admin@example.com", redirectTo: "https://seo.example.test/auth/callback?next=/reset-password" }])
  })

  it("builds the production reset redirect from the verified site URL helper shape", () => {
    // Given / When: the redirect target is built from the production site URL.
    const redirectTo = buildPasswordResetRedirectTo("https://flowercrm-seo.vercel.app")

    // Then: the reset email routes through the auth callback, never the root route.
    expect(redirectTo).toBe("https://flowercrm-seo.vercel.app/auth/callback?next=/reset-password")
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
    const result = await requestPasswordReset({ formData, env: AUTH_ENV, redirectTo: buildPasswordResetRedirectTo("https://seo.example.test"), authClient })

    // Then: validation fails at the boundary.
    expect(result).toEqual({ kind: "invalid_email" })
    expect(providerCalled).toBe(false)
  })

  it("renders reset-password fields and expired-link guidance", async () => {
    // Given: the reset page receives a recovery error code.
    const page = await ResetPasswordPage({ searchParams: Promise.resolve({ error_code: "otp_expired" }) })

    // When: the page is rendered.
    const markup = renderToStaticMarkup(page)

    // Then: the expired session hides the form and only shows the reset-email recovery path.
    expect(markup).toContain("Choose a new password")
    expect(markup).toContain("The reset link is invalid or expired")
    expect(markup).toContain("Request a new reset email")
    expect(markup).not.toContain("New password")
    expect(markup).not.toContain("Confirm password")
  })

  it("shows a signed-out message on the login screen", async () => {
    // Given: the login page after logout.
    const page = await LoginPage({ searchParams: Promise.resolve({ "logged-out": "1" }) })

    // When: the page is rendered.
    const markup = renderToStaticMarkup(page)

    // Then: the logout confirmation is visible.
    expect(markup).toContain("You have been signed out.")
  })

  it("renders a recovery-session loading state before password fields", () => {
    // Given: the reset form is mounted with Supabase configured but no recovery session yet.
    const page = React.createElement(ResetPasswordForm, { configured: true, initialMessage: null })

    // When: the page is rendered.
    const markup = renderToStaticMarkup(page)

    // Then: the form remains hidden until recovery is ready.
    expect(markup).toContain("Preparing recovery session...")
    expect(markup).not.toContain("New password")
    expect(markup).not.toContain("Confirm password")
  })

  it("recovers a reset session from a PKCE recovery code before password update", async () => {
    // Given: Supabase redirects the reset email link back with a recovery code.
    const exchangedCodes: string[] = []
    const authClient: PasswordResetRecoveryClient = {
      exchangeCodeForSession(code) {
        exchangedCodes.push(code)
        return Promise.resolve({ error: null })
      },
      getSession() {
        return Promise.resolve({ data: { session: { user: "ready" } } })
      },
      setSession() {
        return Promise.resolve({ error: null })
      },
      verifyOtp() {
        return Promise.resolve({ error: null })
      },
    }

    // When: the reset page initializes recovery from the URL state.
    const result = await recoverPasswordResetSession(new URL("https://seo.example.test/reset-password?code=recovery-code&type=recovery"), authClient)

    // Then: a valid browser session is established through code exchange.
    expect(result).toEqual({ kind: "recovered" })
    expect(exchangedCodes).toEqual(["recovery-code"])
  })

  it("recovers a reset session from a direct code-only reset URL", async () => {
    // Given: the reset email lands directly on reset-password with only a code.
    const exchangedCodes: string[] = []
    const authClient: PasswordResetRecoveryClient = {
      exchangeCodeForSession(code) {
        exchangedCodes.push(code)
        return Promise.resolve({ error: null })
      },
      getSession() {
        return Promise.resolve({ data: { session: { user: "ready" } } })
      },
      setSession() {
        return Promise.resolve({ error: null })
      },
      verifyOtp() {
        return Promise.resolve({ error: null })
      },
    }

    // When: the reset page initializes recovery from the URL state.
    const result = await recoverPasswordResetSession(new URL("https://seo.example.test/reset-password?code=recovery-code"), authClient)

    // Then: the code is exchanged before password update is available.
    expect(result).toEqual({ kind: "recovered" })
    expect(exchangedCodes).toEqual(["recovery-code"])
  })

  it("recovers a reset session from a token hash recovery link before password update", async () => {
    // Given: Supabase uses the documented token_hash recovery callback format.
    const verifiedOtps: { readonly tokenHash: string; readonly type: string }[] = []
    const authClient: PasswordResetRecoveryClient = {
      exchangeCodeForSession() {
        return Promise.resolve({ error: null })
      },
      getSession() {
        return Promise.resolve({ data: { session: { user: "ready" } } })
      },
      setSession() {
        return Promise.resolve({ error: null })
      },
      verifyOtp(params) {
        verifiedOtps.push({ tokenHash: params.token_hash, type: params.type })
        return Promise.resolve({ error: null })
      },
    }

    // When: the reset page initializes recovery from the URL state.
    const result = await recoverPasswordResetSession(new URL("https://seo.example.test/reset-password?token_hash=hashed-token&type=recovery"), authClient)

    // Then: the token hash is verified and the update form can submit.
    expect(result).toEqual({ kind: "recovered" })
    expect(verifiedOtps).toEqual([{ tokenHash: "hashed-token", type: "recovery" }])
  })

  it("recovers a reset session from a direct token-hash-only reset URL", async () => {
    // Given: the reset email lands directly on reset-password with only token_hash.
    const verifiedOtps: { readonly tokenHash: string; readonly type: string }[] = []
    const authClient: PasswordResetRecoveryClient = {
      exchangeCodeForSession() {
        return Promise.resolve({ error: null })
      },
      getSession() {
        return Promise.resolve({ data: { session: { user: "ready" } } })
      },
      setSession() {
        return Promise.resolve({ error: null })
      },
      verifyOtp(params) {
        verifiedOtps.push({ tokenHash: params.token_hash, type: params.type })
        return Promise.resolve({ error: null })
      },
    }

    // When: the reset page initializes recovery from the URL state.
    const result = await recoverPasswordResetSession(new URL("https://seo.example.test/reset-password?token_hash=hashed-token"), authClient)

    // Then: the token hash is verified as recovery before password update is available.
    expect(result).toEqual({ kind: "recovered" })
    expect(verifiedOtps).toEqual([{ tokenHash: "hashed-token", type: "recovery" }])
  })

  it("reports an invalid recovery session when auth storage stays empty after exchange", async () => {
    // Given: Supabase reports success but no session is available afterward.
    const authClient: PasswordResetRecoveryClient = {
      exchangeCodeForSession() {
        return Promise.resolve({ error: null })
      },
      getSession() {
        return Promise.resolve({ data: { session: null } })
      },
      setSession() {
        return Promise.resolve({ error: null })
      },
      verifyOtp() {
        return Promise.resolve({ error: null })
      },
    }

    // When: the helper checks the recovery code flow.
    const result = await recoverPasswordResetSession(new URL("https://seo.example.test/reset-password?code=recovery-code"), authClient)

    // Then: the form stays hidden instead of enabling a broken submit path.
    expect(result).toEqual({ kind: "invalid" })
  })

  it("submits a new password and surfaces the provider error message", async () => {
    // Given: Supabase rejects the password update.
    const authClient: PasswordResetUpdateClient = {
      updateUser() {
        return Promise.resolve({ error: { message: "session expired" } })
      },
    }

    // When: the reset submission runs.
    const result = await submitPasswordReset(authClient, "new-password-123")

    // Then: the exact provider error is returned for the UI.
    expect(result).toEqual({ kind: "failed", message: "session expired" })
  })

  it("submits a new password successfully", async () => {
    // Given: Supabase accepts the password update.
    const authClient: PasswordResetUpdateClient = {
      updateUser() {
        return Promise.resolve({ error: null })
      },
    }

    // When: the reset submission runs.
    const result = await submitPasswordReset(authClient, "new-password-123")

    // Then: the caller can redirect to the success screen.
    expect(result).toEqual({ kind: "updated" })
  })

  it("redirects to the login success screen after a password update", () => {
    // Given / When / Then: the success redirect lands on login with the reset flag.
    expect(PASSWORD_RESET_SUCCESS_PATH).toBe("/login?reset=success")
  })
})
