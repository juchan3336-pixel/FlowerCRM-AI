import { Suspense, type ReactNode } from "react"

import { AiUsageSection } from "@/components/admin/ai-usage-section"
import { CategoryBreakdownSection } from "@/components/admin/category-breakdown-section"
import { SummaryCard } from "@/components/admin/summary-card"
import { TaskCard } from "@/components/admin/task-card"
import type { AiUsageSummary } from "@/lib/admin/ai-usage"
import { loadAdminDashboard } from "@/lib/admin/dashboard"
import type { AdminDashboardSummary } from "@/lib/admin/dashboard"
import type { CategoryBreakdown } from "@/lib/admin/category-breakdown"

export const dynamic = "force-dynamic"

export function AdminDashboardContent({
  dashboard,
  aiUsage = null,
  aiUsageSlot = null,
  categoryBreakdown = null,
}: Readonly<{ dashboard: AdminDashboardSummary; aiUsage?: AiUsageSummary | null; aiUsageSlot?: ReactNode; categoryBreakdown?: CategoryBreakdown | null }>) {
  const sourceLabel = dashboard.source === "supabase" ? "실시간 데이터" : "샘플 데이터"

  return (
    <section aria-labelledby="admin-dashboard-title" className="flex flex-col gap-6">
      <div className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)] lg:items-end">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">대시보드</p>
            <h2 id="admin-dashboard-title" className="mt-2 text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)] sm:text-3xl">
              SEO 운영 현황
            </h2>
            <p className="mt-3 max-w-3xl break-keep text-pretty text-sm leading-6 text-[var(--text-secondary)] sm:text-[15px]">
              {dashboard.totalPlaces === null ? "전체 장소" : `전체 ${dashboard.totalPlaces.toLocaleString("ko-KR")}개 장소`}의 운영 상태를 한눈에 확인하고, 오늘 처리할 작업부터 시작하세요.
            </p>
          </div>

          <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-primary)] p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-secondary)]">운영 상태</p>
            <dl className="mt-3 grid gap-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-[var(--text-secondary)]">데이터</dt>
                <dd className="font-semibold text-[var(--text-primary)]">{sourceLabel}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-[var(--text-secondary)]">표시 모드</dt>
                <dd className="font-semibold text-[var(--text-primary)]">읽기 전용</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-[var(--text-secondary)]">접근 권한</dt>
                <dd className="font-semibold text-[var(--text-primary)]">관리자 전용</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>

      <section aria-labelledby="admin-dashboard-tasks" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h3 id="admin-dashboard-tasks" className="text-xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
            오늘 해야 할 작업
          </h3>
          <p className="text-sm leading-6 text-[var(--text-secondary)]">카드를 누르면 해당 작업 목록으로 이동합니다.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {dashboard.tasks.map((task) => (
            <TaskCard task={task} key={task.key} />
          ))}
        </div>
      </section>

      <section aria-labelledby="admin-dashboard-status" className="flex flex-col gap-4">
        <h3 id="admin-dashboard-status" className="text-xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
          전체 현황
        </h3>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {dashboard.cards.map((card) => (
            <SummaryCard card={card} key={card.label} />
          ))}
        </div>
      </section>

      {categoryBreakdown !== null ? <CategoryBreakdownSection breakdown={categoryBreakdown} /> : null}

      {aiUsage !== null ? <AiUsageSection usage={aiUsage} /> : aiUsageSlot}
    </section>
  )
}

async function getAdminAiUsage(): Promise<AiUsageSummary | null> {
  if (process.env["NEXT_PUBLIC_SUPABASE_URL"] === undefined || process.env["SUPABASE_SERVICE_ROLE_KEY"] === undefined) {
    return null
  }

  try {
    const [{ fetchAiUsageGenerations }, { aggregateAiUsage, readUsdKrwRate }] = await Promise.all([import("@/lib/admin/supabase-ai-usage"), import("@/lib/admin/ai-usage")])
    const { rows, placeNames } = await fetchAiUsageGenerations()
    return aggregateAiUsage(rows, placeNames, readUsdKrwRate(process.env["AI_COST_USD_KRW_RATE"]))
  } catch (error) {
    console.error("[admin-dashboard] ai usage load failed", { message: error instanceof Error ? error.message : String(error) })
    return null
  }
}

async function getAdminDashboard(): Promise<AdminDashboardSummary> {
  if (process.env["NEXT_PUBLIC_SUPABASE_URL"] === undefined || process.env["SUPABASE_SERVICE_ROLE_KEY"] === undefined) {
    return loadAdminDashboard()
  }

  // 숫자 카드에 필요한 count만 읽는다 — 장소·SEO·사이트맵·동기화 화면의 전체 로더를 여기서 돌리지 않는다.
  const { createSupabaseAdminDashboardSummaryRepository } = await import("@/lib/admin/supabase-dashboard")
  return loadAdminDashboard({ summary: createSupabaseAdminDashboardSummaryRepository() })
}

// AI 사용량은 조회가 가장 무거워, 숫자 카드를 먼저 내보내고 준비되는 대로 뒤따라 채운다.
async function AdminAiUsage({ usage }: Readonly<{ usage: Promise<AiUsageSummary | null> }>) {
  const aiUsage = await usage
  return aiUsage === null ? null : <AiUsageSection usage={aiUsage} />
}

function AiUsageFallback() {
  return (
    <div aria-busy="true" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 text-sm text-[var(--text-secondary)]" role="status">
      AI 사용량을 불러오는 중입니다…
    </div>
  )
}

export default async function AdminDashboardPage() {
  const hasLiveData = process.env["NEXT_PUBLIC_SUPABASE_URL"] !== undefined && process.env["SUPABASE_SERVICE_ROLE_KEY"] !== undefined
  // 두 조회를 동시에 시작하되, 화면은 숫자 카드가 준비되는 즉시 내보낸다 (getAdminAiUsage는 실패를 null로 삼킨다).
  const aiUsagePromise = hasLiveData ? getAdminAiUsage() : null
  const dashboard = await getAdminDashboard()
  const aiUsageSlot = aiUsagePromise !== null ? (
    <Suspense fallback={<AiUsageFallback />}>
      <AdminAiUsage usage={aiUsagePromise} />
    </Suspense>
  ) : null
  return <AdminDashboardContent aiUsageSlot={aiUsageSlot} dashboard={dashboard} />
}
