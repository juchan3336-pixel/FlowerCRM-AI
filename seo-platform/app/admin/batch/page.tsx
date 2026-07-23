import Link from "next/link"

import { formatBatchKstTime, summarizeRunForHistory } from "@/lib/batch/batch-view"
import { computeCoreMetrics, computeDurationMetrics, computeEventMetrics, type BatchCoreMetrics, type BatchDurationMetrics, type BatchEventMetrics } from "@/lib/batch/metrics"

export const dynamic = "force-dynamic"
export const maxDuration = 30

// 검증 소요(초): verified 페이지의 published_at → verification_checked_at (기존 데이터만으로 계산 가능한 지표).
async function loadVerifySeconds(): Promise<readonly number[]> {
  const { createSupabaseServiceRoleClient } = await import("@/lib/supabase/server")
  const client = createSupabaseServiceRoleClient()
  const { data, error } = await client.from("seo_pages").select("published_at, verification_checked_at").eq("verification_status", "verified")
  if (error !== null) {
    return []
  }
  return data
    .map((row) => (row.published_at !== null && row.verification_checked_at !== null ? (Date.parse(row.verification_checked_at) - Date.parse(row.published_at)) / 1000 : null))
    .filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0)
}

function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(0)}%`
}

function seconds(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}초`
}

// 표본 구성 표시 — 이벤트 기록이 있는 정밀 표본과, 이벤트 도입 이전이라 총 경과로 근사한 표본을 구분한다.
function sampleNote(samples: number, approximate: number): string {
  if (samples === 0) {
    return "(표본 없음)"
  }
  const precise = samples - approximate
  return approximate === 0 ? `(정밀 ${String(precise)}건)` : `(정밀 ${String(precise)}건 · 근사 ${String(approximate)}건)`
}

