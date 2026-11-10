import Link from "next/link"
import { notFound } from "next/navigation"

import { CopyButton } from "@/components/admin/marketing/copy-button"
import { OrderBanner } from "@/components/admin/marketing/order-banner"
import { Field, INPUT_CLASS, PageHeader, Panel, PRIMARY_BUTTON_CLASS, ResultBanner, SECONDARY_BUTTON_CLASS, SetupNotice, StatusBadge } from "@/components/admin/marketing/ui"
import { formatKstDateTime } from "@/lib/admin/time"
import { DESTINATION_LABEL, loadCampaignDetail, MODE_LABEL, type CampaignDetail, type VariantView } from "@/lib/marketing/admin-view"
import { SAMPLE_AD_COPY } from "@/lib/marketing/fixtures"
import { orderBannerFileName } from "@/lib/marketing/order-banner"
import type { OrderDestinationCode } from "@/lib/marketing/types"

import { approveVariantAction, confirmPostedAction, createVariantAction, exportVariantAction, requestReviewAction, reviseVariantAction, updateProductUrlsAction } from "../actions"

export const dynamic = "force-dynamic"

const UUID = /^[0-9a-fA-F-]{36}$/

// 캠페인 상세 — 채널별 소재를 작성하고 검수 → 승인 → 게시 패키지 → 게시 확인까지 진행한다.
export default async function MarketingCampaignPage({
  params,
  searchParams,
}: Readonly<{ params: Promise<{ campaignId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const { campaignId } = await params
  const query = await searchParams
  if (!UUID.test(campaignId)) {
    notFound()
  }

  let detail: CampaignDetail | null = null
  let loadFailed = false
  try {
    const { createSupabaseMarketingRepository } = await import("@/lib/marketing/supabase-repository")
    detail = await loadCampaignDetail(createSupabaseMarketingRepository(), campaignId)
  } catch (cause) {
    loadFailed = true
    console.error("[marketing] campaign load failed", { message: cause instanceof Error ? cause.message : String(cause) })
  }
  if (!loadFailed && detail === null) {
    notFound()
  }

  return (
    <MarketingCampaignContent
      detail={detail}
      error={typeof query["error"] === "string" ? query["error"] : null}
      notice={typeof query["notice"] === "string" ? query["notice"] : null}
      relink={typeof query["relinked"] === "string" && typeof query["kept"] === "string" ? { relinked: Number(query["relinked"]), kept: Number(query["kept"]) } : null}
      useSample={query["sample"] === "1"}
    />
  )
}

export function MarketingCampaignContent({
  detail,
  notice,
  error,
  useSample,
  relink = null,
}: Readonly<{ detail: CampaignDetail | null; notice: string | null; error: string | null; useSample: boolean; relink?: { readonly relinked: number; readonly kept: number } | null }>) {
  if (detail === null) {
    return (
      <section className="flex flex-col gap-6">
        <SetupNotice />
      </section>
    )
  }
  const { campaign, channels, variants } = detail
  const activeChannels = channels.filter((channel) => channel.publish_mode !== "disabled")
  const sample = useSample ? SAMPLE_AD_COPY[campaign.mode] : null
  const productUrls = productUrlsOfCampaign(campaign.product_urls)

  return (
    <section aria-labelledby="campaign-title" className="flex flex-col gap-6">
      <PageHeader eyebrow={`광고 배포 · ${MODE_LABEL[campaign.mode]}`} title={campaign.name} titleId="campaign-title">
        <p>
          캠페인 코드 <span className="font-mono font-semibold text-[var(--text-primary)]">{campaign.code}</span>
          {campaign.region === null ? null : <> · 지역 {campaign.region}</>}
        </p>
        <p className="mt-2">
          <Link className="font-semibold text-[var(--accent-primary)] hover:underline" href="/admin/marketing">
            ← 캠페인 목록
          </Link>
        </p>
      </PageHeader>

      <ResultBanner error={error} notice={notice} />
      {relink !== null && Number.isFinite(relink.relinked) && Number.isFinite(relink.kept) && (relink.relinked > 0 || relink.kept > 0) ? (
        <p className="rounded-3xl border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 p-4 text-sm leading-6 text-[var(--text-primary)]" role="status">
          {relink.relinked > 0 ? `게시 전 소재 ${String(relink.relinked)}개의 주문 링크를 새 주소로 바꿨습니다. 링크가 바뀐 소재는 검수 요청과 승인을 다시 해 주세요. ` : ""}
          {relink.kept > 0 ? `이미 게시된 소재 ${String(relink.kept)}개는 그대로 두었습니다 — 올라간 글의 링크는 블로그에서 직접 바꿔야 합니다.` : ""}
        </p>
      ) : null}

      <Panel
        description="주문 링크가 향하는 상품 페이지입니다. 비워 두면 스토어 첫 화면으로 보냅니다. 저장하면 아직 게시하지 않은 소재의 주문 링크가 새 주소로 다시 만들어집니다."
        id="product-urls"
        title="상품 주소"
      >
        <form action={updateProductUrlsAction} className="grid gap-4 p-5 sm:grid-cols-2">
          <input name="campaignId" type="hidden" value={campaign.id} />
          <Field hint="https://smartstore.naver.com/free77888/products/… 형태" label="스마트스토어 상품 주소">
            <input className={INPUT_CLASS} defaultValue={productUrls.smartstore ?? ""} name="productUrl_smartstore" placeholder="비워 두면 스토어 첫 화면" type="url" />
          </Field>
          <Field hint="https://팔도플라워.com/… 형태" label="자사몰 상품 주소">
            <input className={INPUT_CLASS} defaultValue={productUrls.imweb ?? ""} name="productUrl_imweb" placeholder="비워 두면 자사몰 첫 화면" type="text" />
          </Field>
          <div className="sm:col-span-2">
            <button className={SECONDARY_BUTTON_CLASS} type="submit">
              상품 주소 저장
            </button>
          </div>
        </form>
      </Panel>

      <Panel description="채널마다 소재를 하나씩 만듭니다. 같은 글을 여러 채널에 그대로 복사하지 말고 채널에 맞게 고쳐 쓰세요." title={`소재 ${String(variants.length)}개`}>
        {variants.length === 0 ? (
          <p className="p-5 text-sm leading-6 text-[var(--text-secondary)]">아직 소재가 없습니다. 아래에서 첫 소재를 작성해 주세요.</p>
        ) : (
          <ul className="divide-y divide-[var(--border-default)]">
            {variants.map((variant) => (
              <VariantCard campaignCode={campaign.code} campaignId={campaign.id} channelLabel={channels.find((channel) => channel.code === variant.row.channel_code)?.label ?? variant.row.channel_code} key={variant.row.id} variant={variant} />
            ))}
          </ul>
        )}
      </Panel>

      <Panel description="저장하면 채널과 목적지에 맞는 추적 주문 링크가 자동으로 만들어집니다." id="new-variant" title="새 소재 작성">
        <form action={createVariantAction} className="grid gap-4 p-5 sm:grid-cols-2">
          <input name="campaignId" type="hidden" value={campaign.id} />
          <Field label="채널">
            <select className={INPUT_CLASS} name="channel" required>
              {activeChannels.map((channel) => (
                <option key={channel.code} value={channel.code}>
                  {channel.label} ({channel.tier === "primary" ? "1차" : "2차"})
                </option>
              ))}
            </select>
          </Field>
          <Field hint="네이버 계열 채널은 스마트스토어, 그 밖은 자사몰이 기본입니다." label="주문 목적지">
            <select className={INPUT_CLASS} defaultValue="" name="destination">
              <option value="">채널 기본값</option>
              <option value="smartstore">{DESTINATION_LABEL.smartstore}</option>
              <option value="imweb">{DESTINATION_LABEL.imweb}</option>
            </select>
          </Field>
          <Field hint="추적 링크에 들어갑니다. 영문·숫자·하이픈·밑줄만, 예: blog-v1" label="소재 코드">
            <input className={`${INPUT_CLASS} font-mono`} maxLength={50} name="code" pattern="[A-Za-z0-9_\-]{1,50}" placeholder="blog-v1" required type="text" />
          </Field>
          <Field label="제목">
            <input className={INPUT_CLASS} defaultValue={sample?.title ?? ""} maxLength={120} name="title" required type="text" />
          </Field>
          <div className="sm:col-span-2">
            <Field hint="가격·배송 보장·후기·제휴 표현과 전화번호는 품질 검사에서 걸립니다." label="본문">
              <textarea className={`${INPUT_CLASS} min-h-40 leading-6`} defaultValue={sample?.body ?? ""} name="body" required />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field hint="선택 사항 — SNS 캡션처럼 본문과 따로 나가는 짧은 문구" label="짧은 문구">
              <input className={INPUT_CLASS} defaultValue={sample?.caption ?? ""} maxLength={200} name="caption" type="text" />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <button className={PRIMARY_BUTTON_CLASS} type="submit">
              소재 저장
            </button>
            {useSample ? null : (
              <Link className={SECONDARY_BUTTON_CLASS} href={`/admin/marketing/${campaign.id}?sample=1#new-variant`}>
                예시 문안으로 채우기
              </Link>
            )}
          </div>
        </form>
      </Panel>
    </section>
  )
}

function HiddenIds({ campaignId, variant }: Readonly<{ campaignId: string; variant: VariantView }>) {
  return (
    <>
      <input name="campaignId" type="hidden" value={campaignId} />
      <input name="variantId" type="hidden" value={variant.row.id} />
      <input name="revision" type="hidden" value={variant.row.revision} />
    </>
  )
}

function packageText(variant: VariantView): string {
  const { title, body, caption, order_url: orderUrl } = variant.row
  return [title, "", body, ...(caption === null ? [] : ["", caption]), "", `주문하기: ${orderUrl}`].join("\n")
}

// 저장된 상품 주소(JSON)에서 목적지별 문자열만 꺼낸다
function productUrlsOfCampaign(value: unknown): { readonly imweb?: string; readonly smartstore?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {}
  }
  const record = value as Readonly<Record<string, unknown>>
  return {
    ...(typeof record["imweb"] === "string" ? { imweb: record["imweb"] } : {}),
    ...(typeof record["smartstore"] === "string" ? { smartstore: record["smartstore"] } : {}),
  }
}

function VariantCard({ variant, campaignId, campaignCode, channelLabel }: Readonly<{ variant: VariantView; campaignId: string; campaignCode: string; channelLabel: string }>) {
  const { row, status, currentJob } = variant
  const destination: OrderDestinationCode = row.destination_code
  // 게시가 확인된 소재는 고치지 않는다 — 다른 글이 필요하면 새 소재를 만든다
  const editable = status === "draft" || status === "needs_review" || status === "approved" || status === "manual_ready"

  return (
    <li className="scroll-mt-6 p-5" id={`variant-${row.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={status} />
        <p className="text-sm font-semibold text-[var(--text-primary)]">{channelLabel}</p>
        <p className="font-mono text-xs text-[var(--text-secondary)]">
          {row.code} · {String(row.revision)}번째 수정본 · 주문: {DESTINATION_LABEL[destination]}
        </p>
      </div>

      <h4 className="mt-3 text-base font-semibold text-[var(--text-primary)]">{row.title}</h4>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[var(--text-primary)]">{row.body}</p>
      {row.caption === null ? null : <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">짧은 문구: {row.caption}</p>}
      <p className="mt-3 break-all rounded-xl bg-[var(--surface-secondary)] p-3 font-mono text-xs leading-5 text-[var(--text-secondary)]">{row.order_url}</p>
      {row.tracking_kind === "platform-auto" ? (
        <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">네이버 검색광고에서 스마트스토어로 가는 링크는 광고 시스템이 자동으로 추적하므로 추적 값을 붙이지 않습니다.</p>
      ) : null}

      {variant.qualityIssues.length > 0 ? (
        <div className="mt-3 rounded-2xl border border-[var(--status-error)]/40 bg-[var(--status-error)]/10 p-4">
          <p className="text-sm font-semibold text-[var(--text-primary)]">품질 검사에서 걸린 항목 {String(variant.qualityIssues.length)}건</p>
          <ul className="mt-2 list-disc pl-5 text-sm leading-6 text-[var(--text-primary)]">
            {variant.qualityIssues.map((issue) => (
              <li key={issue.code}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-4 flex flex-col gap-4">
        {status === "draft" ? (
          <form action={requestReviewAction}>
            <HiddenIds campaignId={campaignId} variant={variant} />
            <button className={PRIMARY_BUTTON_CLASS} type="submit">
              검수 요청 (품질 검사)
            </button>
          </form>
        ) : null}

        {status === "needs_review" ? (
          <form action={approveVariantAction} className="flex flex-wrap items-center gap-3">
            <HiddenIds campaignId={campaignId} variant={variant} />
            <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
              <input className="size-4" name="reviewed" required type="checkbox" />
              제목·본문·주문 링크를 직접 읽고 확인했습니다
            </label>
            <button className={PRIMARY_BUTTON_CLASS} type="submit">
              승인
            </button>
          </form>
        ) : null}

        {status === "approved" ? (
          <form action={exportVariantAction}>
            <HiddenIds campaignId={campaignId} variant={variant} />
            <button className={PRIMARY_BUTTON_CLASS} type="submit">
              게시 패키지 내보내기
            </button>
          </form>
        ) : null}

        {status === "manual_ready" && currentJob !== null ? (
          <div className="rounded-2xl border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 p-4">
            <p className="text-sm font-semibold text-[var(--text-primary)]">게시 패키지</p>
            <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
              아래 버튼으로 복사해 {channelLabel}
              {currentJob.channel_account.length > 0 ? ` (${currentJob.channel_account})` : ""}에 올려 주세요. 복사만으로는 게시 완료가 아닙니다 — 올린 글의 주소를
              입력해야 기록됩니다.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <CopyButton label="제목+본문+주문 링크 복사" text={packageText(variant)} />
              <CopyButton label="제목만" text={row.title} />
              <CopyButton label="본문만" text={row.body} />
              <CopyButton label="주문 링크만" text={row.order_url} />
            </div>
            <div className="mt-4 border-t border-[var(--status-warning)]/30 pt-4">
              <p className="text-sm font-semibold text-[var(--text-primary)]">주문 배너 이미지</p>
              <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
                글 끝에 이 이미지를 넣고, 이미지를 선택해 링크 넣기에 주문 링크를 붙여 주세요. 누르면 주문 페이지로 가는 배너가 됩니다.
              </p>
              <div className="mt-3">
                <OrderBanner fileName={orderBannerFileName(campaignCode, row.code)} mode={row.mode} orderUrl={row.order_url} />
              </div>
            </div>
            <form action={confirmPostedAction} className="mt-4 flex flex-wrap items-end gap-3">
              <HiddenIds campaignId={campaignId} variant={variant} />
              <input name="jobId" type="hidden" value={currentJob.id} />
              <div className="min-w-64 flex-1">
                <Field label="올린 글의 주소">
                  <input className={INPUT_CLASS} name="postedUrl" placeholder="https://blog.naver.com/…" required type="url" />
                </Field>
              </div>
              <button className={PRIMARY_BUTTON_CLASS} type="submit">
                게시 확인
              </button>
            </form>
          </div>
        ) : null}

        {status === "manual_confirmed" && currentJob !== null && currentJob.posted_url !== null ? (
          <p className="text-sm leading-6 text-[var(--text-primary)]">
            게시된 글:{" "}
            <a className="break-all font-semibold text-[var(--accent-primary)] hover:underline" href={currentJob.posted_url} rel="noreferrer" target="_blank">
              {currentJob.posted_url}
            </a>
            {currentJob.confirmed_at === null ? null : <span className="text-[var(--text-secondary)]"> · {formatKstDateTime(currentJob.confirmed_at)} 확인</span>}
          </p>
        ) : null}

        {editable ? (
          <details className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4">
            <summary className="cursor-pointer text-sm font-semibold text-[var(--text-primary)]">수정하기</summary>
            <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">
              수정하면 검수와 승인을 다시 받아야 하고, 이미 내보낸 게시 패키지는 폐기됩니다.
            </p>
            <form action={reviseVariantAction} className="mt-3 grid gap-3">
              <HiddenIds campaignId={campaignId} variant={variant} />
              <Field label="주문 목적지">
                <select className={INPUT_CLASS} defaultValue={destination} name="destination">
                  <option value="smartstore">{DESTINATION_LABEL.smartstore}</option>
                  <option value="imweb">{DESTINATION_LABEL.imweb}</option>
                </select>
              </Field>
              <Field label="제목">
                <input className={INPUT_CLASS} defaultValue={row.title} maxLength={120} name="title" required type="text" />
              </Field>
              <Field label="본문">
                <textarea className={`${INPUT_CLASS} min-h-40 leading-6`} defaultValue={row.body} name="body" required />
              </Field>
              <Field label="짧은 문구">
                <input className={INPUT_CLASS} defaultValue={row.caption ?? ""} maxLength={200} name="caption" type="text" />
              </Field>
              <div>
                <button className={SECONDARY_BUTTON_CLASS} type="submit">
                  수정 저장
                </button>
              </div>
            </form>
          </details>
        ) : null}
      </div>
    </li>
  )
}
