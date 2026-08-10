import Link from "next/link"

import { loadSearchReportPageDetail, loadSearchReportSummary, type SearchReportPageDetail, type SearchReportSummary } from "@/lib/admin/search-report"

export const dynamic = "force-dynamic"

// GSC 검색 성과 리포트 — 페이지별 노출수·클릭·평균 순위·검색 결과 페이지 번호·순위 변화를 보여준다.
// 데이터는 하루 1회 Cron 동기화(search_performance_daily)이며 이 화면은 읽기 전용이다.
export default async function SearchReportPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const query = await searchParams
  const selectedPath = typeof query["path"] === "string" ? query["path"] : null

  let summary: SearchReportSummary | null = null
  let loadError: string | null = null
  try {
    summary = await loadSearchReportSummary()
  } catch {
    // migration 미적용·권한 등 — 화면은 안내로 강등하고 원인은 서버 로그로 확인한다.
    loadError = "검색 성과 테이블을 읽지 못했습니다. migration(202608070001)과 동기화 설정을 확인하세요."
  }

  let detail: SearchReportPageDetail | null = null
  if (summary?.latestDate != null && selectedPath !== null) {
    try {
      detail = await loadSearchReportPageDetail(selectedPath, summary.latestDate)
    } catch {
      detail = null
    }
  }

  return <SearchReportContent detail={detail} loadError={loadError} selectedPath={selectedPath} summary={summary} />
}

// 데이터 주입형 본문 — QA(qa-preview)·테스트에서 fixture로 직접 렌더할 수 있게 조회와 분리한다 (AdminSitemapContent 패턴).
export function SearchReportContent({
  summary,
  detail,
  selectedPath,
  loadError,
}: Readonly<{ summary: SearchReportSummary | null; detail: SearchReportPageDetail | null; selectedPath: string | null; loadError: string | null }>) {
  return (
    <section aria-labelledby="search-report-title" className="flex flex-col gap-6">
      <header className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">SEO · 검색 노출</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]" id="search-report-title">
          검색 노출 리포트
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">
          Google Search Console 지표를 하루 1회 동기화해 페이지별 노출수·클릭수·평균 순위와 순위 변화를 보여줍니다. Google 데이터는 2~3일
          지연되며, 최근 5일 지표는 잠정치가 이후 확정치로 갱신됩니다.
        </p>
        {summary?.latestDate != null ? (
          <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">
            기준일 <span className="font-mono font-semibold text-[var(--text-primary)]">{summary.latestDate}</span> (가장 최근 동기화된 날짜)
          </p>
        ) : null}
      </header>

      {loadError !== null ? (
        <p className="rounded-3xl border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 p-4 text-sm leading-6 text-[var(--text-primary)]">{loadError}</p>
      ) : null}

      {summary !== null && summary.latestDate === null ? (
        <section className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6 text-sm leading-6 text-[var(--text-secondary)]">
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">아직 동기화된 데이터가 없습니다</h3>
          <ol className="mt-3 list-decimal pl-5">
            <li>Google Cloud에서 서비스 계정을 만들고 JSON 키를 발급합니다.</li>
            <li>Search Console 속성에 서비스 계정 이메일을 사용자로 추가합니다.</li>
            <li>
              Vercel 환경변수 <code className="font-mono text-xs">GSC_CLIENT_EMAIL · GSC_PRIVATE_KEY · GSC_SITE_URL · SEARCH_REPORT_SYNC_SECRET</code>
              를 등록하고 재배포합니다.
            </li>
            <li>
              Supabase에서 migration과 <code className="font-mono text-xs">search_report_sync_cron.sql</code>을 적용하면 매일 09:30(KST)에 자동
              동기화됩니다.
            </li>
          </ol>
        </section>
      ) : null}

      {summary !== null && summary.latestDate !== null ? (
        <>
          <section aria-label="집계" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <SummaryTile label="집계 페이지" value={summary.pages.length.toLocaleString("ko-KR")} />
            <SummaryTile label="노출수 (기준일)" value={summary.totalImpressions.toLocaleString("ko-KR")} />
            <SummaryTile label="클릭수 (기준일)" value={summary.totalClicks.toLocaleString("ko-KR")} />
          </section>

          <section aria-label="페이지별 검색 성과" className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
            <div className="border-b border-[var(--border-default)] p-5">
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">페이지별 검색 성과</h3>
              <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
                노출수 순 상위 {summary.pages.length}개. 순위 변화는 양수가 상승입니다. 페이지를 클릭하면 일별 추이와 상위 검색어가 열립니다.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                <thead className="bg-[var(--surface-secondary)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
                  <tr>
                    <th className="px-5 py-3" scope="col">페이지</th>
                    <th className="px-5 py-3 text-right" scope="col">노출수</th>
                    <th className="px-5 py-3 text-right" scope="col">클릭수</th>
                    <th className="px-5 py-3 text-right" scope="col">평균 순위</th>
                    <th className="px-5 py-3 text-right" scope="col">노출 페이지</th>
                    <th className="px-5 py-3 text-right" scope="col">전일 대비</th>
                    <th className="px-5 py-3 text-right" scope="col">7일 대비</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-default)]">
                  {summary.pages.map((row) => (
                    <tr className={row.pagePath === selectedPath ? "bg-[var(--accent-primary)]/5" : undefined} key={row.pagePath}>
                      <td className="max-w-[340px] truncate px-5 py-3 font-mono text-xs">
                        <Link className="text-[var(--accent-primary)] hover:underline" href={`/admin/search-report?path=${encodeURIComponent(row.pagePath)}`}>
                          {row.pagePath}
                        </Link>
                      </td>
                      <td className="px-5 py-3 text-right">{row.impressions.toLocaleString("ko-KR")}</td>
                      <td className="px-5 py-3 text-right">{row.clicks.toLocaleString("ko-KR")}</td>
                      <td className="px-5 py-3 text-right font-mono text-xs">{row.position.toFixed(1)}</td>
                      <td className="px-5 py-3 text-right">{row.resultPage > 0 ? `${String(row.resultPage)}p` : "—"}</td>
                      <td className="px-5 py-3 text-right"><DeltaBadge delta={row.deltaFromPreviousDay} /></td>
                      <td className="px-5 py-3 text-right"><DeltaBadge delta={row.deltaFromWeekAgo} /></td>
                    </tr>
                  ))}
                  {summary.pages.length === 0 ? (
                    <tr>
                      <td className="px-5 py-6 text-sm text-[var(--text-secondary)]" colSpan={7}>
                        기준일에 노출된 페이지가 없습니다. 색인 초기에는 정상입니다.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          {detail !== null ? <PageDetailSection detail={detail} /> : null}
        </>
      ) : null}
    </section>
  )
}