// Batch 운영 지표 보드 — 핵심 지표는 기존 데이터만으로, 이벤트 지표는 기록 도입 이후 배치부터 채워진다.
export function BatchMetricsBoard({ core, durations, eventMetrics }: Readonly<{ core: BatchCoreMetrics; durations: BatchDurationMetrics; eventMetrics: BatchEventMetrics }>) {
  const stepEntries = Object.entries(eventMetrics.avgStepSeconds)
  return (
    <section aria-label="Batch 운영 지표" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
      <h3 className="text-lg font-semibold text-[var(--text-primary)]">운영 지표</h3>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm leading-6 sm:grid-cols-4">
        <dt className="text-[var(--text-secondary)]">Batch 성공률</dt>
        <dd className="m-0 font-semibold">{percent(core.runSuccessRate)}</dd>
        <dt className="text-[var(--text-secondary)]">평균 자동 처리시간</dt>
        <dd className="m-0 font-semibold">
          {seconds(durations.avgAutoProcessingSeconds)}
          <span className="ml-1 text-xs font-normal text-[var(--text-secondary)]">{sampleNote(durations.autoProcessingSamples, durations.autoProcessingApproximateSamples)}</span>
        </dd>
        <dt className="text-[var(--text-secondary)]">평균 검토 대기시간</dt>
        <dd className="m-0 font-semibold">
          {durations.reviewWaitSamples === 0 ? "—" : seconds(durations.avgReviewWaitSeconds)}
          <span className="ml-1 text-xs font-normal text-[var(--text-secondary)]">
            {durations.reviewWaitSamples === 0 ? "(검토 대기로 처리된 장소 없음)" : `(${String(durations.reviewWaitSamples)}건)`}
            {durations.pendingReviewItems > 0 ? ` · 대기 중 ${String(durations.pendingReviewItems)}건` : ""}
          </span>
        </dd>
        <dt className="text-[var(--text-secondary)]">평균 총 경과시간</dt>
        <dd className="m-0 font-semibold">
          {seconds(durations.avgTotalElapsedSeconds)}
          <span className="ml-1 text-xs font-normal text-[var(--text-secondary)]">(검토 대기 포함)</span>
        </dd>
        <dt className="text-[var(--text-secondary)]">평균 비용(장소)</dt>
        <dd className="m-0 font-semibold">{core.avgCostUsd === null ? "—" : `$${core.avgCostUsd.toFixed(4)}`}</dd>
        <dt className="text-[var(--text-secondary)]">예상 대비 실제 비용</dt>
        <dd className="m-0 font-semibold">{percent(core.estimatedVsActualRatio)}</dd>
        <dt className="text-[var(--text-secondary)]">ready 전환율</dt>
        <dd className="m-0 font-semibold">{percent(core.readyRate)}</dd>
        <dt className="text-[var(--text-secondary)]">WARN / FAIL 비율</dt>
        <dd className="m-0 font-semibold">
          {percent(core.warnRate)} / {percent(core.failRate)}
        </dd>
        <dt className="text-[var(--text-secondary)]">게시 성공률</dt>
        <dd className="m-0 font-semibold">{percent(core.publishItemSuccessRate)}</dd>
        <dt className="text-[var(--text-secondary)]">verified 평균 시간</dt>
        <dd className="m-0 font-semibold">{seconds(core.avgVerifySeconds)}</dd>
      </dl>
      <div className="mt-4 border-t border-[var(--border-default)] pt-3">
        {eventMetrics.eventCount === 0 ? (
          <p className="text-xs leading-5 text-[var(--text-secondary)]">이벤트 기반 지표(중단·재개·취소·단계별 소요·검증 전이)는 이벤트 기록 도입 이후 실행되는 배치부터 집계됩니다.</p>
        ) : (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm leading-6 sm:grid-cols-4">
            <dt className="text-[var(--text-secondary)]">중단(interrupted)</dt>
            <dd className="m-0 font-semibold">{eventMetrics.interruptedCount}회</dd>
            <dt className="text-[var(--text-secondary)]">재개</dt>
            <dd className="m-0 font-semibold">{eventMetrics.resumeCount}회</dd>
            <dt className="text-[var(--text-secondary)]">취소 요청</dt>
            <dd className="m-0 font-semibold">{eventMetrics.cancelRequests}회</dd>
            <dt className="text-[var(--text-secondary)]">단계별 평균 소요</dt>
            <dd className="m-0 font-semibold">{stepEntries.length === 0 ? "—" : stepEntries.map(([step, avg]) => `${step} ${avg.toFixed(1)}s`).join(" · ")}</dd>
            <dt className="text-[var(--text-secondary)]">검증 전이</dt>
            <dd className="m-0 font-semibold">
              {Object.entries(eventMetrics.verificationTransitions).length === 0
                ? "—"
                : Object.entries(eventMetrics.verificationTransitions)
                    .map(([status, count]) => `${status} ${String(count)}`)
                    .join(" · ")}
            </dd>
          </dl>
        )}
      </div>
    </section>
  )
}

const STATUS_TONES: Record<string, string> = {
  running: "border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]",
  completed: "border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]",
  cancelled: "border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 text-[var(--status-warning)]",
  failed: "border-[var(--status-error)]/40 bg-[var(--status-error)]/10 text-[var(--status-error)]",
}

export default async function BatchHistoryPage() {
  const { createSupabaseBatchRepository } = await import("@/lib/batch/supabase-batch-repository")
  const repository = createSupabaseBatchRepository()
  const runs = await repository.listRuns(50)
  const [items, events, verifySeconds] = await Promise.all([
    repository.listItemsForRuns(runs.map((run) => run.id)),
    repository.listRecentEvents(1000),
    loadVerifySeconds(),
  ])
  const core = computeCoreMetrics(runs, items, verifySeconds)
  // 처리시간은 자동 처리·검토 대기·총 경과로 분리해 계산한다 (검토 대기가 자동 처리 평균을 왜곡하지 않도록).
  const durations = computeDurationMetrics(items, events)
  const eventMetrics = computeEventMetrics(events)

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

      <BatchMetricsBoard core={core} durations={durations} eventMetrics={eventMetrics} />

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
