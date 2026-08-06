import { CONTENT_MODE_LABELS } from "@/lib/batch/candidate-policy"
import type { CategoryBreakdown } from "@/lib/admin/category-breakdown"

// 업종별 수집량과 실제 공개 수를 나란히 본다 — 어디에 데이터가 쏠려 있고 어디가 배포되고 있는지.
export function CategoryBreakdownSection({ breakdown }: Readonly<{ breakdown: CategoryBreakdown }>) {
  const supportedShare = breakdown.totalPlaces === 0 ? 0 : Math.round((breakdown.supportedTotal / breakdown.totalPlaces) * 100)

  return (
    <section aria-labelledby="category-breakdown-title" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]" id="category-breakdown-title">
          업종별 현황
        </h3>
        <p className="text-sm leading-6 text-[var(--text-secondary)]">
          수집 {breakdown.totalPlaces.toLocaleString("ko-KR")}곳 중 콘텐츠 생성이 가능한 업종은{" "}
          <strong className="text-[var(--text-primary)]">{breakdown.supportedTotal.toLocaleString("ko-KR")}곳({supportedShare}%)</strong>,
          현재 공개된 페이지는 <strong className="text-[var(--text-primary)]">{breakdown.totalPublished.toLocaleString("ko-KR")}곳</strong>입니다.
        </p>
      </div>

      <div className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead className="bg-[var(--surface-secondary)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
              <tr>
                <th className="px-5 py-3" scope="col">업종</th>
                <th className="px-5 py-3" scope="col">콘텐츠 모드</th>
                <th className="px-5 py-3 text-right" scope="col">수집</th>
                <th className="px-5 py-3 text-right" scope="col">확인 완료</th>
                <th className="px-5 py-3 text-right" scope="col">공개됨</th>
                <th className="px-5 py-3 text-right" scope="col">공개 비율</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-default)]">
              {breakdown.rows.map((row) => {
                const share = row.total === 0 ? 0 : Math.round((row.published / row.total) * 1000) / 10
                return (
                  <tr className="text-[var(--text-primary)]" key={row.category}>
                    <td className="px-5 py-3 font-semibold">{row.category}</td>
                    <td className="px-5 py-3">
                      {row.contentMode === null ? (
                        <span className="whitespace-nowrap rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-2.5 py-0.5 text-xs font-semibold text-[var(--text-secondary)]">
                          미지원
                        </span>
                      ) : (
                        <span className="whitespace-nowrap rounded-full border border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 px-2.5 py-0.5 text-xs font-semibold text-[var(--accent-primary)]">
                          {CONTENT_MODE_LABELS[row.contentMode]}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums">{row.total.toLocaleString("ko-KR")}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-[var(--text-secondary)]">{row.verified.toLocaleString("ko-KR")}</td>
                    <td className="px-5 py-3 text-right font-semibold tabular-nums">{row.published.toLocaleString("ko-KR")}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-[var(--text-secondary)]">{row.published === 0 ? "-" : `${String(share)}%`}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}
