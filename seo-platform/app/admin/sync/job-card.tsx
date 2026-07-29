import { resumeSyncJobAction, startSyncJobAction } from "./actions"
import { SyncJobStartButton, SyncJobResumeButton } from "./job-buttons"
import type { SyncJobView } from "@/lib/admin/sync-job-view"

// 자동 연속 동기화 진행 카드 — 시트 전체·동기화 완료·잔여·배치 진행·누적 집계를 한 화면에 모은다.
export function SyncJobCard({ job }: Readonly<{ job: SyncJobView | null }>) {
  return (
    <section aria-labelledby="sync-job-title" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 id="sync-job-title" className="text-lg font-semibold text-[var(--text-primary)]">
            신규 데이터 자동 연속 동기화
          </h3>
          <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
            버튼을 한 번 누르면 서버가 50건 단위로 잔여 신규 행을 모두 따라잡습니다. 화면을 닫아도 계속 진행됩니다.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {job !== null ? (
            <span className="w-fit rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">
              {job.statusLabel}
            </span>
          ) : null}
          <form action={startSyncJobAction}>
            <SyncJobStartButton active={job?.active ?? false} />
          </form>
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
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <SyncJobStat label="시트 전체 데이터" value={job.sheetDataRows} tone="neutral" />
            <SyncJobStat label="동기화 완료" value={job.syncedRows} tone="accent" />
            <SyncJobStat label="잔여" value={job.remainingRows} tone={job.remainingRows === 0 ? "accent" : "warning"} />
          </div>

          <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-1 text-sm leading-6 sm:grid-cols-3">
            <dt className="text-[var(--text-secondary)]">현재 배치</dt>
            <dd className="m-0 font-semibold tabular-nums text-[var(--text-primary)] sm:col-span-2">{job.batchLabel}</dd>
            <dt className="text-[var(--text-secondary)]">이번 실행 처리</dt>
            <dd className="m-0 font-semibold tabular-nums text-[var(--text-primary)] sm:col-span-2">{job.processedCount}건</dd>
            <dt className="text-[var(--text-secondary)]">누적 삽입 / 갱신 / 제외 / 실패</dt>
            <dd className="m-0 font-semibold tabular-nums text-[var(--text-primary)] sm:col-span-2">
              {job.insertedCount} / {job.updatedCount} / {job.skippedCount} / {job.failedCount}
            </dd>
            <dt className="text-[var(--text-secondary)]">마지막 처리 행</dt>
            <dd className="m-0 font-mono text-xs tabular-nums text-[var(--text-secondary)] sm:col-span-2">{job.lastRowLabel}</dd>
            <dt className="text-[var(--text-secondary)]">시작 / 마지막 갱신 / 종료</dt>
            <dd className="m-0 tabular-nums text-[var(--text-secondary)] sm:col-span-2">
              {job.startedAtLabel} · {job.lastTickAtLabel} · {job.finishedAtLabel}
            </dd>
          </dl>

          <p
            aria-live="polite"
            className="mt-4 flex items-center gap-2 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm leading-6 text-[var(--text-secondary)]"
            role="status"
          >
            {job.active ? <span aria-hidden className="inline-block size-3 animate-pulse rounded-full bg-[var(--accent-primary)]" /> : null}
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
