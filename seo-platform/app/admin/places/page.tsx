import { buildAdminPlacesErrorResult, loadAdminPlaces, resolveSupabaseUrlHostOrRef } from "@/lib/admin/places"
import type { AdminPlacesLoadResult } from "@/lib/admin/places"

export const dynamic = "force-dynamic"

export function AdminPlacesContent({ places }: Readonly<{ places: AdminPlacesLoadResult }>) {
  const sourceLabel =
    places.diagnostics.dataSource === "live" ? "Supabase places table" : "query error"
  const queryErrorLabel = formatQueryError(places.diagnostics.queryErrorCode, places.diagnostics.queryErrorMessage)
  const rowCountLabel = places.source === "error" ? "Error" : String(places.rows.length) + " rows"

  return (
    <section aria-labelledby="admin-places-title" className="flex flex-col gap-6">
      <header className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">Places</p>
        <div className="mt-2 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
              <h2 id="admin-places-title" className="text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              Places table
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">
              Read-only rows are loaded from {sourceLabel}. This screen shows the live `places` table and joined SEO state only.
            </p>
          </div>
          <p className="rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2 text-sm font-semibold text-[var(--status-warning)]">
            {rowCountLabel}
          </p>
        </div>
      </header>

      <section aria-labelledby="admin-places-diagnostics-title" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
        <div>
          <h3 id="admin-places-diagnostics-title" className="text-lg font-semibold text-[var(--text-primary)]">
            Supabase diagnostics
          </h3>
          <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
            Use this box to verify whether the page is reading live Supabase or returning an error.
          </p>
        </div>
        <dl className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <DiagnosticsCard label="data source" value={places.diagnostics.dataSource} />
          <DiagnosticsCard label="places query count" value={formatCount(places.diagnostics.placesQueryCount)} />
          <DiagnosticsCard label="seo_pages place count" value={formatCount(places.diagnostics.seoPagesPlaceCount)} />
          <DiagnosticsCard label="Supabase URL host/ref" value={places.diagnostics.supabaseUrlHostOrRef ?? "—"} />
          <DiagnosticsCard label="query error" value={queryErrorLabel} />
          <DiagnosticsCard label="last queried at" value={places.diagnostics.lastQueriedAt} />
        </dl>
      </section>

      <section aria-labelledby="admin-places-table-title" className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <div className="border-b border-[var(--border-default)] p-5">
          <h3 id="admin-places-table-title" className="text-lg font-semibold text-[var(--text-primary)]">
            Admin place rows
          </h3>
          <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
            Source is the admin `places` table, with SEO status joined separately and public SEO still handled by `published_place_pages` elsewhere.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] border-collapse text-left text-sm">
            <thead className="bg-[var(--surface-secondary)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
              <tr>
                <th className="px-5 py-4" scope="col">장소명</th>
                <th className="px-5 py-4" scope="col">카테고리</th>
                <th className="px-5 py-4" scope="col">지역</th>
                <th className="px-5 py-4" scope="col">상태</th>
                <th className="px-5 py-4" scope="col">AI 상태</th>
                <th className="px-5 py-4" scope="col">SEO 상태</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-default)]">
              {places.rows.map((row) => (
                <tr className="text-[var(--text-primary)]" key={row.id}>
                  <td className="px-5 py-4">
                    <span className="font-semibold">{row.name}</span>
                  </td>
                  <td className="px-5 py-4 text-[var(--text-secondary)]">{row.category}</td>
                  <td className="px-5 py-4 text-[var(--text-secondary)]">{row.region}</td>
                  <td className="px-5 py-4 text-[var(--text-secondary)]">{row.status}</td>
                  <td className="px-5 py-4 text-[var(--status-warning)]">{row.aiState}</td>
                  <td className="px-5 py-4 text-[var(--text-secondary)]">{row.seoState}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  )
}

async function getAdminPlaces(): Promise<AdminPlacesLoadResult> {
  const hasLiveSupabaseEnv = process.env["NEXT_PUBLIC_SUPABASE_URL"] !== undefined && process.env["SUPABASE_SERVICE_ROLE_KEY"] !== undefined
  const supabaseUrlHostOrRef = resolveSupabaseUrlHostOrRef(process.env["NEXT_PUBLIC_SUPABASE_URL"])

  if (!hasLiveSupabaseEnv && process.env.NODE_ENV !== "production") {
    return await loadAdminPlaces({}, { supabaseUrlHostOrRef })
  }

  try {
    const { createSupabaseAdminPlacesRepository } = await import("@/lib/admin/supabase-places")
    return await loadAdminPlaces({ places: createSupabaseAdminPlacesRepository() }, { supabaseUrlHostOrRef })
  } catch (error) {
    return buildAdminPlacesErrorResult(error, { supabaseUrlHostOrRef })
  }
}

function DiagnosticsCard({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4">
      <dt className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">{label}</dt>
      <dd className="mt-2 break-words text-sm font-semibold text-[var(--text-primary)]">{value}</dd>
    </div>
  )
}

function formatCount(value: number | null): string {
  return value === null ? "—" : String(value)
}

function formatQueryError(code: string | null, message: string | null): string {
  if (code === null && message === null) {
    return "—"
  }

  if (code === null) {
    return message ?? "—"
  }

  if (message === null) {
    return code
  }

  return `${code}: ${message}`
}

export default async function AdminPlacesPage() {
  return <AdminPlacesContent places={await getAdminPlaces()} />
}
