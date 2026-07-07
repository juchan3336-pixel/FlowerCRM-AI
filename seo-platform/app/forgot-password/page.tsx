import Link from "next/link"
import type { Metadata } from "next"

import { requestPasswordResetAction } from "./actions"

export const metadata: Metadata = {
  title: "Reset Admin Password",
  robots: { index: false, follow: false },
}

type ForgotPasswordPageProps = {
  readonly searchParams?: Promise<Record<string, string | readonly string[] | undefined>>
}

export default async function ForgotPasswordPage({ searchParams }: ForgotPasswordPageProps) {
  const params = await searchParams
  const message = buildForgotPasswordMessage(params)

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-[var(--surface-primary)] px-4 py-12 text-[var(--text-primary)]">
      <section className="w-full max-w-xl rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6 shadow-sm sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">Admin Recovery</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.015em]">Reset admin password</h1>
        <p className="mt-4 text-sm leading-6 text-[var(--text-secondary)]">
          Enter your admin email and Supabase will send a password reset link. The link opens the secure password reset page.
        </p>
        {message !== null ? <p className="mt-5 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4 text-sm leading-6 text-[var(--text-secondary)]">{message}</p> : null}
        <form action={requestPasswordResetAction} className="mt-6 grid gap-4">
          <label className="grid gap-2 text-sm font-semibold text-[var(--text-primary)]">
            Admin email
            <input
              className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm text-[var(--text-primary)]"
              name="email"
              placeholder="admin@example.com"
              required
              type="email"
            />
          </label>
          <button className="rounded-full bg-[var(--accent-primary)] px-5 py-3 text-sm font-semibold text-white" type="submit">
            Send reset email
          </button>
        </form>
        <Link className="mt-5 inline-flex text-sm font-semibold text-[var(--accent-primary)]" href="/login">
          Back to login
        </Link>
      </section>
    </main>
  )
}

function readParam(params: Record<string, string | readonly string[] | undefined> | undefined, key: string): string | null {
  const value = params?.[key]
  if (typeof value === "string") {
    return value
  }
  return null
}

function buildForgotPasswordMessage(params: Record<string, string | readonly string[] | undefined> | undefined): string | null {
  if (readParam(params, "setup") === "missing") {
    return "Supabase public URL and anon key are not configured yet, so password reset is disabled in this environment."
  }
  if (readParam(params, "error") === "invalid-email") {
    return "Enter a valid admin email address."
  }
  if (readParam(params, "error") === "provider") {
    return "Supabase could not send the reset email. Check Auth settings and try again."
  }
  if (readParam(params, "sent") === "1") {
    return "Password reset email sent. Check your inbox and open the reset link."
  }
  return null
}
