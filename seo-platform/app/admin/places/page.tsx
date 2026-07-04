import { loadAdminPlaces } from "@/lib/admin/places"
import type { AdminPlacesLoadResult } from "@/lib/admin/places"

export const dynamic = "force-dynamic"

const FILTER_PLACEHOLDERS = ["Category", "City / district", "Status", "AI state"] as const

export function AdminPlacesContent({ places }: Readonly<{ places: AdminPlacesLoadResult }>) {
  const sourceLabel = places.source === "supabase" ? "Supabase public-safe view" : "local fixture DTOs"

  return (
    <section aria-labelledby="admin-places-title" className="flex flex-col gap-6">
      <header className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">Places</p>
        <div className="mt-2 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 id="admin-places-title" className="text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              Places list
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">
              Rows are loaded from {sourceLabel}. CRUD, detail editing, Supabase auth, and AI generation are intentionally out
              of scope for this read-only slice.
            </p>
          </div>
          <p className="rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2 text-sm font-semibold text-[var(--status-warning)]">
            {places.rows.length} rows
          </p>
        </div>
      </header>

      <section aria-labelledby="admin-places-filters-title" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 id="admin-places-filters-title" className="text-lg font-semibold text-[var(--text-primary)]">
              Filter controls are placeholders
            </h3>
            <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
              Labels mirror the planned admin workflow without mutating live data.
            </p>
          </div>
          <label className="flex min-w-0 flex-col gap-2 text-sm font-semibold text-[var(--text-primary)] sm:w-72">
            Search
            <input
              className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm text-[var(--text-secondary)]"
              disabled
              placeholder="Search fixture places"
              type="search"
            />
          </label>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {FILTER_PLACEHOLDERS.map((label) => (
            <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3" key={label}>
              <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">{label}</p>
              <p className="mt-2 text-sm font-semibold text-[var(--text-primary)]">All read-only values</p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="admin-places-table-title" className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <div className="border-b border-[var(--border-default)] p-5">
          <h3 id="admin-places-table-title" className="text-lg font-semibold text-[var(--text-primary)]">
            Public-safe rows
          </h3>
          <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
            Source is either the public SEO fixture DTO or Supabase `published_place_pages` view, so private source metadata never reaches this list.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] border-collapse text-left text-sm">
            <thead className="bg-[var(--surface-secondary)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
              <tr>
                <th className="px-5 py-4" scope="col">Status</th>
                <th className="px-5 py-4" scope="col">Name / title</th>
                <th className="px-5 py-4" scope="col">Category / type</th>
                <th className="px-5 py-4" scope="col">Region</th>
                <th className="px-5 py-4" scope="col">Path</th>
                <th className="px-5 py-4" scope="col">AI state</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-default)]">
              {places.rows.map((row) => (
                <tr className="text-[var(--text-primary)]" key={row.id}>
                  <td className="px-5 py-4">
                    <span className="rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-1 text-xs font-semibold text-[var(--accent-primary)]">
                      {row.status}
                    </span>
                  </td>
                  <td className="px-5 py-4 font-semibold">{row.nameOrTitle}</td>
                  <td className="px-5 py-4 text-[var(--text-secondary)]">{row.categoryOrType}</td>
                  <td className="px-5 py-4 text-[var(--text-secondary)]">{row.region}</td>
                  <td className="px-5 py-4 font-mono text-xs text-[var(--text-secondary)]">{row.path}</td>
                  <td className="px-5 py-4 text-[var(--status-warning)]">{row.aiState}</td>
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
  if (process.env["NEXT_PUBLIC_SUPABASE_URL"] === undefined || process.env["SUPABASE_SERVICE_ROLE_KEY"] === undefined) {
    return loadAdminPlaces()
  }

  const { createSupabaseAdminPlacesRepository } = await import("@/lib/admin/supabase-places")
  return loadAdminPlaces(createSupabaseAdminPlacesRepository())
}

export default async function AdminPlacesPage() {
  return <AdminPlacesContent places={await getAdminPlaces()} />
}
