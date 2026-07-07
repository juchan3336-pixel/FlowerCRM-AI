"use client"

import { createBrowserClient } from "@supabase/ssr"
import { useEffect, useMemo, useState, type SyntheticEvent } from "react"

import type { Database } from "@/types/database"

type ResetPasswordFormProps = {
  readonly configured: boolean
  readonly initialMessage: string | null
}

type SubmitState = "idle" | "submitting" | "failed"

export type PasswordResetRecoveryClient = {
  readonly exchangeCodeForSession: (code: string) => Promise<Readonly<{ error: { readonly message: string } | null }>>
  readonly getSession: () => Promise<Readonly<{ data: Readonly<{ session: object | null }> }>>
  readonly setSession: (session: Readonly<{ access_token: string; refresh_token: string }>) => Promise<Readonly<{ error: { readonly message: string } | null }>>
  readonly verifyOtp: (params: Readonly<{ token_hash: string; type: "recovery" }>) => Promise<Readonly<{ error: { readonly message: string } | null }>>
}

type PasswordResetRecoveryResult = { readonly kind: "recovered" } | { readonly kind: "invalid" } | { readonly kind: "pending" }

export async function recoverPasswordResetSession(url: URL, authClient: PasswordResetRecoveryClient): Promise<PasswordResetRecoveryResult> {
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""))
  const hashError = hashParams.get("error") ?? hashParams.get("error_code")
  if (hashError !== null) {
    return { kind: "invalid" }
  }

  const accessToken = hashParams.get("access_token")
  const refreshToken = hashParams.get("refresh_token")
  if (accessToken !== null && refreshToken !== null) {
    const { error } = await authClient.setSession({ access_token: accessToken, refresh_token: refreshToken })
    return error === null ? { kind: "recovered" } : { kind: "invalid" }
  }

  const code = url.searchParams.get("code")
  if (code !== null && code.length > 0) {
    const { error } = await authClient.exchangeCodeForSession(code)
    return error === null ? { kind: "recovered" } : { kind: "invalid" }
  }

  const tokenHash = url.searchParams.get("token_hash")
  if (tokenHash !== null && tokenHash.length > 0) {
    const { error } = await authClient.verifyOtp({ token_hash: tokenHash, type: "recovery" })
    return error === null ? { kind: "recovered" } : { kind: "invalid" }
  }

  const { data: sessionData } = await authClient.getSession()
  return sessionData.session !== null ? { kind: "recovered" } : { kind: "pending" }
}

export function ResetPasswordForm({ configured, initialMessage }: ResetPasswordFormProps) {
  const [message, setMessage] = useState(initialMessage ?? (configured ? null : "Supabase public URL and anon key are not configured yet, so password reset is disabled in this environment."))
  const [submitState, setSubmitState] = useState<SubmitState>("idle")
  const [canSubmit, setCanSubmit] = useState(false)
  const supabase = useMemo(() => {
    if (!configured) {
      return null
    }
    return createBrowserClient<Database>(process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "", process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] ?? "")
  }, [configured])

  useEffect(() => {
    if (supabase === null) {
      return
    }

    void recoverPasswordResetSession(new URL(window.location.href), supabase.auth).then(
      (result) => {
        if (result.kind === "invalid") {
          setMessage("The reset link is invalid or expired. Request a new password reset email.")
          return
        }
        if (result.kind === "recovered") {
          window.history.replaceState(null, "", window.location.pathname)
          setCanSubmit(true)
          setMessage(null)
        }
      },
      () => {
        setMessage("The reset session is invalid or expired. Request a new password reset email.")
      }
    )

    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setCanSubmit(true)
        setMessage(null)
      }
    })

    return () => {
      data.subscription.unsubscribe()
    }
  }, [supabase])

  async function updatePassword(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (supabase === null) {
      setMessage("Supabase public URL and anon key are not configured yet, so password reset is disabled in this environment.")
      setSubmitState("failed")
      return
    }

    const formData = new FormData(event.currentTarget)
    const passwordValue = formData.get("password")
    const confirmPasswordValue = formData.get("confirmPassword")
    const password = typeof passwordValue === "string" ? passwordValue : ""
    const confirmPassword = typeof confirmPasswordValue === "string" ? confirmPasswordValue : ""
    if (password.length < 8) {
      setMessage("New password must be at least 8 characters.")
      setSubmitState("failed")
      return
    }
    if (password !== confirmPassword) {
      setMessage("Password confirmation does not match.")
      setSubmitState("failed")
      return
    }

    setSubmitState("submitting")
    const { error } = await supabase.auth.updateUser({ password })
    if (error !== null) {
      setMessage("The reset session is invalid or expired. Request a new password reset email.")
      setSubmitState("failed")
      return
    }

    window.location.assign("/login?reset=success")
  }

  return (
    <form
      className="mt-6 grid gap-4"
      onSubmit={(event) => {
        void updatePassword(event)
      }}
    >
      {message !== null ? <p className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4 text-sm leading-6 text-[var(--text-secondary)]">{message}</p> : null}
      <label className="grid gap-2 text-sm font-semibold text-[var(--text-primary)]">
        New password
        <input
          className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm text-[var(--text-primary)]"
          minLength={8}
          name="password"
          required
          type="password"
        />
      </label>
      <label className="grid gap-2 text-sm font-semibold text-[var(--text-primary)]">
        Confirm password
        <input
          className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm text-[var(--text-primary)]"
          minLength={8}
          name="confirmPassword"
          required
          type="password"
        />
      </label>
      <button className="rounded-full bg-[var(--accent-primary)] px-5 py-3 text-sm font-semibold text-white" disabled={submitState === "submitting" || !canSubmit} type="submit">
        {submitState === "submitting" ? "Updating password..." : "Update password"}
      </button>
    </form>
  )
}
