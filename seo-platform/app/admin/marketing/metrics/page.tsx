import Link from "next/link"

import { Field, INPUT_CLASS, PageHeader, Panel, PRIMARY_BUTTON_CLASS, ResultBanner, SetupNotice } from "@/components/admin/marketing/ui"
import { DESTINATION_LABEL, METRIC_SOURCE_LABEL, metricsByDestination, rowsForTotals, sumMetrics, type MetricsTotals } from "@/lib/marketing/admin-view"
import type { MarketingCampaignRow, MarketingChannelRow, MarketingMetricsDailyRow } from "@/types/database"

import { recordMetricsAction } from "../actions"

export const dynamic = "force-dynamic"

const RANGE_DAYS = 30

export type MetricsPageData = {
  readonly rows: readonly MarketingMetricsDailyRow[]
  readonly campaigns: readonly MarketingCampaignRow[]
  readonly channels: readonly MarketingChannelRow[]
  readonly from: string
  readonly to: string
}

// 한국 날짜(YYYY-MM-DD) — 서버 시간대와 무관하게 KST 기준으로 자른다.
function kstDate(offsetDays: number): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date(Date.now() + offsetDays * 86_400_000))
}

// 성과 기록·조회 — 쇼핑몰 통계와 광고비를 날짜별로 직접 입력하고 최근 30일을 본다.
export default async function MarketingMetricsPage({ searchParams }: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const query = await searchParams
  const from = kstDate(-(RANGE_DAYS - 1))
  const to = kstDate(0)

  let data: MetricsPageData | null = null
  try {
    const { createSupabaseMarketingRepository } = await import("@/lib/marketing/supabase-repository")
    const repo = createSupabaseMarketingRepository()
    const [rows, campaigns, channels] = await Promise.all([repo.listMetrics({ from, to }), repo.listCampaigns(), repo.listChannels()])
    data = { rows, campaigns, channels, from, to }
  } catch (cause) {
    console.error("[marketing] metrics load failed", { message: cause instanceof Error ? cause.message : String(cause) })
  }

  return (
    <MarketingMetricsContent
      data={data}
      error={typeof query["error"] === "string" ? query["error"] : null}
      notice={typeof query["notice"] === "string" ? query["notice"] : null}
    />
  )
}

function won(value: number | null): string {
  return value === null ? "미수집" : `${value.toLocaleString("ko-KR")}원`
}

function count(value: number | null): string {
  return value === null ? "미수집" : value.toLocaleString("ko-KR")
}

function TotalsCard({ title, totals }: Readonly<{ title: string; totals: MetricsTotals }>) {
  return (
    <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4">
      <p className="text-sm font-semibold text-[var(--text-primary)]">{title}</p>
      <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-xs text-[var(--text-secondary)]">방문</dt>
          <dd className="mt-1 font-semibold tabular-nums text-[var(--text-primary)]">{count(totals.visits)}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--text-secondary)]">주문</dt>
          <dd className="mt-1 font-semibold tabular-nums text-[var(--text-primary)]">{count(totals.orders)}</dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--text-secondary)]">매출</dt>
          <dd className="mt-1 font-semibold tabular-nums text-[var(--text-primary)]">{won(totals.revenueKrw)}</dd>
        </div>
      </dl>
    </div>
  )
}

