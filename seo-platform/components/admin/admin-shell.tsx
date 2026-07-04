import type { ReactNode } from "react"
import { ADMIN_NAV_ITEMS } from "./admin-data"
import { AuthBoundaryPlaceholder } from "./auth-boundary"

type AdminShellProps = {
  readonly children: ReactNode
}

export function AdminShell({ children }: AdminShellProps) {
  return (
    <AuthBoundaryPlaceholder>
      <header className="border-b border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">Admin</p>
            <h1 className="mt-2 text-3xl font-bold tracking-[-0.015em] text-[var(--text-primary)]">
              SEO operations console
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">
              Monitor pages, sync health, sitemap readiness, and AI preview state without touching live Supabase auth.
            </p>
          </div>
          <nav aria-label="Admin navigation" className="flex flex-wrap gap-2">
            {ADMIN_NAV_ITEMS.map((item) => (
              <a
                className="rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-2 text-sm font-semibold text-[var(--text-primary)] transition-colors duration-150 ease-out hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)]"
                href={item.href}
                key={item.href}
              >
                {item.label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 lg:px-8">{children}</main>
    </AuthBoundaryPlaceholder>
  )
}
