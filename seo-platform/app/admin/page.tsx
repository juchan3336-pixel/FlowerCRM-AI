import { SummaryCard } from "@/components/admin/summary-card"
import { loadAdminDashboard } from "@/lib/admin/dashboard"
import type { AdminDashboardSummary } from "@/lib/admin/dashboard"

export const dynamic = "force-dynamic"

export function AdminDashboardContent({ dashboard }: Readonly<{ dashboard: AdminDashboardSummary }>) {
  const sourceLabel = dashboard.source === "supabase" ? "Supabase read-only seams" : "local fixture fallbacks"

  return (
    <section aria-labelledby="admin-dashboard-title" className="flex flex-col gap-6">
      <div className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">Dashboard</p>
        <h2 id="admin-dashboard-title" className="mt-2 text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
          Admin overview
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">
          Metrics are loaded from {sourceLabel}. They remain read-only until Supabase auth and mutation boundaries are connected.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {dashboard.cards.map((card) => (
          <SummaryCard card={card} key={card.label} />
        ))}
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
