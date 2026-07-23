import Link from "next/link"

import { formatBatchKstTime, summarizeRunForHistory } from "@/lib/batch/batch-view"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const STATUS_TONES: Record<string, string> = {
  running: "border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]",
  completed: "border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]",
  cancelled: "border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 text-[var(--status-warning)]",
  failed: "border-[var(--status-error)]/40 bg-[var(--status-error)]/10 text-[var(--status-error)]",
}

export default async function BatchHistoryPage() {
  const { createSupabaseBatchRepository } = await import("@/lib/batch/supabase-batch-repository")
  const runs = await createSupabaseBatchRepository().listRuns(50)

  return (
    <section aria-labelledby="batch-history-title" className="flex flex-col gap-6">
      <header className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">운영 · Batch</p>
        <div className="mt-2 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]" id="batch-history-title">
              Batch 이력
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">
              AI 일괄 생성·일괄 게시 실행 이력입니다. 행을 누르면 해당 배치의 진행·결과 화면으로 이동합니다. 사용자 확인 필요(needs_review)는 검토 가능한 콘텐츠 품질 문제, 실패(failed)는 시스템 오류·검증 불가를 뜻합니다.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              className="whitespace-nowrap rounded-full bg-[var(--accent-primary)] px-4 py-2 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90"
              href="/admin/batch/new"
            >
              AI 일괄 생성
            </Link>
            <Link
              className="whitespace-nowrap rounded-full border border-[var(--accent-primary)] px-4 py-2 text-sm font-semibold text-[var(--accent-primary)] transition-colors duration-150 hover:bg-[var(--accent-primary)]/10"
              href="/admin/batch/publish/new"
            >
              일괄 게시
            </Link>
          </div>
        </div>
      </header>

      <section aria-label="Batch 실행 이력" className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        {runs.length === 0 ? (
          <p className="p-6 text-sm leading-6 text-[var(--text-secondary)]">아직 실행된 배치가 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead className="bg-[var(--surface-secondary)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
                <tr>
                  <th className="px-5 py-3" scope="col">종류</th>
                  <th className="px-5 py-3" scope="col">상태</th>
                  <th className="px-5 py-3" scope="col">결과 요약</th>
                  <th className="px-5 py-3" scope="col">시작 (KST)</th>
                  <th className="px-5 py-3" scope="col">종료 (KST)</th>
                  <th className="px-5 py-3" scope="col">실행자</th>
                  <th className="px-5 py-3" scope="col">상세</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-default)]">
                {runs.map((run) => {
                  const view = summarizeRunForHistory(run)
                  return (
                    <tr key={run.id}>
                      <td className="whitespace-nowrap px-5 py-3 font-semibold text-[var(--text-primary)]">{view.kindLabel}</td>
                      <td className="px-5 py-3">
                        <span
                          className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
                            STATUS_TONES[run.status] ?? "border-[var(--status-error)]/40 bg-[var(--status-error)]/10 text-[var(--status-error)]"
                          }`}
                        >
                          {view.statusLabel}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-xs text-[var(--text-secondary)]">{view.summary}</td>
                      <td className="whitespace-nowrap px-5 py-3 font-mono text-xs">{formatBatchKstTime(run.started_at) ?? "—"}</td>
                      <td className="whitespace-nowrap px-5 py-3 font-mono text-xs">{formatBatchKstTime(run.finished_at) ?? "—"}</td>
                      <td className="px-5 py-3 text-xs text-[var(--text-secondary)]">{run.created_by ?? "—"}</td>
                      <td className="px-5 py-3">
                        <Link className="whitespace-nowrap text-sm font-semibold text-[var(--accent-primary)] hover:underline" href={`/admin/batch/${run.id}`}>
                          결과 보기 →
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  )
}
