import type { ReactNode } from "react"

type AuthBoundaryPlaceholderProps = {
  readonly children: ReactNode
}

export function AuthBoundaryPlaceholder({ children }: AuthBoundaryPlaceholderProps) {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-[var(--surface-primary)] text-[var(--text-primary)]">
      <section
        aria-label="인증 경계 자리표시자"
        className="border-b border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm text-[var(--text-secondary)] sm:px-6 lg:px-8"
      >
        <div className="mx-auto flex max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <strong className="font-semibold text-[var(--text-primary)]">인증 경계</strong>
          <span>공개 auth 환경 변수가 설정되면 Supabase SSR auth가 관리자 경로를 보호합니다.</span>
        </div>
      </section>
      {children}
    </div>
  )
}
