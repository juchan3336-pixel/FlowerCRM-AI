import { cancelSyncJobAction, resumeSyncJobAction, startSyncJobAction } from "./actions"
import { SyncJobAutoRefresh } from "./job-auto-refresh"
import { SyncJobCancelButton, SyncJobResumeButton, SyncJobStartButton } from "./job-buttons"
import type { SyncJobView } from "@/lib/admin/sync-job-view"

// 자동 연속 동기화 세션 카드.
// 사용자에게는 개별 job이 아니라 하나의 세션으로 보인다 — 상한 도달 후 서버가 자동으로 만든
// 후속 job도 같은 카드에서 누적으로 이어져 표시된다.
export function SyncJobCard({ job }: Readonly<{ job: SyncJobView | null }>) {
  const running = job !== null && (job.active || job.autoContinuing)

  return (
    <section aria-labelledby="sync-job-title" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
      <SyncJobAutoRefresh running={running} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 id="sync-job-title" className="text-lg font-semibold text-[var(--text-primary)]">
            신규 데이터 자동 연속 동기화
          </h3>
          <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
            버튼을 한 번 누르면 예약 작업이 50건 단위로 잔여 신규 행을 모두 따라잡습니다. 작업 상한에 닿으면 다음 작업을 자동으로 이어가며, 화면을 닫아도 계속 진행됩니다.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {job === null ? null : (
            <span className="w-fit rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">
              {job.statusLabel}
            </span>
          )}
          <form action={startSyncJobAction}>
            <SyncJobStartButton running={running} />
          </form>
          {job?.cancellable === true ? (
            <form action={cancelSyncJobAction}>
              <input name="jobId" type="hidden" value={job.id} />
              <SyncJobCancelButton />
            </form>
          ) : null}
          {job?.resumable === true ? (
            <form action={resumeSyncJobAction}>
              <input name="jobId" type="hidden" value={job.id} />
              <SyncJobResumeButton />
            </form>
          ) : null}
        </div>
      </div>

      {job === null ? (
        <p className="mt-5 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4 text-sm leading-6 text-[var(--text-secondary)]">
          아직 자동 연속 동기화 기록이 없습니다. 시작하면 진행 상황이 여기에 표시됩니다.
        </p>
      ) : (
        <>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SyncJobStat label="시트 전체 데이터" value={job.sheetDataRows} tone="neutral" />
            <SyncJobStat label="동기화 완료" value={job.syncedRows} tone="accent" />
            <SyncJobStat label="잔여" value={job.remainingRows} tone={job.remainingRows === 0 ? "accent" : "warning"} />
            <SyncJobStat label="이번 세션 처리" value={job.sessionProcessedCount} tone="neutral" />
          </div>

          <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-1 text-sm leading-6 sm:grid-cols-3">
            <dt className="text-[var(--text-secondary)]">현재 작업 번호</dt>
            <dd className="m-0 font-semibold tabular-nums text-[var(--text-primary)] sm:col-span-2">
              {job.sessionJobLabel}
              {job.autoContinuing ? " · 자동 후속 진행 중" : ""}
            </dd>
            <dt className="text-[var(--text-secondary)]">현재 작업 배치</dt>
            <dd className="m-0 font-semibold tabular-nums text-[var(--text-primary)] sm:col-span-2">{job.batchLabel}</dd>
            <dt className="text-[var(--text-secondary)]">현재 커서 / Sheet 최신 행</dt>
            <dd className="m-0 font-mono text-xs tabular-nums text-[var(--text-secondary)] sm:col-span-2">{job.cursorLabel}</dd>
            <dt className="text-[var(--text-secondary)]">세션 누적 삽입 / 갱신 / 제외</dt>
            <dd className="m-0 font-semibold tabular-nums text-[var(--text-primary)] sm:col-span-2">
              {job.sessionInsertedCount} / {job.sessionUpdatedCount} / {job.sessionSkippedCount}
            </dd>
            <dt className="text-[var(--text-secondary)]">실패 행 (재처리 필요)</dt>
            <dd className={`m-0 font-semibold sm:col-span-2 ${job.hasFailedRows ? "text-[var(--status-error)]" : "text-[var(--text-secondary)]"}`}>{job.failedRowsLabel}</dd>
            <dt className="text-[var(--text-secondary)]">마지막 처리 행</dt>
            <dd className="m-0 font-mono text-xs tabular-nums text-[var(--text-secondary)] sm:col-span-2">{job.lastRowLabel}</dd>
            <dt className="text-[var(--text-secondary)]">세션 시작 / 마지막 처리 / 종료</dt>
            <dd className="m-0 tabular-nums text-[var(--text-secondary)] sm:col-span-2">
              {job.sessionStartedAtLabel} · {job.lastTickAtLabel} · {job.finishedAtLabel}
            </dd>
            <dt className="text-[var(--text-secondary)]">자동 처리 상태</dt>
            <dd className={`m-0 font-semibold sm:col-span-2 ${job.pumpDelayed ? "text-[var(--status-warning)]" : "text-[var(--text-primary)]"}`}>
              {job.pumpStateLabel}
            </dd>
            <dt className="text-[var(--text-secondary)]">자동 처리 횟수 / 실행 만료 예정</dt>
            <dd className="m-0 tabular-nums text-[var(--text-secondary)] sm:col-span-2">
              {job.pumpAttemptLabel} · {job.leaseExpiresAtLabel}
            </dd>
            <dt className="text-[var(--text-secondary)]">안전 상한</dt>
            <dd className="m-0 text-[var(--text-secondary)] sm:col-span-2">{job.safetyLimitLabel}</dd>
          </dl>

          <p
            aria-live="polite"
            className="mt-4 flex items-center gap-2 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm leading-6 text-[var(--text-secondary)]"
            role="status"
          >
            {running ? <span aria-hidden className="inline-block size-3 animate-pulse rounded-full bg-[var(--accent-primary)]" /> : null}
            {job.noticeMessage}
          </p>
        </>
      )}
    </section>
  )
}

function SyncJobStat({ label, value, tone }: Readonly<{ label: string; value: number; tone: "accent" | "neutral" | "warning" }>) {
  const toneClass =
    tone === "accent" ? "text-[var(--accent-primary)]" : tone === "warning" ? "text-[var(--status-warning)]" : "text-[var(--text-primary)]"
  return (
    <article className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">{label}</p>
      <p className={`mt-3 font-mono text-3xl font-semibold tracking-[-0.01em] ${toneClass}`}>{value.toLocaleString("ko-KR")}</p>
    </article>
  )
}
