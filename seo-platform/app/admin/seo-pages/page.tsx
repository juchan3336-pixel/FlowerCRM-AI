import { loadAdminSeoPages } from "@/lib/admin/seo-pages"
import type { AdminSeoPagesLoadResult } from "@/lib/admin/seo-pages"

type FilterPlaceholder = {
  readonly label: string
  readonly value: string
  readonly options: readonly string[]
}

export const dynamic = "force-dynamic"

const FILTER_PLACEHOLDERS = [
  { label: "Page type filter", value: "All page types", options: ["All page types", "area", "funeral", "hospital", "product"] },
  { label: "Status filter", value: "Published", options: ["Published", "Draft placeholder", "Archived placeholder"] },
  { label: "Sitemap inclusion filter", value: "Included", options: ["Included", "Excluded placeholder"] },
  { label: "Canonical health filter", value: "Healthy", options: ["Healthy", "Missing placeholder", "Mismatch placeholder"] },
] as const satisfies readonly FilterPlaceholder[]

export function AdminSeoPagesContent({ seoPages }: Readonly<{ seoPages: AdminSeoPagesLoadResult }>) {
  const sourceLabel = seoPages.source === "supabase" ? "Supabase public-safe view" : "local fixture DTOs"

  return (
    <section aria-labelledby="admin-seo-pages-title" className="flex flex-col gap-6">
      <header className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">SEO Pages</p>
        <div className="mt-2 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 id="admin-seo-pages-title" className="text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              SEO page admin overview
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">
              Rows are loaded from {sourceLabel}: page routing, canonical URL, sitemap inclusion, priority, and change-frequency status without
              private source fields or live mutation wiring.
            </p>
          </div>
          <button
            aria-describedby="seo-status-placeholder-help"
            className="w-fit rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2 text-sm font-semibold text-[var(--text-secondary)] opacity-70"
            disabled
            type="button"
          >
            Status changes are placeholder-only
          </button>
        </div>
        <p id="seo-status-placeholder-help" className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
          No server actions or publication mutations are connected in this read-only admin slice.
        </p>
      </header>

      <section aria-labelledby="seo-page-filter-title" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
        <div className="flex flex-col gap-1">
          <h3 id="seo-page-filter-title" className="text-lg font-semibold text-[var(--text-primary)]">
            Filter placeholders only
          </h3>
          <p className="text-sm leading-6 text-[var(--text-secondary)]">
            Controls document the admin filtering shape while remaining disabled until authenticated query state is added.
          </p>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {FILTER_PLACEHOLDERS.map((filter) => (
            <label className="flex flex-col gap-2 text-sm font-semibold text-[var(--text-primary)]" key={filter.label}>
              {filter.label}
              <select
                className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm font-semibold text-[var(--text-secondary)]"
                disabled
                value={filter.value}
              >
                {filter.options.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </section>

      <section aria-labelledby="seo-page-table-title" className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <div className="border-b border-[var(--border-default)] p-5">
          <h3 id="seo-page-table-title" className="text-lg font-semibold text-[var(--text-primary)]">
            Public-safe SEO rows
          </h3>
          <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
            Rows are derived from public page DTOs or Supabase `published_place_pages`, so private source fields stay out of the admin surface.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] border-collapse text-left text-sm">
            <thead className="bg-[var(--surface-secondary)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
              <tr>
                <th className="px-5 py-4" scope="col">Page type</th>
                <th className="px-5 py-4" scope="col">Path</th>
                <th className="px-5 py-4" scope="col">Canonical URL</th>
                <th className="px-5 py-4" scope="col">Status</th>
                <th className="px-5 py-4" scope="col">Sitemap</th>
                <th className="px-5 py-4" scope="col">Priority</th>
                <th className="px-5 py-4" scope="col">Change frequency</th>
                <th className="px-5 py-4" scope="col">Canonical health</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-default)]">
              {seoPages.rows.map((row) => (
                <tr className="text-[var(--text-primary)]" key={row.id}>
                  <td className="px-5 py-4 font-semibold">{row.type}</td>
                  <td className="px-5 py-4 font-mono text-xs text-[var(--accent-primary)]">{row.path}</td>
                  <td className="px-5 py-4 font-mono text-xs text-[var(--text-secondary)]">{row.canonicalUrl}</td>
                  <td className="px-5 py-4 text-[var(--accent-primary)]">{row.status}</td>
                  <td className="px-5 py-4 text-[var(--accent-primary)]">{row.sitemapState}</td>
                  <td className="px-5 py-4 text-[var(--text-secondary)]">{row.priority}</td>
                  <td className="px-5 py-4 text-[var(--text-secondary)]">{row.changeFrequency}</td>
                  <td className="px-5 py-4 text-[var(--accent-primary)]">{row.canonicalState}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  )
}

async function getAdminSeoPages(): Promise<AdminSeoPagesLoadResult> {
  if (process.env["NEXT_PUBLIC_SUPABASE_URL"] === undefined || process.env["SUPABASE_SERVICE_ROLE_KEY"] === undefined) {
    return loadAdminSeoPages()
  }

  const { createSupabaseAdminSeoPagesRepository } = await import("@/lib/admin/supabase-seo-pages")
  return loadAdminSeoPages(createSupabaseAdminSeoPagesRepository())
}

export default async function AdminSeoPagesPage() {
  return <AdminSeoPagesContent seoPages={await getAdminSeoPages()} />
}
