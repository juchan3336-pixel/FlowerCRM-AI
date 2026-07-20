import type { Metadata } from "next"
import Link from "next/link"

import { PasswordLoginForm } from "@/components/admin/password-login-form"

import { requestMagicLinkAction } from "./actions"

export const metadata: Metadata = {
  title: "Admin Login",
  robots: { index: false, follow: false },
}

type LoginPageProps = {
  readonly searchParams?: Promise<Record<string, string | readonly string[] | undefined>>
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams
  const nextPath = readParam(params, "next") ?? "/admin/dashboard"
  const message = buildLoginMessage(params)

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-[var(--surface-primary)] px-4 py-12 text-[var(--text-primary)]">
      <section className="w-full max-w-xl rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6 shadow-sm sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">Admin Login</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.015em]">Admin password login</h1>
        <p className="mt-4 text-sm leading-6 text-[var(--text-secondary)]">
          Sign in with your Supabase admin email and password. Magic link remains available as a backup sign-in option.
        </p>
        {message !== null ? <p className="mt-5 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4 text-sm leading-6 text-[var(--text-secondary)]">{message}</p> : null}
        <PasswordLoginForm nextPath={nextPath} />
        <Link className="mt-4 inline-flex text-sm font-semibold text-[var(--accent-primary)]" href="/forgot-password">
          비밀번호를 잊으셨나요?
        </Link>
        <div className="mt-6 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Magic link backup</h2>
          <form action={requestMagicLinkAction} className="mt-4 grid gap-4">
            <input name="next" type="hidden" value={nextPath} />
            <label className="grid gap-2 text-sm font-semibold text-[var(--text-primary)]">
              Admin email
              <input
                className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3 text-sm text-[var(--text-primary)]"
                name="email"
                placeholder="admin@example.com"
                required
                type="email"
              />
            </label>
            <button className="rounded-full border border-[var(--border-default)] px-5 py-3 text-sm font-semibold text-[var(--text-primary)]" type="submit">
              Send magic link
            </button>
          </form>
        </div>
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

function buildLoginMessage(params: Record<string, string | readonly string[] | undefined> | undefined): string | null {
  if (readParam(params, "setup") === "missing") {
    return "Supabase public URL and anon key are not configured yet, so admin login is disabled in this environment."
  }
  if (readParam(params, "error") === "invalid-email") {
    return "Enter a valid admin email address."
  }
  if (readParam(params, "error") === "unauthorized") {
    return "That email is not allowed for this admin console."
  }
  if (readParam(params, "error") === "provider") {
    return "Supabase could not send the magic link. Check Auth settings and try again."
  }
  if (readParam(params, "error") === "invalid-password") {
    return "Enter your admin password."
  }
  if (readParam(params, "error") === "invalid-credentials") {
    return "이메일 또는 비밀번호가 올바르지 않습니다."
  }
  if (readParam(params, "error") === "server-error") {
    return "로그인 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요."
  }
  if (readParam(params, "sent") === "1") {
    return "Magic link requested. Check the admin email inbox to continue."
  }
  if (readParam(params, "reset") === "success") {
    return "Password updated. Sign in with your new password."
  }
  if (readParam(params, "logged-out") === "1") {
    return "You have been signed out."
  }
  return null
}
