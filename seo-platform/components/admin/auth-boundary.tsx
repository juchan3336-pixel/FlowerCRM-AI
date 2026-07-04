import type { ReactNode } from "react"

type AuthBoundaryPlaceholderProps = {
  readonly children: ReactNode
}

export function AuthBoundaryPlaceholder({ children }: AuthBoundaryPlaceholderProps) {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-[var(--surface-primary)] text-[var(--text-primary)]">
      <section
        aria-label="Auth boundary placeholder"
        className="border-b border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm text-[var(--text-secondary)] sm:px-6 lg:px-8"
      >
        <div className="mx-auto flex max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <strong className="font-semibold text-[var(--text-primary)]">Auth boundary</strong>
          <span>Supabase SSR auth protects admin routes when public auth environment variables are configured.</span>
        </div>
      </section>
      {children}
    </div>
  )
}
