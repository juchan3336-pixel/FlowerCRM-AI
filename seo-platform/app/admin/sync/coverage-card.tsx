import type { SyncCoverageStatus } from "@/lib/admin/sync"

export function SyncCoverageCard({ coverage }: Readonly<{ coverage: SyncCoverageStatus }>) {
  return (
    <section aria-labelledby="sync-coverage-title" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
      <h3 id="sync-coverage-title" className="text-lg font-semibold text-[var(--text-primary)]">
        Import coverage
      </h3>
      <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
        Use missing Sheet rows to find skipped or malformed source rows that need correction before final SEO publishing.
      </p>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <CoverageMetric label="Imported places" value={String(coverage.importedPlaces)} />
        <CoverageMetric label="Latest Sheet row" value={coverage.latestSourceRowNumber === null ? "None" : String(coverage.latestSourceRowNumber)} />
        <CoverageMetric label="Open running runs" value={String(coverage.openRunningRuns)} />
      </div>
      <p className="mt-4 text-sm leading-6 text-[var(--text-secondary)]">
        Missing rows preview: {coverage.missingSourceRows.length === 0 ? "none detected before the latest imported row" : coverage.missingSourceRows.join(", ")}
      </p>
    </section>
  )
}

function CoverageMetric({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <article className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">{label}</p>
      <p className="mt-3 font-mono text-2xl font-semibold tracking-[-0.01em] text-[var(--accent-primary)]">{value}</p>
    </article>
  )
}
