import type { SyncCoverageStatus } from "@/lib/admin/sync"

export function SyncCoverageCard({ coverage }: Readonly<{ coverage: SyncCoverageStatus }>) {
  return (
    <section aria-labelledby="sync-coverage-title" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
      <h3 id="sync-coverage-title" className="text-lg font-semibold text-[var(--text-primary)]">
        가져오기 범위
      </h3>
      <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
        누락된 Sheet 행으로 건너뛴 행이나 형식이 잘못된 원본 행을 찾아 최종 SEO 게시 전에 수정합니다.
      </p>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <CoverageMetric label="가져온 장소" value={String(coverage.importedPlaces)} />
        <CoverageMetric label="최신 Sheet 행" value={coverage.latestSourceRowNumber === null ? "없음" : String(coverage.latestSourceRowNumber)} />
        <CoverageMetric label="진행 중 실행" value={String(coverage.openRunningRuns)} />
      </div>
      <p className="mt-4 text-sm leading-6 text-[var(--text-secondary)]">
        누락 행 미리보기: {coverage.missingSourceRows.length === 0 ? "최신 가져오기 행 전에는 누락이 감지되지 않음" : coverage.missingSourceRows.join(", ")}
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
