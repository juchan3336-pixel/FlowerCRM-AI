"use client"

import { createBrowserClient } from "@supabase/ssr"
import { useRouter } from "next/navigation"
import { useEffect, useMemo, useState, type SyntheticEvent } from "react"

import type { Database } from "@/types/database"

type ResetPasswordFormProps = {
  readonly configured: boolean
  readonly initialMessage: string | null
}

type SubmitState = "idle" | "submitting" | "failed"

type RecoveryState = "checking" | "ready" | "expired"

export type PasswordResetRecoveryClient = {
  readonly exchangeCodeForSession: (code: string) => Promise<Readonly<{ error: { readonly message: string } | null }>>
  readonly getSession: () => Promise<Readonly<{ data: Readonly<{ session: object | null }> }>>
  readonly setSession: (session: Readonly<{ access_token: string; refresh_token: string }>) => Promise<Readonly<{ error: { readonly message: string } | null }>>
  readonly verifyOtp: (params: Readonly<{ token_hash: string; type: "recovery" }>) => Promise<Readonly<{ error: { readonly message: string } | null }>>
}

export type PasswordResetUpdateClient = {
  readonly updateUser: (values: Readonly<{ password: string }>) => Promise<Readonly<{ error: { readonly message: string } | null }>>
}

type PasswordResetRecoveryResult = { readonly kind: "recovered" } | { readonly kind: "invalid" }

type PasswordResetUpdateResult = { readonly kind: "updated" } | { readonly kind: "failed"; readonly message: string }

async function hasRecoveredSession(authClient: PasswordResetRecoveryClient): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data: sessionData } = await authClient.getSession()
    if (sessionData.session !== null) {
      return true
    }

    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0)
    })
  }

  return false
}

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
    if (error !== null) {
      return { kind: "invalid" }
    }
  }

  const code = url.searchParams.get("code")
  if (code !== null && code.length > 0) {
    const { error } = await authClient.exchangeCodeForSession(code)
    if (error !== null) {
      return { kind: "invalid" }
    }
  }

  const tokenHash = url.searchParams.get("token_hash")
  if (tokenHash !== null && tokenHash.length > 0) {
    const { error } = await authClient.verifyOtp({ token_hash: tokenHash, type: "recovery" })
    if (error !== null) {
      return { kind: "invalid" }
    }
  }

  return (await hasRecoveredSession(authClient)) ? { kind: "recovered" } : { kind: "invalid" }
}

export async function submitPasswordReset(authClient: PasswordResetUpdateClient, password: string): Promise<PasswordResetUpdateResult> {
  const { error } = await authClient.updateUser({ password })
  if (error !== null) {
    return { kind: "failed", message: error.message }
  }

  return { kind: "updated" }
}

export function ResetPasswordForm({ configured, initialMessage }: ResetPasswordFormProps) {
  const router = useRouter()
  const [message, setMessage] = useState(initialMessage ?? (configured ? null : "Supabase public URL and anon key are not configured yet, so password reset is disabled in this environment."))
  const [submitState, setSubmitState] = useState<SubmitState>("idle")
  const [recoveryState, setRecoveryState] = useState<RecoveryState>(initialMessage !== null || !configured ? "expired" : "checking")
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

    if (initialMessage !== null) {
      return
    }

    let active = true
    const authClient = supabase.auth
    async function initializeRecovery(): Promise<void> {
      try {
        const result = await recoverPasswordResetSession(new URL(window.location.href), authClient)
        if (!active) {
          return
        }

        if (result.kind === "recovered") {
          window.history.replaceState(null, "", window.location.pathname)
          setRecoveryState("ready")
          setMessage(null)
          return
        }

        setRecoveryState("expired")
        setMessage("The reset session is invalid or expired. Request a new password reset email.")
      } catch {
        if (!active) {
          return
        }

        setRecoveryState("expired")
        setMessage("The reset session is invalid or expired. Request a new password reset email.")
      }
    }

    void initializeRecovery()

    return () => {
      active = false
    }
  }, [initialMessage, supabase])

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
    const result = await submitPasswordReset(supabase.auth, password)
    if (result.kind === "failed") {
      setMessage(result.message)
      setSubmitState("failed")
      return
    }

    router.replace("/login?reset=success")
  }

  if (recoveryState !== "ready") {
    return (
      <div className="mt-6 grid gap-4">
        <p className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4 text-sm leading-6 text-[var(--text-secondary)]">
          {message ?? "Preparing recovery session..."}
        </p>
        {recoveryState === "expired" ? (
          <a className="text-sm font-semibold text-[var(--accent-primary)]" href="/forgot-password">
            Request a new reset email
          </a>
        ) : null}
      </div>
    )
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
      <button className="rounded-full bg-[var(--accent-primary)] px-5 py-3 text-sm font-semibold text-white" disabled={submitState === "submitting"} type="submit">
        {submitState === "submitting" ? "Updating password..." : "Update password"}
      </button>
    </form>
  )
}
