import type { ReactNode } from "react"

import { failureMessage, noticeMessage, STATUS_LABEL } from "@/lib/marketing/admin-view"
import type { DistributionStatus } from "@/lib/marketing/types"

// 광고 배포 관리자 화면 공통 조각 — 색·모서리·여백은 기존 관리자 화면(검색 노출 리포트)의 토큰을 그대로 쓴다.

export const INPUT_CLASS =
  "w-full rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]/30"

export const PRIMARY_BUTTON_CLASS =
  "inline-flex min-h-10 items-center justify-center rounded-full bg-[var(--accent-primary)] px-5 py-2 text-sm font-semibold text-white transition-colors duration-150 ease-out hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]/30"

export const SECONDARY_BUTTON_CLASS =
  "inline-flex min-h-10 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-5 py-2 text-sm font-semibold text-[var(--text-primary)] transition-colors duration-150 ease-out hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]/30"

export function PageHeader({ eyebrow, title, titleId, children }: Readonly<{ eyebrow: string; title: string; titleId: string; children: ReactNode }>) {
  return (
    <header className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
      <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">{eyebrow}</p>
      <h2 className="mt-2 text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]" id={titleId}>
        {title}
      </h2>
      <div className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">{children}</div>
    </header>
  )
}

export function Panel({ title, description, id, children }: Readonly<{ title: string; description?: string; id?: string; children: ReactNode }>) {
  return (
    <section className="scroll-mt-6 overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]" id={id}>
      <div className="border-b border-[var(--border-default)] p-5">
        <h3 className="text-lg font-semibold text-[var(--text-primary)]">{title}</h3>
        {description === undefined ? null : <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">{description}</p>}
      </div>
      {children}
    </section>
  )
}

export function Field({ label, hint, children }: Readonly<{ label: string; hint?: string; children: ReactNode }>) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-semibold text-[var(--text-primary)]">
      {label}
      {children}
      {hint === undefined ? null : <span className="text-xs font-normal leading-5 text-[var(--text-secondary)]">{hint}</span>}
    </label>
  )
}

// 액션 결과 안내 — 주소의 notice/error 코드를 문구로 바꿔 보여준다.
export function ResultBanner({ notice, error }: Readonly<{ notice: string | null; error: string | null }>) {
  if (error !== null) {
    return (
      <p className="rounded-3xl border border-[var(--status-error)]/40 bg-[var(--status-error)]/10 p-4 text-sm leading-6 text-[var(--text-primary)]" role="alert">
        {failureMessage(error)}
      </p>
    )
  }
  const message = notice === null ? null : noticeMessage(notice)
  if (message === null) {
    return null
  }
  return (
    <p className="rounded-3xl border border-[var(--accent-primary)]/30 bg-[var(--accent-primary)]/5 p-4 text-sm leading-6 text-[var(--text-primary)]" role="status">
      {message}
    </p>
  )
}

const STATUS_TONE: Readonly<Record<DistributionStatus, string>> = {
  draft: "border-[var(--border-default)] text-[var(--text-secondary)]",
  needs_review: "border-[var(--status-warning)]/50 text-[var(--status-warning)]",
  approved: "border-[var(--accent-primary)]/50 text-[var(--accent-primary)]",
  manual_ready: "border-[var(--status-warning)]/50 text-[var(--status-warning)]",
  manual_confirmed: "border-[var(--accent-primary)] bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]",
  queued: "border-[var(--border-default)] text-[var(--text-secondary)]",
  publishing: "border-[var(--border-default)] text-[var(--text-secondary)]",
  published: "border-[var(--accent-primary)] bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]",
  unknown: "border-[var(--status-error)]/50 text-[var(--status-error)]",
  failed: "border-[var(--status-error)]/50 text-[var(--status-error)]",
}

export function StatusBadge({ status }: Readonly<{ status: DistributionStatus }>) {
  return <span className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>
}

// 테이블·저장소를 읽지 못했을 때 — 적용해야 할 SQL 파일을 안내한다.
export function SetupNotice() {
  return (
    <section className="rounded-3xl border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 p-5 text-sm leading-6 text-[var(--text-primary)]">
      <h3 className="text-lg font-semibold">광고 배포 테이블을 읽지 못했습니다</h3>
      <p className="mt-2">처음 한 번, Supabase SQL Editor에서 아래 두 파일을 순서대로 실행해 주세요. 기존 테이블은 바뀌지 않습니다.</p>
      <ol className="mt-3 list-decimal pl-5">
        <li>
          <code className="font-mono text-xs">seo-platform/supabase/migrations/202611100001_marketing_distribution.sql</code> — 전체 실행
        </li>
        <li>
          <code className="font-mono text-xs">seo-platform/supabase/operations/verify_marketing_distribution_migration.sql</code> — 결과 한 행이 주석의 기대값과
          같은지 확인
        </li>
      </ol>
      <p className="mt-3 text-[var(--text-secondary)]">실행한 뒤 이 화면을 새로 고치면 바로 사용할 수 있습니다.</p>
    </section>
  )
}
