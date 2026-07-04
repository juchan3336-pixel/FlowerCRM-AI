import type { Metadata } from "next"

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
  const nextPath = readParam(params, "next") ?? "/admin"
  const message = buildLoginMessage(params)

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-[var(--surface-primary)] px-4 py-12 text-[var(--text-primary)]">
      <section className="w-full max-w-xl rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6 shadow-sm sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">Admin Login</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.015em]">Request admin magic link</h1>
        <p className="mt-4 text-sm leading-6 text-[var(--text-secondary)]">
          The admin console is protected when Supabase public URL and anon key are configured. Enter an admin email to request a Supabase magic link.
        </p>
        {message !== null ? <p className="mt-5 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4 text-sm leading-6 text-[var(--text-secondary)]">{message}</p> : null}
        <form action={requestMagicLinkAction} className="mt-6 grid gap-4">
          <input name="next" type="hidden" value={nextPath} />
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
            Send magic link
          </button>
        </form>
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
    return "Supabase public URL and anon key are not configured yet, so magic-link email is disabled in this environment."
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
  if (readParam(params, "sent") === "1") {
    return "Magic link requested. Check the admin email inbox to continue."
  }
  return null
}
