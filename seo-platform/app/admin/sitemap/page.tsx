import { loadAdminSitemap } from "@/lib/admin/sitemap"
import type { AdminSitemapStatus, SitemapStatusCard } from "@/lib/admin/sitemap"

export const dynamic = "force-dynamic"

const STATUS_TONE_CLASS: Record<SitemapStatusCard["tone"], string> = {
  accent: "text-[var(--accent-primary)]",
  neutral: "text-[var(--text-primary)]",
  warning: "text-[var(--status-warning)]",
}

const SEARCH_VERIFICATION_PLACEHOLDERS = ["Google verification placeholder", "Naver verification placeholder"] as const

export function AdminSitemapContent({ sitemapStatus }: Readonly<{ sitemapStatus: AdminSitemapStatus }>) {
  const sourceLabel = sitemapStatus.source === "supabase" ? "Supabase public-safe view" : "local fixture DTOs"

  return (
    <section aria-labelledby="admin-sitemap-title" className="flex flex-col gap-6">
      <header className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">Sitemap</p>
        <div className="mt-2 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 id="admin-sitemap-title" className="text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              Sitemap and robots status
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">
              Read-only visibility for public SEO outputs from {sourceLabel}. This page reads only public sitemap and robots data and leaves search
              submission, validation, and verification automation for a later authenticated slice.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              className="rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2 text-sm font-semibold text-[var(--accent-primary)]"
              href={sitemapStatus.sitemapUrl}
            >
              Open Sitemap
            </a>
            <a
              className="rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2 text-sm font-semibold text-[var(--accent-primary)]"
              href={sitemapStatus.robotsUrl}
            >
              Open Robots
            </a>
            <button
              aria-describedby="sitemap-validation-help"
              className="rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2 text-sm font-semibold text-[var(--text-secondary)] opacity-70"
              disabled
              type="button"
            >
              Validate later
            </button>
          </div>
        </div>
        <p id="sitemap-validation-help" className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
          Validation automation is intentionally not wired in this read-only slice.
        </p>
      </header>

      <section aria-labelledby="sitemap-status-summary-title" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <h3 id="sitemap-status-summary-title" className="sr-only">
          Sitemap status summary
        </h3>
        {sitemapStatus.cards.map((card) => (
          <article className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5" key={card.label}>
            <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">{card.label}</p>
            <p className={`mt-3 break-words font-mono text-2xl font-semibold tracking-[-0.01em] ${STATUS_TONE_CLASS[card.tone]}`}>
              {card.value}
            </p>
            <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">{card.description}</p>
          </article>
        ))}
      </section>

      <section aria-labelledby="sitemap-included-url-title" className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <div className="border-b border-[var(--border-default)] p-5">
          <h3 id="sitemap-included-url-title" className="text-lg font-semibold text-[var(--text-primary)]">
            Included public URLs
          </h3>
          <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
            Preview of canonical URLs emitted by the public sitemap helper after publication and private-path filtering.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left text-sm">
            <thead className="bg-[var(--surface-secondary)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
              <tr>
                <th className="px-5 py-4" scope="col">URL</th>
                <th className="px-5 py-4" scope="col">Change frequency</th>
                <th className="px-5 py-4" scope="col">Priority</th>
                <th className="px-5 py-4" scope="col">Last modified</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-default)]">
              {sitemapStatus.entries.map((entry) => (
                <tr className="text-[var(--text-primary)]" key={entry.url}>
                  <td className="px-5 py-4 font-mono text-xs text-[var(--accent-primary)]">{entry.url}</td>
                  <td className="px-5 py-4 text-[var(--text-secondary)]">{entry.changeFrequency}</td>
                  <td className="px-5 py-4 text-[var(--text-secondary)]">{entry.priority}</td>
                  <td className="px-5 py-4 text-[var(--text-secondary)]">{entry.lastModified}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <section aria-labelledby="robots-disallowed-paths-title" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
          <h3 id="robots-disallowed-paths-title" className="text-lg font-semibold text-[var(--text-primary)]">
            Robots disallowed paths
          </h3>
          <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
            These exclusions come directly from the public robots helper.
          </p>
          <ul className="mt-4 grid gap-2">
            {sitemapStatus.disallowedPaths.map((path) => (
              <li className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 font-mono text-sm text-[var(--text-primary)]" key={path}>
                {path}
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="search-verification-title" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
          <h3 id="search-verification-title" className="text-lg font-semibold text-[var(--text-primary)]">
            Search verification placeholders
          </h3>
          <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
            Verification values stay as public placeholders until real site ownership metadata is configured.
          </p>
          <ul className="mt-4 grid gap-2">
            {SEARCH_VERIFICATION_PLACEHOLDERS.map((placeholder) => (
              <li className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm font-semibold text-[var(--text-primary)]" key={placeholder}>
                {placeholder}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </section>
  )
}

async function getAdminSitemapStatus(): Promise<AdminSitemapStatus> {
  if (process.env["NEXT_PUBLIC_SUPABASE_URL"] === undefined || process.env["SUPABASE_SERVICE_ROLE_KEY"] === undefined) {
    return loadAdminSitemap()
  }

  const { createSupabaseAdminSitemapRepository } = await import("@/lib/admin/supabase-sitemap")
  return loadAdminSitemap(createSupabaseAdminSitemapRepository())
}

export default async function AdminSitemapPage() {
  return <AdminSitemapContent sitemapStatus={await getAdminSitemapStatus()} />
}
