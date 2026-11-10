import Link from "next/link"

import { Field, INPUT_CLASS, PageHeader, Panel, PRIMARY_BUTTON_CLASS, ResultBanner, SECONDARY_BUTTON_CLASS, SetupNotice } from "@/components/admin/marketing/ui"
import { DESTINATION_LABEL, loadMarketingOverview, MODE_LABEL, type MarketingOverview } from "@/lib/marketing/admin-view"

import { createCampaignAction, saveChannelAction } from "./actions"

export const dynamic = "force-dynamic"

// 광고 배포 — 전체 현황. 주문 목적지 2곳, 배포 채널, 캠페인 목록과 새 캠페인 만들기.
export default async function MarketingPage({ searchParams }: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const query = await searchParams
  const notice = typeof query["notice"] === "string" ? query["notice"] : null
  const error = typeof query["error"] === "string" ? query["error"] : null

  let overview: MarketingOverview | null = null
  try {
    const { createSupabaseMarketingRepository } = await import("@/lib/marketing/supabase-repository")
    overview = await loadMarketingOverview(createSupabaseMarketingRepository())
  } catch (cause) {
    // migration 미적용·환경 변수 누락 등 — 화면은 적용 안내로 강등하고 원인은 서버 로그로 확인한다.
    console.error("[marketing] overview load failed", { message: cause instanceof Error ? cause.message : String(cause) })
  }

  return <MarketingOverviewContent error={error} notice={notice} overview={overview} />
}