export function MarketingMetricsContent({ data, notice, error }: Readonly<{ data: MetricsPageData | null; notice: string | null; error: string | null }>) {
  if (data === null) {
    return (
      <section className="flex flex-col gap-6">
        <ResultBanner error={error} notice={notice} />
        <SetupNotice />
      </section>
    )
  }
  const byDestination = metricsByDestination(data.rows)
  const all = sumMetrics(rowsForTotals(data.rows))
  const campaignName = (id: string | null): string => (id === null ? "—" : (data.campaigns.find((campaign) => campaign.id === id)?.name ?? "—"))
  const channelLabel = (code: string | null): string => (code === null ? "—" : (data.channels.find((channel) => channel.code === code)?.label ?? code))

  return (
    <section aria-labelledby="metrics-title" className="flex flex-col gap-6">
      <PageHeader eyebrow="광고 배포 · 성과" title="성과 기록" titleId="metrics-title">
        <p>
          스마트스토어·자사몰 통계 화면에서 본 방문·주문·매출과 광고비, 글 작성에 든 시간을 날짜별로 적어 둡니다. 같은 날짜·출처·대상으로 다시 저장하면 새 값으로
          바뀝니다. 비워 둔 칸은 0이 아니라 &lsquo;미수집&rsquo;으로 남습니다.
        </p>
        <p className="mt-2">
          <Link className="font-semibold text-[var(--accent-primary)] hover:underline" href="/admin/marketing">
            ← 캠페인 목록
          </Link>
        </p>
      </PageHeader>

      <ResultBanner error={error} notice={notice} />

      <Panel
        description={`${data.from} ~ ${data.to} · 두 쇼핑몰은 집계 기준이 달라 따로 보여줍니다. 같은 날짜·출처에 전체 수치와 캠페인별 수치를 함께 적었다면 전체 수치만 합계에 씁니다.`}
        title="최근 30일 합계"
      >
        <div className="grid gap-3 p-5 sm:grid-cols-2">
          <TotalsCard title={DESTINATION_LABEL.smartstore} totals={byDestination.smartstore} />
          <TotalsCard title={DESTINATION_LABEL.imweb} totals={byDestination.imweb} />
        </div>
        <p className="border-t border-[var(--border-default)] px-5 py-4 text-sm leading-6 text-[var(--text-primary)]">
          광고비 합계 <span className="font-semibold tabular-nums">{won(all.adCostKrw)}</span> · 운영 시간 합계{" "}
          <span className="font-semibold tabular-nums">{all.workMinutes === null ? "미수집" : `${all.workMinutes.toLocaleString("ko-KR")}분`}</span>
        </p>
      </Panel>

      <Panel description="수치는 하나 이상만 입력하면 됩니다." title="성과 입력">
        <form action={recordMetricsAction} className="grid gap-4 p-5 sm:grid-cols-3">
          <Field label="날짜">
            <input className={INPUT_CLASS} defaultValue={data.to} max={data.to} name="date" required type="date" />
          </Field>
          <Field label="출처">
            <select className={INPUT_CLASS} name="source" required>
              {(["smartstore_report", "imweb_report", "naver_ads_report", "google_ads_report", "manual"] as const).map((source) => (
                <option key={source} value={source}>
                  {METRIC_SOURCE_LABEL[source]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="주문 목적지">
            <select className={INPUT_CLASS} defaultValue="" name="destination">
              <option value="">해당 없음</option>
              <option value="smartstore">{DESTINATION_LABEL.smartstore}</option>
              <option value="imweb">{DESTINATION_LABEL.imweb}</option>
            </select>
          </Field>
          <Field label="채널 (선택)">
            <select className={INPUT_CLASS} defaultValue="" name="channel">
              <option value="">전체</option>
              {data.channels.map((channel) => (
                <option key={channel.code} value={channel.code}>
                  {channel.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="캠페인 (선택)">
            <select className={INPUT_CLASS} defaultValue="" name="campaignId">
              <option value="">전체</option>
              {data.campaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.name}
                </option>
              ))}
            </select>
          </Field>
          <Field hint="예: 유입 후 7일 기준, 취소 반영" label="메모 (선택)">
            <input className={INPUT_CLASS} maxLength={200} name="note" type="text" />
          </Field>
          <Field label="방문 수">
            <input className={INPUT_CLASS} inputMode="numeric" name="visits" pattern="[0-9,]*" type="text" />
          </Field>
          <Field label="주문 수">
            <input className={INPUT_CLASS} inputMode="numeric" name="orders" pattern="[0-9,]*" type="text" />
          </Field>
          <Field hint="취소·환불을 뺀 금액(원)" label="매출">
            <input className={INPUT_CLASS} inputMode="numeric" name="revenueKrw" pattern="[0-9,]*" type="text" />
          </Field>
          <Field hint="원" label="광고비">
            <input className={INPUT_CLASS} inputMode="numeric" name="adCostKrw" pattern="[0-9,]*" type="text" />
          </Field>
          <Field hint="글 작성·게시에 든 시간(분)" label="운영 시간">
            <input className={INPUT_CLASS} inputMode="numeric" name="workMinutes" pattern="[0-9,]*" type="text" />
          </Field>
          <div className="flex items-end">
            <button className={PRIMARY_BUTTON_CLASS} type="submit">
              저장
            </button>
          </div>
        </form>
      </Panel>

      <Panel title="기록 내역">
        {data.rows.length === 0 ? (
          <p className="p-5 text-sm leading-6 text-[var(--text-secondary)]">최근 30일에 기록한 성과가 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] border-collapse text-left text-sm">
              <thead className="bg-[var(--surface-secondary)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
                <tr>
                  <th className="px-5 py-3" scope="col">날짜</th>
                  <th className="px-5 py-3" scope="col">출처</th>
                  <th className="px-5 py-3" scope="col">목적지</th>
                  <th className="px-5 py-3" scope="col">채널</th>
                  <th className="px-5 py-3" scope="col">캠페인</th>
                  <th className="px-5 py-3 text-right" scope="col">방문</th>
                  <th className="px-5 py-3 text-right" scope="col">주문</th>
                  <th className="px-5 py-3 text-right" scope="col">매출</th>
                  <th className="px-5 py-3 text-right" scope="col">광고비</th>
                  <th className="px-5 py-3 text-right" scope="col">운영(분)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-default)]">
                {data.rows.map((row) => (
                  <tr key={row.id}>
                    <td className="whitespace-nowrap px-5 py-3 font-mono text-xs">{row.date}</td>
                    <td className="px-5 py-3">{METRIC_SOURCE_LABEL[row.source]}</td>
                    <td className="px-5 py-3">{row.destination_code === null ? "—" : DESTINATION_LABEL[row.destination_code]}</td>
                    <td className="px-5 py-3">{channelLabel(row.channel_code)}</td>
                    <td className="px-5 py-3">{campaignName(row.campaign_id)}</td>
                    <td className="px-5 py-3 text-right tabular-nums">{count(row.visits)}</td>
                    <td className="px-5 py-3 text-right tabular-nums">{count(row.orders)}</td>
                    <td className="px-5 py-3 text-right tabular-nums">{won(row.revenue_krw)}</td>
                    <td className="px-5 py-3 text-right tabular-nums">{won(row.ad_cost_krw)}</td>
                    <td className="px-5 py-3 text-right tabular-nums">{count(row.work_minutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </section>
  )
}
