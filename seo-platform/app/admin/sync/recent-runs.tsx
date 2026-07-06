import type { SyncRunListRow } from "@/lib/admin/sync"

export function RecentSyncRuns({ runs }: Readonly<{ runs: readonly SyncRunListRow[] }>) {
  return (
    <section aria-labelledby="recent-sync-runs-title" className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
      <div className="border-b border-[var(--border-default)] p-5">
        <h3 id="recent-sync-runs-title" className="text-lg font-semibold text-[var(--text-primary)]">
          Recent sync runs
        </h3>
        <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
          After pressing sync, a new run should appear at the top with its started time, status, and batch counts.
        </p>
      </div>
      {runs.length === 0 ? (
        <p className="p-5 text-sm leading-6 text-[var(--text-secondary)]">No recent Supabase sync runs have been recorded yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-left text-sm">
            <thead className="bg-[var(--surface-secondary)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
              <tr>
                <th className="px-5 py-4" scope="col">Started</th>
                <th className="px-5 py-4" scope="col">Finished</th>
                <th className="px-5 py-4" scope="col">Status</th>
                <th className="px-5 py-4" scope="col">Rows</th>
                <th className="px-5 py-4" scope="col">Inserted</th>
                <th className="px-5 py-4" scope="col">Updated</th>
                <th className="px-5 py-4" scope="col">Failed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-default)]">
              {runs.map((run) => (
                <tr className="text-[var(--text-primary)]" key={run.id}>
                  <td className="px-5 py-4 font-mono text-xs">{run.startedAt}</td>
                  <td className="px-5 py-4 font-mono text-xs text-[var(--text-secondary)]">{run.finishedAt}</td>
                  <td className="px-5 py-4">
                    <span className="rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">
                      {run.status}
                    </span>
                  </td>
                  <td className="px-5 py-4 font-mono text-xs text-[var(--text-secondary)]">{run.totalRows}</td>
                  <td className="px-5 py-4 font-mono text-xs text-[var(--accent-primary)]">{run.inserted}</td>
                  <td className="px-5 py-4 font-mono text-xs text-[var(--text-secondary)]">{run.updated}</td>
                  <td className="px-5 py-4 font-mono text-xs text-[var(--status-error)]">{run.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
