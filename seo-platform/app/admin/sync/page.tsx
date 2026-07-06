import { loadAdminSync } from "@/lib/admin/sync"
import type { AdminSyncStatus, SyncCountCard } from "@/lib/admin/sync"
import { runManualSyncAction } from "./actions"
import { SyncCoverageCard } from "./coverage-card"
import { RecentSyncRuns } from "./recent-runs"
import { ManualSyncSubmitButton } from "./submit-button"
import type { AutoRunState } from "./submit-button"

export const dynamic = "force-dynamic"

const STATUS_TONE_CLASS: Record<SyncCountCard["tone"], string> = {
  accent: "text-[var(--accent-primary)]",
  neutral: "text-[var(--text-primary)]",
  warning: "text-[var(--status-warning)]",
  error: "text-[var(--status-error)]",
}

export function AdminSyncContent({ autoRun, syncStatus, syncNotice }: Readonly<{ autoRun?: AutoRunState | undefined; syncStatus: AdminSyncStatus; syncNotice?: AdminSyncNotice | undefined }>) {
  const sourceLabel = syncStatus.source === "supabase" ? "Supabase sync tables" : "local fixture status"
  const currentAutoRun = autoRun ?? { active: false, shouldContinue: false }

  return (
    <section aria-labelledby="admin-sync-title" className="flex flex-col gap-6">
      <header className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">Sync</p>
        <div className="mt-2 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 id="admin-sync-title" className="text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              {syncStatus.title}
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">{syncStatus.message} Source: {sourceLabel}.</p>
          </div>
          <form action={runManualSyncAction}>
            <ManualSyncSubmitButton autoRun={currentAutoRun} />
          </form>
        </div>
        <p id="manual-sync-help" className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
          Run once imports one safe batch. Auto sync keeps submitting the next batch from this browser until the Sheet is exhausted or a row error needs review.
        </p>
        {syncNotice === undefined ? null : (
          <p className="mt-3 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3 text-sm leading-6 text-[var(--text-secondary)]">
            {syncNotice.message}
            {syncNotice.retryHref === undefined ? null : (
              <a className="ml-2 font-semibold text-[var(--accent-primary)] underline-offset-4 hover:underline" href={syncNotice.retryHref}>
                {syncNotice.retryLabel}
              </a>
            )}
          </p>
        )}
      </header>

      <section aria-labelledby="sync-run-summary-title" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 id="sync-run-summary-title" className="text-lg font-semibold text-[var(--text-primary)]">
              Latest run status
            </h3>
            <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
              {latestRunTimingLabel(syncStatus)} from {syncStatus.totalRows} rows.
            </p>
          </div>
          <span className="w-fit rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">
            {syncStatus.status}
          </span>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {syncStatus.counts.map((count) => (
            <article className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4" key={count.label}>
              <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">{count.label}</p>
              <p className={`mt-3 font-mono text-3xl font-semibold tracking-[-0.01em] ${STATUS_TONE_CLASS[count.tone]}`}>{count.value}</p>
            </article>
          ))}
        </div>
      </section>

      <SyncCoverageCard coverage={syncStatus.coverage} />

      <RecentSyncRuns runs={syncStatus.recentRuns} />

      <section aria-labelledby="sync-error-list-title" className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <div className="border-b border-[var(--border-default)] p-5">
          <h3 id="sync-error-list-title" className="text-lg font-semibold text-[var(--text-primary)]">
            Sync error list
          </h3>
          <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
            Row errors are displayed without source payloads, private notes, or credential-backed metadata.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead className="bg-[var(--surface-secondary)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
              <tr>
                <th className="px-5 py-4" scope="col">Sheet</th>
                <th className="px-5 py-4" scope="col">Row</th>
                <th className="px-5 py-4" scope="col">Code</th>
                <th className="px-5 py-4" scope="col">Message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-default)]">
              {syncStatus.errors.map((error) => (
                <tr className="text-[var(--text-primary)]" key={`${error.sheetName}-${error.rowLabel}-${error.code}`}>
                  <td className="px-5 py-4 font-semibold">{error.sheetName}</td>
                  <td className="px-5 py-4 text-[var(--text-secondary)]">{error.rowLabel}</td>
                  <td className="px-5 py-4 font-mono text-xs text-[var(--status-error)]">{error.code}</td>
                  <td className="px-5 py-4 text-[var(--text-secondary)]">{error.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  )
}

function latestRunTimingLabel(syncStatus: AdminSyncStatus): string {
  return syncStatus.status === "running" ? `Started at ${syncStatus.finishedAt}` : `Finished at ${syncStatus.finishedAt}`
}

async function getAdminSyncStatus(): Promise<AdminSyncStatus> {
  if (process.env["NEXT_PUBLIC_SUPABASE_URL"] === undefined || process.env["SUPABASE_SERVICE_ROLE_KEY"] === undefined) {
    return loadAdminSync()
  }

  const { createSupabaseAdminSyncRepository } = await import("@/lib/admin/supabase-sync")
  return loadAdminSync(createSupabaseAdminSyncRepository())
}

export default async function AdminSyncPage(props: Readonly<{ searchParams?: Promise<Record<string, string | readonly string[] | undefined>> }> = {}) {
  const searchParams = props.searchParams === undefined ? {} : await props.searchParams
  return <AdminSyncContent autoRun={toAutoRunState(searchParams)} syncNotice={toSyncNotice(searchParams)} syncStatus={await getAdminSyncStatus()} />
}

function toAutoRunState(searchParams: Record<string, string | readonly string[] | undefined>): AutoRunState {
  const active = firstSearchParam(searchParams["auto"]) === "1"
  const batchRows = nonNegativeNumberParam(searchParams["rows"])
  const failed = nonNegativeNumberParam(searchParams["failed"])
  return { active, shouldContinue: active && batchRows > 0 && failed === 0 }
}

function toSyncNotice(searchParams: Record<string, string | readonly string[] | undefined>): AdminSyncNotice | undefined {
  const sync = firstSearchParam(searchParams["sync"])
  if (sync === "missing-env") {
    return { message: "Google Sheets sync is not configured yet. Add GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_SPREADSHEET_ID in Vercel, then redeploy.", retryHref: "/admin/sync", retryLabel: "Clear status" }
  }
  if (sync === "invalid-google-config") {
    return { message: "Google service-account JSON is invalid. Recopy the full JSON secret into Vercel and redeploy.", retryHref: "/admin/sync", retryLabel: "Clear status" }
  }
  if (sync === "failed") {
    return { message: manualSyncFailureMessage(firstSearchParam(searchParams["reason"])), retryHref: "/admin/sync", retryLabel: "Clear status and retry" }
  }
  if (sync !== "completed") {
    return undefined
  }
  const inserted = nonNegativeCountParam(searchParams["inserted"])
  const updated = nonNegativeCountParam(searchParams["updated"])
  const failed = nonNegativeCountParam(searchParams["failed"])
  return { message: `Manual sync completed. Inserted ${inserted}, updated ${updated}, failed ${failed}.` }
}

function manualSyncFailureMessage(reason: string | undefined): string {
  switch (reason) {
    case "google-read":
      return "Manual sync failed while reading Google Sheets. Confirm the Sheet is shared with the service account and the tab name is 기업 DB."
    case "supabase-write":
      return "Manual sync failed while writing to Supabase. Check the Supabase sync tables and service-role environment value before retrying."
    case "unexpected":
      return "Manual sync failed unexpectedly. Check Vercel function logs before retrying."
    default:
      return "Manual sync failed. Check the latest Supabase sync run and Vercel function logs before retrying."
  }
}

function nonNegativeCountParam(value: string | readonly string[] | undefined): string {
  return String(nonNegativeNumberParam(value))
}

function nonNegativeNumberParam(value: string | readonly string[] | undefined): number {
  const current = firstSearchParam(value)
  return current === undefined || !/^\d+$/.test(current) ? 0 : Number(current)
}

function firstSearchParam(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === "string") {
    return value
  }
  return value?.[0]
}

type AdminSyncNotice = {
  readonly message: string
  readonly retryHref?: string
  readonly retryLabel?: string
}
