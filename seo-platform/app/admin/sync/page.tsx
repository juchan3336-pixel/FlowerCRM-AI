import { loadAdminSync } from "@/lib/admin/sync"
import type { AdminSyncStatus, SyncCountCard } from "@/lib/admin/sync"
import {
  driftNoticeFromJob,
  syncJobNoticeMessage,
  toRowNumberDriftNotice,
  toSyncJobView,
  type RowNumberDriftNotice,
  type SyncJobView,
  type SyncJobViewInput,
  type SyncSessionTotals,
} from "@/lib/admin/sync-job-view"
import { runManualSyncAction } from "./actions"
import { SyncCoverageCard } from "./coverage-card"
import { SyncJobCard } from "./job-card"
import { RecentSyncRuns } from "./recent-runs"
import { RowRemapDryRunPanel } from "./row-remap-panel"
import { ManualSyncSubmitButton } from "./submit-button"

export const dynamic = "force-dynamic"

const STATUS_TONE_CLASS: Record<SyncCountCard["tone"], string> = {
  accent: "text-[var(--accent-primary)]",
  neutral: "text-[var(--text-primary)]",
  warning: "text-[var(--status-warning)]",
  error: "text-[var(--status-error)]",
}

export function AdminSyncContent({
  syncJob,
  syncStatus,
  syncNotice,
  jobNotice,
  driftNotice,
}: Readonly<{
  syncJob?: SyncJobView | null
  syncStatus: AdminSyncStatus
  syncNotice?: AdminSyncNotice | undefined
  jobNotice?: string | undefined
  driftNotice?: RowNumberDriftNotice | undefined
}>) {
  const sourceLabel = syncStatus.source === "supabase" ? "Supabase 동기화 테이블" : "로컬 fixture 상태"

  return (
    <section aria-labelledby="admin-sync-title" className="flex flex-col gap-6">
      <header className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">동기화</p>
        <div className="mt-2 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 id="admin-sync-title" className="text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              {syncStatus.title}
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">{syncStatus.message} 출처: {sourceLabel}.</p>
          </div>
          <form action={runManualSyncAction}>
            <ManualSyncSubmitButton />
          </form>
        </div>
        <p id="manual-sync-help" className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
          한 번 실행은 안전한 한 배치(50건)만 가져옵니다. 잔여 신규 행을 모두 따라잡으려면 아래 자동 연속 동기화를 사용하세요.
        </p>
        <p id="sync-job-help" className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
          자동 연속 동기화는 서버가 50건 단위로 스스로 이어서 실행합니다. 브라우저를 닫아도 계속 진행됩니다.
        </p>
        {driftNotice === undefined ? null : (
          <div
            aria-live="assertive"
            className="mt-4 rounded-2xl border-2 border-[var(--status-error)] bg-[var(--status-error)]/10 p-4 text-sm leading-6"
            role="alert"
          >
            <p className="font-semibold text-[var(--status-error)]">동기화 차단됨 — 행번호 정합성 복구 필요</p>
            <p className="mt-1 text-[var(--text-primary)]">{driftNotice.message}</p>
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
              <dt className="text-[var(--text-secondary)]">Sheet 마지막 행</dt>
              <dd className="m-0 font-mono font-semibold tabular-nums text-[var(--text-primary)]">{driftNotice.latestSheetRow}</dd>
              <dt className="text-[var(--text-secondary)]">기록된 최대 행</dt>
              <dd className="m-0 font-mono font-semibold tabular-nums text-[var(--text-primary)]">{driftNotice.maxSourceRowNumber}</dd>
              <dt className="text-[var(--text-secondary)]">차이</dt>
              <dd className="m-0 font-mono font-semibold tabular-nums text-[var(--status-error)]">{driftNotice.difference}행</dd>
              <dt className="text-[var(--text-secondary)]">차단 범위</dt>
              <dd className="m-0 font-semibold text-[var(--status-error)]">수동 실행 · 자동 연속 동기화 모두 중지</dd>
            </dl>
          </div>
        )}
        {jobNotice === undefined ? null : (
          <p className="mt-3 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3 text-sm leading-6 text-[var(--text-secondary)]" role="status">
            {jobNotice}
          </p>
        )}
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
              최신 실행 상태
            </h3>
            <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
              {latestRunTimingLabel(syncStatus)} · {syncStatus.totalRows}행 기준.
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

      <SyncJobCard job={syncJob ?? null} />

      <RowRemapDryRunPanel />

      <SyncCoverageCard coverage={syncStatus.coverage} />

      <RecentSyncRuns runs={syncStatus.recentRuns} />

      <section aria-labelledby="sync-error-list-title" className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <div className="border-b border-[var(--border-default)] p-5">
          <h3 id="sync-error-list-title" className="text-lg font-semibold text-[var(--text-primary)]">
            동기화 오류 목록
          </h3>
          <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
            행 오류는 source payload, 비공개 메모, 자격 증명 기반 메타데이터 없이 표시됩니다.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead className="bg-[var(--surface-secondary)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
              <tr>
                <th className="px-5 py-4" scope="col">시트</th>
                <th className="px-5 py-4" scope="col">행</th>
                <th className="px-5 py-4" scope="col">코드</th>
                <th className="px-5 py-4" scope="col">메시지</th>
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
  return syncStatus.status === "running" ? `시작 시각 ${syncStatus.finishedAt}` : `완료 시각 ${syncStatus.finishedAt}`
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
  const [syncStatus, latest] = await Promise.all([getAdminSyncStatus(), getLatestSyncJob()])
  // 방금 차단된 요청은 쿼리 수치로, 이미 drift로 멈춰 있는 job은 저장된 값으로 배너를 띄운다
  // (새로고침해서 쿼리가 사라져도 경고가 유지된다).
  const driftNotice =
    toRowNumberDriftNotice({
      job: firstSearchParam(searchParams["job"]),
      sync: firstSearchParam(searchParams["sync"]),
      sheetRow: nonNegativeNumberParam(searchParams["sheetRow"]),
      maxRow: nonNegativeNumberParam(searchParams["maxRow"]),
      difference: nonNegativeNumberParam(searchParams["diff"]),
    }) ?? driftNoticeFromJob(latest)

  return (
    <AdminSyncContent
      driftNotice={driftNotice}
      jobNotice={syncJobNoticeMessage(firstSearchParam(searchParams["job"]), firstSearchParam(searchParams["reason"]), nonNegativeNumberParam(searchParams["remaining"]))}
      syncJob={latest === null ? null : toSyncJobView(latest, await loadSessionTotals(latest))}
      syncNotice={toSyncNotice(searchParams)}
      syncStatus={syncStatus}
    />
  )
}

// 최신 job을 뷰 입력 형태로 읽는다. 배너(저장된 drift)와 카드 양쪽이 같은 값을 쓴다.
async function getLatestSyncJob(): Promise<SyncJobViewInput | null> {
  if (process.env["NEXT_PUBLIC_SUPABASE_URL"] === undefined || process.env["SUPABASE_SERVICE_ROLE_KEY"] === undefined) {
    return null
  }
  const { createSupabaseSyncJobRepository } = await import("@/lib/sync/supabase-job-repository")
  try {
    const job = await createSupabaseSyncJobRepository().findLatestJob()
    if (job === null) {
      return null
    }
    return {
      id: job.id,
      status: job.status,
      batchSize: job.batch_size,
      startRow: job.start_row,
      currentRow: job.current_row,
      targetLastRow: job.target_last_row,
      latestSheetRow: job.latest_sheet_row,
      batchIndex: job.batch_index,
      processedCount: job.processed_count,
      insertedCount: job.inserted_count,
      updatedCount: job.updated_count,
      skippedCount: job.skipped_count,
      failedCount: job.failed_count,
      remainingCount: job.remaining_count,
      chainIndex: job.chain_index,
      autoContinued: job.auto_continued,
      sessionStartedAt: job.session_started_at,
      totalSessionProcessed: job.total_session_processed,
      maxAutoJobs: job.max_auto_jobs,
      cancelRequested: job.cancel_requested,
      sessionStopReason: job.session_stop_reason,
      startedAt: job.started_at,
      lastTickAt: job.last_tick_at,
      finishedAt: job.finished_at,
      lastErrorCode: job.last_error_code,
      lastErrorMessage: job.last_error_message,
      leaseExpiresAt: job.lease_expires_at,
      pumpAttempt: job.pump_attempt,
      nowIso: new Date().toISOString(),
    }
  } catch {
    // migration 미적용 등으로 테이블이 없으면 카드만 비워 두고 나머지 화면은 그대로 동작시킨다.
    return null
  }
}

// 세션 누적 — 상한 도달로 자동 생성된 후속 job까지 합산해 하나의 세션으로 보여준다.
async function loadSessionTotals(job: SyncJobViewInput): Promise<SyncSessionTotals | undefined> {
  const { createSupabaseSyncJobRepository } = await import("@/lib/sync/supabase-job-repository")
  try {
    const current = await createSupabaseSyncJobRepository().findJobById(job.id)
    const sessionJobs = await createSupabaseSyncJobRepository().listSessionJobs(current?.root_job_id ?? job.id)
    const rows = sessionJobs.length === 0 ? [] : sessionJobs
    if (rows.length === 0) {
      return undefined
    }
    return {
      jobCount: rows.length,
      insertedCount: sum(rows, (entry) => entry.inserted_count),
      updatedCount: sum(rows, (entry) => entry.updated_count),
      skippedCount: sum(rows, (entry) => entry.skipped_count),
      failedCount: sum(rows, (entry) => entry.failed_count),
      failedRowNumbers: await loadSessionFailedRowNumbers(rows.map((entry) => entry.id)),
    }
  } catch {
    return undefined
  }
}

function sum<T>(rows: readonly T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0)
}