function PageDetailSection({ detail }: Readonly<{ detail: SearchReportPageDetail }>) {
  return (
    <section aria-label={`${detail.pagePath} 상세`} className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
      <div className="border-b border-[var(--border-default)] p-5">
        <h3 className="text-lg font-semibold text-[var(--text-primary)]">
          페이지 상세 <span className="font-mono text-sm text-[var(--text-secondary)]">{detail.pagePath}</span>
        </h3>
        <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">최근 28일 일별 추이와 기준일 상위 검색어입니다.</p>
      </div>
      <div className="grid gap-0 lg:grid-cols-2 lg:divide-x lg:divide-[var(--border-default)]">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-[var(--surface-secondary)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
              <tr>
                <th className="px-5 py-3" scope="col">날짜</th>
                <th className="px-5 py-3 text-right" scope="col">노출수</th>
                <th className="px-5 py-3 text-right" scope="col">클릭수</th>
                <th className="px-5 py-3 text-right" scope="col">평균 순위</th>
                <th className="px-5 py-3 text-right" scope="col">노출 페이지</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-default)]">
              {[...detail.daily].reverse().map((row) => (
                <tr key={row.date}>
                  <td className="px-5 py-2.5 font-mono text-xs">{row.date}</td>
                  <td className="px-5 py-2.5 text-right">{row.impressions.toLocaleString("ko-KR")}</td>
                  <td className="px-5 py-2.5 text-right">{row.clicks.toLocaleString("ko-KR")}</td>
                  <td className="px-5 py-2.5 text-right font-mono text-xs">{row.position.toFixed(1)}</td>
                  <td className="px-5 py-2.5 text-right">{row.resultPage > 0 ? `${String(row.resultPage)}p` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="overflow-x-auto border-t border-[var(--border-default)] lg:border-t-0">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-[var(--surface-secondary)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
              <tr>
                <th className="px-5 py-3" scope="col">검색어 (기준일)</th>
                <th className="px-5 py-3 text-right" scope="col">노출수</th>
                <th className="px-5 py-3 text-right" scope="col">클릭수</th>
                <th className="px-5 py-3 text-right" scope="col">평균 순위</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-default)]">
              {detail.topQueries.map((row) => (
                <tr key={row.query}>
                  <td className="max-w-[260px] truncate px-5 py-2.5">{row.query}</td>
                  <td className="px-5 py-2.5 text-right">{row.impressions.toLocaleString("ko-KR")}</td>
                  <td className="px-5 py-2.5 text-right">{row.clicks.toLocaleString("ko-KR")}</td>
                  <td className="px-5 py-2.5 text-right font-mono text-xs">{row.position.toFixed(1)}</td>
                </tr>
              ))}
              {detail.topQueries.length === 0 ? (
                <tr>
                  <td className="px-5 py-6 text-sm text-[var(--text-secondary)]" colSpan={4}>
                    기준일에 잡힌 검색어가 없습니다.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

// 순위 변화 표시 — 양수(상승)는 강조, 음수(하락)는 경고 톤.
function DeltaBadge({ delta }: Readonly<{ delta: number | null }>) {
  if (delta === null) {
    return <span className="text-xs text-[var(--text-secondary)]">—</span>
  }
  if (delta === 0) {
    return <span className="text-xs text-[var(--text-secondary)]">0</span>
  }
  const rising = delta > 0
  return (
    <span className={`text-xs font-semibold ${rising ? "text-[var(--accent-primary)]" : "text-[var(--status-warning)]"}`}>
      {rising ? "▲" : "▼"} {Math.abs(delta).toFixed(1)}
    </span>
  )
}

function SummaryTile({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">{label}</p>
      <p className="mt-2 text-xl font-semibold text-[var(--text-primary)]">{value}</p>
    </div>
  )
}