// 데이터 주입형 본문 — 조회와 분리해 테스트·QA에서 고정 데이터로 직접 렌더한다.
export function MarketingOverviewContent({ overview, notice, error }: Readonly<{ overview: MarketingOverview | null; notice: string | null; error: string | null }>) {
  return (
    <section aria-labelledby="marketing-title" className="flex flex-col gap-6">
      <PageHeader eyebrow="광고 배포" title="화환 광고 배포" titleId="marketing-title">
        <p>
          채널별 글을 작성해 검수·승인한 뒤, 추적 링크가 붙은 게시 패키지를 복사해 직접 올리고 올린 글의 주소를 기록합니다. 주문 링크는 자사몰과
          스마트스토어 두 곳을 쓸 수 있습니다.
        </p>
        <p className="mt-2">
          <Link className="font-semibold text-[var(--accent-primary)] hover:underline" href="/admin/marketing/metrics">
            성과 기록·조회로 이동
          </Link>
        </p>
      </PageHeader>

      <ResultBanner error={error} notice={notice} />

      {overview === null ? (
        <SetupNotice />
      ) : (
        <>
          <Panel description="소재마다 주문 링크는 하나만 들어갑니다. 채널 기본값을 쓰거나 소재를 만들 때 직접 고릅니다." title="주문 목적지">
            <ul className="grid gap-3 p-5 sm:grid-cols-2">
              {overview.destinations.map((destination) => (
                <li className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4" key={destination.code}>
                  <p className="text-sm font-semibold text-[var(--text-primary)]">{destination.label}</p>
                  <p className="mt-1 break-all font-mono text-xs text-[var(--text-secondary)]">{destination.base_url}</p>
                  <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">
                    {destination.code === "smartstore" ? "네이버 계열 채널의 기본 목적지 · 네이버 유입 파라미터(nt_)로 추적" : "그 밖의 채널의 기본 목적지 · UTM으로 추적"}
                  </p>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel description="아직 캠페인이 없다면 아래에서 먼저 하나 만드세요. 캠페인 하나는 '무엇을 알릴지'(예: 근조 주문 준비 안내)에 해당합니다." title="캠페인">
            {overview.campaigns.length === 0 ? (
              <p className="p-5 text-sm leading-6 text-[var(--text-secondary)]">아직 만든 캠페인이 없습니다.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                  <thead className="bg-[var(--surface-secondary)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
                    <tr>
                      <th className="px-5 py-3" scope="col">캠페인</th>
                      <th className="px-5 py-3" scope="col">종류</th>
                      <th className="px-5 py-3 text-right" scope="col">소재</th>
                      <th className="px-5 py-3 text-right" scope="col">게시 대기</th>
                      <th className="px-5 py-3 text-right" scope="col">게시됨</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-default)]">
                    {overview.campaigns.map(({ campaign, variantCount, waitingCount, postedCount }) => (
                      <tr key={campaign.id}>
                        <td className="px-5 py-3">
                          <Link className="font-semibold text-[var(--accent-primary)] hover:underline" href={`/admin/marketing/${campaign.id}`}>
                            {campaign.name}
                          </Link>
                          <p className="mt-0.5 font-mono text-xs text-[var(--text-secondary)]">{campaign.code}</p>
                        </td>
                        <td className="px-5 py-3">{MODE_LABEL[campaign.mode]}</td>
                        <td className="px-5 py-3 text-right tabular-nums">{variantCount}</td>
                        <td className="px-5 py-3 text-right tabular-nums">{waitingCount}</td>
                        <td className="px-5 py-3 text-right tabular-nums">{postedCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <form action={createCampaignAction} className="grid gap-4 border-t border-[var(--border-default)] p-5 sm:grid-cols-2">
              <p className="text-sm font-semibold text-[var(--text-primary)] sm:col-span-2">새 캠페인 만들기</p>
              <Field label="캠페인 이름">
                <input className={INPUT_CLASS} maxLength={80} name="name" placeholder="예: 근조화환 주문 준비 안내" required type="text" />
              </Field>
              <Field hint="추적 링크에 들어갑니다. 영문·숫자·하이픈·밑줄만, 예: condolence-guide-01" label="캠페인 코드">
                <input className={`${INPUT_CLASS} font-mono`} maxLength={50} name="code" pattern="[A-Za-z0-9_\-]{1,50}" placeholder="condolence-guide-01" required type="text" />
              </Field>
              <Field hint="근조 글에 축하 표현이 섞이지 않도록 종류별로 다른 검사를 합니다." label="종류">
                <select className={INPUT_CLASS} defaultValue="condolence" name="mode">
                  <option value="condolence">{MODE_LABEL.condolence}</option>
                  <option value="celebration">{MODE_LABEL.celebration}</option>
                  <option value="corporate-celebration">{MODE_LABEL["corporate-celebration"]}</option>
                </select>
              </Field>
              <Field hint="선택 사항" label="지역">
                <input className={INPUT_CLASS} maxLength={40} name="region" placeholder="예: 경남" type="text" />
              </Field>
              <Field hint="비워 두면 스토어 홈으로 보냅니다." label="스마트스토어 상품 주소 (선택)">
                <input className={INPUT_CLASS} name="productUrl_smartstore" placeholder="https://smartstore.naver.com/free77888/products/…" type="url" />
              </Field>
              <Field hint="비워 두면 자사몰 첫 화면으로 보냅니다." label="자사몰 상품 주소 (선택)">
                <input className={INPUT_CLASS} name="productUrl_imweb" placeholder="https://팔도플라워.com/…" type="text" />
              </Field>
              <div className="sm:col-span-2">
                <button className={PRIMARY_BUTTON_CLASS} type="submit">
                  캠페인 만들기
                </button>
              </div>
            </form>
          </Panel>

          <Panel
            description="1차는 네이버 3개 채널입니다. 모든 채널은 사람이 직접 글을 올리는 방식이며, 계정 이름을 적어 두면 어느 계정으로 올렸는지 기록에 남습니다."
            id="channels"
            title="배포 채널"
          >
            <ul className="divide-y divide-[var(--border-default)]">
              {overview.channels.map((channel) => (
                <li className="p-5" key={channel.code}>
                  <form action={saveChannelAction} className="grid items-end gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                    <input name="channel" type="hidden" value={channel.code} />
                    <div>
                      <p className="text-sm font-semibold text-[var(--text-primary)]">
                        {channel.label}
                        <span className="ml-2 rounded-full border border-[var(--border-default)] px-2 py-0.5 text-xs font-semibold text-[var(--text-secondary)]">
                          {channel.tier === "primary" ? "1차" : "2차"}
                        </span>
                      </p>
                      <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
                        기본 주문 목적지 {DESTINATION_LABEL[channel.default_destination_code]} · {channel.medium === "cpc" ? "유료 광고" : "글 게시"}
                      </p>
                    </div>
                    <Field label="게시 계정 (선택)">
                      <input className={INPUT_CLASS} defaultValue={channel.account_ref ?? ""} maxLength={100} name="accountRef" placeholder="예: paldo-blog" type="text" />
                    </Field>
                    <Field label="배포">
                      <select className={INPUT_CLASS} defaultValue={channel.publish_mode === "disabled" ? "disabled" : "manual"} name="publishMode">
                        <option value="manual">사용 (직접 게시)</option>
                        <option value="disabled">중지</option>
                      </select>
                    </Field>
                    <button className={SECONDARY_BUTTON_CLASS} type="submit">
                      저장
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </Panel>
        </>
      )}
    </section>
  )
}
