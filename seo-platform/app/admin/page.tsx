import Link from "next/link"

import { SummaryCard } from "@/components/admin/summary-card"
import { loadAdminDashboard } from "@/lib/admin/dashboard"
import type { AdminDashboardSummary } from "@/lib/admin/dashboard"

const QUICK_ACTIONS = [
  { href: "/admin/places", label: "장소", detail: "읽기 전용 장소 목록을 확인합니다." },
  { href: "/admin/seo-pages", label: "SEO 페이지", detail: "게시 전 SEO 행을 점검합니다." },
  { href: "/admin/sync", label: "동기화", detail: "Google Sheets 반영 상태를 봅니다." },
  { href: "/admin/settings", label: "설정", detail: "운영 설정만 읽기 전용으로 확인합니다." },
] as const

export const dynamic = "force-dynamic"

export function AdminDashboardContent({ dashboard }: Readonly<{ dashboard: AdminDashboardSummary }>) {
  const sourceLabel = dashboard.source === "supabase" ? "Supabase 읽기 전용 데이터" : "로컬 fixture 데이터"

  return (
    <section aria-labelledby="admin-dashboard-title" className="flex flex-col gap-6">
      <div className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)] lg:items-end">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">수집</p>
            <h2 id="admin-dashboard-title" className="mt-2 text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)] sm:text-3xl">
              관리 개요
            </h2>
            <p className="mt-3 max-w-3xl break-keep text-pretty text-sm leading-6 text-[var(--text-secondary)] sm:text-[15px]">
              지표는 {sourceLabel}에서 읽어옵니다. Supabase 인증과 변경 경계가 연결되기 전까지는 <span className="whitespace-nowrap">읽기 전용으로만 유지됩니다.</span>
            </p>
          </div>

          <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-primary)] p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-secondary)]">운영 상태</p>
            <dl className="mt-3 grid gap-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-[var(--text-secondary)]">데이터 소스</dt>
                <dd className="font-semibold text-[var(--text-primary)]">{dashboard.source === "supabase" ? "Supabase" : "Fixture"}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-[var(--text-secondary)]">표시 모드</dt>
                <dd className="font-semibold text-[var(--text-primary)]">읽기 전용</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-[var(--text-secondary)]">보호 경계</dt>
                <dd className="font-semibold text-[var(--text-primary)]">SSR auth proxy</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {dashboard.cards.map((card) => (
          <SummaryCard card={card} key={card.label} />
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.76fr)]">
        <section className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6" aria-labelledby="admin-dashboard-quick-actions">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-secondary)]">바로가기</p>
              <h3 id="admin-dashboard-quick-actions" className="mt-2 text-xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
                다음 작업
              </h3>
            </div>
            <p className="max-w-72 text-left text-sm leading-6 text-[var(--text-secondary)] sm:text-right">
              실제 변경은 하지 않고 상태만 확인하는 내부 이동 링크입니다.
            </p>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {QUICK_ACTIONS.map((action) => (
              <Link
                key={action.href}
                href={action.href}
                className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-primary)] p-4 transition duration-150 ease-out hover:border-[var(--accent-primary)] hover:bg-[var(--surface-elevated)] focus-visible:border-[var(--accent-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]/30"
              >
                <p className="text-sm font-semibold text-[var(--text-primary)]">{action.label}</p>
                <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{action.detail}</p>
              </Link>
            ))}
          </div>
        </section>

        <section className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6" aria-labelledby="admin-dashboard-notes">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-secondary)]">안내</p>
          <h3 id="admin-dashboard-notes" className="mt-2 text-xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
            운영 메모
          </h3>

          <ul className="mt-4 space-y-3 text-sm leading-6 text-[var(--text-secondary)]">
            <li className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-primary)] p-4">관리자는 읽기 전용만 유지하고, 쓰기 경계는 별도 작업으로 분리합니다.</li>
            <li className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-primary)] p-4">동기화 상태는 fixture와 Supabase 중 하나로 표시됩니다.</li>
            <li className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-primary)] p-4">정책상 공개 영역과 관리자 영역은 같은 톤이지만 다른 경계를 가집니다.</li>
          </ul>
        </section>
      </div>
    </section>
  )
}

async function getAdminDashboard(): Promise<AdminDashboardSummary> {
  if (process.env["NEXT_PUBLIC_SUPABASE_URL"] === undefined || process.env["SUPABASE_SERVICE_ROLE_KEY"] === undefined) {
    return loadAdminDashboard()
  }

  const [{ createSupabaseAdminPlacesRepository }, { createSupabaseAdminSeoPagesRepository }, { createSupabaseAdminSitemapRepository }, { createSupabaseAdminSyncRepository }] = await Promise.all([
    import("@/lib/admin/supabase-places"),
    import("@/lib/admin/supabase-seo-pages"),
    import("@/lib/admin/supabase-sitemap"),
    import("@/lib/admin/supabase-sync"),
  ])

  return loadAdminDashboard({
    places: createSupabaseAdminPlacesRepository(),
    seoPages: createSupabaseAdminSeoPagesRepository(),
    sitemap: createSupabaseAdminSitemapRepository(),
    sync: createSupabaseAdminSyncRepository(),
  })
}

export default async function AdminDashboardPage() {
  return <AdminDashboardContent dashboard={await getAdminDashboard()} />
}