// 실패한 행 번호 — sync_runs를 통해 job에 묶인 sync_errors에서 모은다.
async function loadSessionFailedRowNumbers(jobIds: readonly string[]): Promise<readonly number[]> {
  if (jobIds.length === 0) {
    return []
  }
  const { createSupabaseServiceRoleClient } = await import("@/lib/supabase/server")
  const client = createSupabaseServiceRoleClient()
  const { data: runs } = await client.from("sync_runs").select("id").in("sync_job_id", [...jobIds])
  const runIds = (runs ?? []).map((run) => run.id)
  if (runIds.length === 0) {
    return []
  }
  const { data: errors } = await client.from("sync_errors").select("source_row_number").in("sync_run_id", runIds).order("source_row_number", { ascending: true })
  return (errors ?? []).map((row) => row.source_row_number).filter((value): value is number => typeof value === "number")
}

function toSyncNotice(searchParams: Record<string, string | readonly string[] | undefined>): AdminSyncNotice | undefined {
  const sync = firstSearchParam(searchParams["sync"])
  if (sync === "missing-env") {
    return { message: "Google Sheets 동기화가 아직 설정되지 않았습니다. Vercel에 GOOGLE_SERVICE_ACCOUNT_JSON과 GOOGLE_SPREADSHEET_ID를 추가한 뒤 다시 배포하세요.", retryHref: "/admin/sync", retryLabel: "상태 지우기" }
  }
  if (sync === "invalid-google-config") {
    return { message: "Google 서비스 계정 JSON이 올바르지 않습니다. 전체 JSON 시크릿을 Vercel에 다시 넣고 재배포하세요.", retryHref: "/admin/sync", retryLabel: "상태 지우기" }
  }
  if (sync === "failed") {
    return { message: manualSyncFailureMessage(firstSearchParam(searchParams["reason"])), retryHref: "/admin/sync", retryLabel: "상태 지우고 재시도" }
  }
  if (sync !== "completed") {
    return undefined
  }
  const inserted = nonNegativeCountParam(searchParams["inserted"])
  const updated = nonNegativeCountParam(searchParams["updated"])
  const failed = nonNegativeCountParam(searchParams["failed"])
  return { message: `수동 동기화 완료. 삽입 ${inserted}, 갱신 ${updated}, 실패 ${failed}.` }
}

function manualSyncFailureMessage(reason: string | undefined): string {
  switch (reason) {
    case "google-read":
      return "수동 동기화가 Google Sheets 읽기 중 실패했습니다. 시트가 서비스 계정과 공유되어 있는지, 탭 이름이 기업 DB인지 확인하세요."
    case "supabase-write":
      return "수동 동기화가 Supabase 쓰기 중 실패했습니다. 재시도 전에 Supabase 동기화 테이블과 service-role 환경 값을 확인하세요."
    case "unexpected":
      return "수동 동기화가 예기치 않게 실패했습니다. 재시도 전에 Vercel 함수 로그를 확인하세요."
    default:
      return "수동 동기화가 실패했습니다. 재시도 전에 최신 Supabase 동기화 실행과 Vercel 함수 로그를 확인하세요."
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
