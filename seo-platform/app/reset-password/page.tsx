import Link from "next/link"
import type { Metadata } from "next"

import { ResetPasswordForm } from "./reset-password-form"

export const metadata: Metadata = {
  title: "Reset Password",
  robots: { index: false, follow: false },
}

type ResetPasswordPageProps = {
  readonly searchParams?: Promise<Record<string, string | readonly string[] | undefined>>
}

export default async function ResetPasswordPage({ searchParams }: ResetPasswordPageProps) {
  const params = await searchParams
  const message = buildResetPasswordMessage(params)
  const configured = process.env["NEXT_PUBLIC_SUPABASE_URL"] !== undefined && process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] !== undefined

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-[var(--surface-primary)] px-4 py-12 text-[var(--text-primary)]">
      <section className="w-full max-w-xl rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6 shadow-sm sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">Admin Recovery</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.015em]">Choose a new password</h1>
        <p className="mt-4 text-sm leading-6 text-[var(--text-secondary)]">
          Enter and confirm a new password after opening the Supabase password reset link. Expired links require a new reset email.
        </p>
        <ResetPasswordForm configured={configured} initialMessage={message} />
        <Link className="mt-5 inline-flex text-sm font-semibold text-[var(--accent-primary)]" href="/forgot-password">
          Request a new reset email
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

function buildResetPasswordMessage(params: Record<string, string | readonly string[] | undefined> | undefined): string | null {
  if (readParam(params, "error") !== null || readParam(params, "error_code") !== null || readParam(params, "error_description") !== null) {
    return "The reset link is invalid or expired. Request a new password reset email."
  }
  return null
}
