// 광고 배포 업무 흐름 — 관리자 화면의 버튼 하나가 여기 함수 하나에 대응한다.
//
//   캠페인 만들기 → 소재 작성 → 검수 요청(품질 검사) → 승인 → 게시 패키지 내보내기 → 사람이 게시 → 게시 주소 확인
//
// 규칙은 순수 계층(approval·ad-quality·order-destination·tracking-url)이, 저장은 저장소가 맡고
// 여기서는 순서를 잇고 감사 기록을 남긴다. 저장소를 주입받으므로 DB 없이 메모리 구현으로 전 과정을 검증할 수 있다.
import type { ContentMode } from "@/lib/ai/content-mode"
import type { QualityReport } from "@/lib/ai/content-quality"
import type { Json, MarketingCampaignRow, MarketingDistributionJobRow, MarketingVariantRow } from "@/types/database"

import { evaluateAdCopy, type AdQualityContext } from "./ad-quality"
import { approveVariant } from "./approval"
import { getMarketingChannel, isMarketingChannelCode } from "./channel-policy"
import { resolveOrderDestination, type ApprovedProductUrls } from "./order-destination"
import { variantImageRefs, variantRowToDraft, type AppendEventInput, type InvalidReason, type MarketingRepository, type MetricObservation, type VariantContent } from "./repository"
import { buildTrackedOrderUrl, isTrackingCode } from "./tracking-url"
import type { AdCopy, MarketingChannelCode, OrderDestinationCode } from "./types"

// 주문 링크 재조정을 몇 바퀴까지 다시 시도할지 (다른 수정과 겹쳤을 때)
const RELINK_PASSES = 3

// 같은 채널의 최근 게시 글 몇 건과 비교해 복제 게시를 막을지
const RECENT_POSTED_BODIES = 20

export type ServiceFailure =
  // 대상이 없다
  | "not-found"
  // 그사이 다른 사람이 고쳤거나 이미 처리됐다 — 화면을 새로 고쳐 다시 본다
  | "stale"
  // 코드가 이미 쓰이고 있다
  | "code-taken"
  // 품질 검사 실패
  | "quality-fail"
  // 검수 대기 상태가 아니다 / 승인본이 아니다
  | "not-approved"
  | "channel-disabled"
  | "duplicate"
  | "invalid-account"
  // 주문 링크가 캠페인의 현재 상품 주소와 달라 방금 새로 맞췄다 — 다시 검수·승인이 필요하다
  | "link-outdated"
  // 이미 게시됐거나 게시 결과를 확인 중인 소재라 고칠 수 없다
  | "already-posted"
  // 게시 주소가 https 주소가 아니다
  | "posted-url-invalid"
  | "channel-unknown"
  | "empty-copy"
  | InvalidReason

export type ServiceResult<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly reason: ServiceFailure; readonly quality?: QualityReport }

export type VariantCopyInput = {
  readonly title: string
  readonly body: string
  readonly caption?: string
  readonly imageTexts?: readonly string[]
}

function failure(reason: ServiceFailure, quality?: QualityReport): { readonly ok: false; readonly reason: ServiceFailure; readonly quality?: QualityReport } {
  return quality === undefined ? { ok: false, reason } : { ok: false, reason, quality }
}

function isProductUrlMap(value: Json): value is Readonly<Partial<Record<OrderDestinationCode, string>>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// 캠페인에 등록된 목적지별 상품 URL을 "이 캠페인 모드의 승인 상품 URL"로 본다
function productUrlsOf(campaign: MarketingCampaignRow): ApprovedProductUrls {
  if (!isProductUrlMap(campaign.product_urls)) {
    return {}
  }
  const urls: Partial<Record<OrderDestinationCode, Partial<Record<ContentMode, string>>>> = {}
  for (const destination of ["imweb", "smartstore"] as const) {
    const url = campaign.product_urls[destination]
    if (typeof url === "string" && url.length > 0) {
      urls[destination] = { [campaign.mode]: url }
    }
  }
  return urls
}

function copyOf(row: MarketingVariantRow): AdCopy {
  return variantRowToDraft(row).copy
}

function isJsonObject(value: Json): value is Readonly<Record<string, Json | undefined>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function bodyOfPayload(payload: Json): string | null {
  if (!isJsonObject(payload)) {
    return null
  }
  const body = payload["body"]
  return typeof body === "string" ? body : null
}

export function createMarketingService(repo: MarketingRepository, now: () => string = () => new Date().toISOString()) {
  // 채널·목적지·캠페인에서 최종 주문 링크까지 조립한다. 목적지를 지정하지 않으면 채널 기본값.
  function buildContent(campaign: MarketingCampaignRow, variantCode: string, channel: MarketingChannelCode, destination: OrderDestinationCode | undefined, copy: VariantCopyInput, imageRefs: VariantContent["imageRefs"]): VariantContent {
    const resolved = resolveOrderDestination({ channel, mode: campaign.mode, productUrls: productUrlsOf(campaign), ...(destination === undefined ? {} : { override: destination }) })
    const tracked = buildTrackedOrderUrl({ channel, destination: resolved.destination.code, baseUrl: resolved.url, campaignCode: campaign.code, variantCode })
    return {
      destinationCode: resolved.destination.code,
      orderUrl: tracked.url,
      trackingKind: tracked.trackingKind,
      trackingParams: tracked.params,
      title: copy.title.trim(),
      body: copy.body.trim(),
      caption: copy.caption === undefined || copy.caption.trim().length === 0 ? null : copy.caption.trim(),
      imageTexts: (copy.imageTexts ?? []).map((text) => text.trim()).filter((text) => text.length > 0),
      imageRefs,
    }
  }

  // 화면이 보낸 캠페인·소재 id가 실제로 부모·자식 관계인지 확인하고 둘 다 돌려준다.
  // 폼의 숨은 값은 바꿔 보낼 수 있으므로, 다른 캠페인의 소재를 이 캠페인 화면에서 처리하지 못하게 한다.
  async function loadVariantInCampaign(campaignId: string, variantId: string): Promise<{ readonly campaign: MarketingCampaignRow; readonly variant: MarketingVariantRow } | null> {
    const variant = await repo.findVariant(variantId)
    if (variant?.campaign_id !== campaignId) {
      return null
    }
    const campaign = await repo.findCampaign(campaignId)
    return campaign === null ? null : { campaign, variant }
  }

  // 품질 검사 맥락 — 같은 채널에 이미 게시된 다른 소재의 본문(복제 검사)과 캠페인 지역(지역명 오탐 방지).
  // 검수 요청·승인·내보내기 세 곳이 같은 맥락으로 검사해야 판정이 어긋나지 않는다.
  async function qualityContextFor(campaign: MarketingCampaignRow, variant: MarketingVariantRow): Promise<AdQualityContext> {
    const posted = await repo.listPostedPayloads(variant.channel_code, RECENT_POSTED_BODIES)
    const recentBodies = posted
      // 같은 소재를 다른 계정에 한 번 더 내보내는 경우는 복제가 아니다
      .filter((entry) => entry.variantId !== variant.id)
      .map((entry) => bodyOfPayload(entry.payload))
      .filter((body): body is string => body !== null)
    return { recentBodies, regionTokens: campaign.region === null ? [] : [campaign.region] }
  }

  // 지금 캠페인 설정대로라면 이 소재의 내용(주문 링크 포함)이 어떻게 되어야 하는가
  function expectedContent(campaign: MarketingCampaignRow, variant: MarketingVariantRow): VariantContent {
    return buildContent(campaign, variant.code, variant.channel_code, variant.destination_code, copyOf(variant), variantImageRefs(variant))
  }

  // 캠페인의 "지금 저장된" 상품 주소에 소재들의 주문 링크를 맞춘다.
  //
  // 넘겨받은 캠페인 값이 아니라 매번 다시 읽은 값을 기준으로 삼는다 — 두 사람이 주소를 연달아 바꿔도
  // 늦게 도착한 요청이 옛 주소로 되돌리지 않는다. 다른 수정과 겹쳐 반영하지 못한 소재(stale)는 다시 읽어 재시도하고,
  // 그래도 남으면 pending으로 돌려준다(성공한 척하지 않는다).
  async function reconcileCampaignLinks(campaignId: string, actor: string): Promise<{ readonly campaign: MarketingCampaignRow | null; readonly relinked: number; readonly keptPosted: number; readonly pending: number }> {
    const relinkedIds = new Set<string>()
    const lockedIds = new Set<string>()
    let campaign: MarketingCampaignRow | null = null
    for (let pass = 0; pass < RELINK_PASSES; pass += 1) {
      campaign = await repo.findCampaign(campaignId)
      if (campaign === null) {
        break
      }
      let retry = false
      for (const variant of await repo.listVariants(campaignId)) {
        if (lockedIds.has(variant.id)) {
          continue
        }
        const content = expectedContent(campaign, variant)
        if (content.orderUrl === variant.order_url) {
          continue
        }
        const result = await repo.reviseVariant(variant.id, variant.revision, content)
        if (result.kind === "updated") {
          relinkedIds.add(variant.id)
          await record({
            variantId: variant.id,
            eventType: "relinked",
            fromStatus: variant.review_status,
            toStatus: "draft",
            variantRevision: result.row.revision,
            actor,
            detail: { previous_order_url: variant.order_url, order_url: content.orderUrl, cancelled_jobs: result.cancelledJobs },
          })
        } else if (result.kind === "locked") {
          lockedIds.add(variant.id)
        } else {
          // stale(그사이 다른 수정) 또는 invalid — 다음 바퀴에서 최신 상태로 다시 본다
          retry = true
        }
      }
      if (!retry) {
        break
      }
    }
    // 마지막으로 한 번 더 읽어, 아직 최신 주소와 어긋난 게시 전 소재를 센다
    const latest = await repo.findCampaign(campaignId)
    let pending = 0
    if (latest !== null) {
      for (const variant of await repo.listVariants(campaignId)) {
        if (!lockedIds.has(variant.id) && expectedContent(latest, variant).orderUrl !== variant.order_url) {
          pending += 1
        }
      }
    }
    return { campaign: latest ?? campaign, relinked: relinkedIds.size, keptPosted: lockedIds.size, pending }
  }

  // 감사 기록은 상태 변경이 끝난 뒤에 남긴다. 기록이 실패해도 이미 저장된 상태 변경을 실패로 보고하지 않는다 —
  // 그러면 화면은 "실패"라는데 실제로는 승인이 끝나 있어 다시 누르면 stale만 나온다. 누락은 서버 로그로 남긴다.
  async function record(event: AppendEventInput): Promise<void> {
    try {
      await repo.appendEvent(event)
    } catch (error) {
      console.error("[marketing] audit event not recorded", { eventType: event.eventType, variantId: event.variantId, message: error instanceof Error ? error.message : String(error) })
    }
  }

  return {
    async createCampaign(input: {
      readonly code: string
      readonly name: string
      readonly mode: ContentMode
      readonly region?: string | null
      readonly productUrls?: Readonly<Partial<Record<OrderDestinationCode, string>>>
      readonly actor: string
    }): Promise<ServiceResult<{ readonly campaign: MarketingCampaignRow }>> {
      const result = await repo.createCampaign({
        code: input.code,
        name: input.name,
        mode: input.mode,
        region: input.region ?? null,
        createdBy: input.actor,
        ...(input.productUrls === undefined ? {} : { productUrls: input.productUrls }),
      })
      if (result.kind === "invalid") {
        return failure(result.reason)
      }
      return result.kind === "created" ? { ok: true, campaign: result.campaign } : failure("code-taken")
    },

    async createVariant(input: {
      readonly campaignId: string
      readonly code: string
      readonly channel: string
      readonly destination?: OrderDestinationCode
      readonly copy: VariantCopyInput
      readonly actor: string
    }): Promise<ServiceResult<{ readonly variant: MarketingVariantRow }>> {
      if (!isMarketingChannelCode(input.channel)) {
        return failure("channel-unknown")
      }
      if (!isTrackingCode(input.code)) {
        return failure("code-format")
      }
      if (input.copy.title.trim().length === 0 || input.copy.body.trim().length === 0) {
        return failure("empty-copy")
      }
      const campaign = await repo.findCampaign(input.campaignId)
      if (campaign === null) {
        return failure("not-found")
      }
      const content = buildContent(campaign, input.code, input.channel, input.destination, input.copy, [])
      const result = await repo.createVariant({ ...content, campaignId: campaign.id, code: input.code, channelCode: input.channel, mode: campaign.mode, createdBy: input.actor })
      if (result.kind === "invalid") {
        return failure(result.reason)
      }
      if (result.kind === "code-taken") {
        return failure("code-taken")
      }
      await record({ variantId: result.variant.id, eventType: "created", toStatus: "draft", variantRevision: 1, actor: input.actor })
      return { ok: true, variant: result.variant }
    },

    // 문안·목적지 수정 — revision이 올라가고 검수·승인을 다시 받아야 한다. 이전 승인본의 게시 전 작업은 폐기된다.
    // 이미 게시된(또는 게시 결과를 확인 중인) 소재는 고칠 수 없다 — 올라간 글과 기록이 달라지기 때문이다. 새 소재를 만든다.
    async reviseVariant(input: {
      readonly campaignId: string
      readonly variantId: string
      readonly expectedRevision: number
      readonly destination?: OrderDestinationCode
      readonly copy: VariantCopyInput
      readonly actor: string
    }): Promise<ServiceResult<{ readonly variant: MarketingVariantRow; readonly cancelledJobs: number }>> {
      if (input.copy.title.trim().length === 0 || input.copy.body.trim().length === 0) {
        return failure("empty-copy")
      }
      const loaded = await loadVariantInCampaign(input.campaignId, input.variantId)
      if (loaded === null) {
        return failure("not-found")
      }
      const { campaign, variant: current } = loaded
      // 이미지 구성은 이 흐름에서 바꾸지 않는다 — 기존 참조를 그대로 유지한다
      const content = buildContent(campaign, current.code, current.channel_code, input.destination ?? current.destination_code, input.copy, variantImageRefs(current))
      const result = await repo.reviseVariant(current.id, input.expectedRevision, content)
      if (result.kind === "invalid") {
        return failure(result.reason)
      }
      if (result.kind === "stale" || result.kind === "locked") {
        return failure(result.kind === "locked" ? "already-posted" : "stale")
      }
      // 이 수정이 읽은 캠페인 주소가 저장하는 사이에 바뀌었을 수 있다 — 방금 쓴 링크가 옛 주소면 최신 주소로 맞춘다.
      await reconcileCampaignLinks(campaign.id, input.actor)
      const saved = (await repo.findVariant(current.id)) ?? result.row
      await record({
        variantId: current.id,
        eventType: "revised",
        fromStatus: current.review_status,
        toStatus: "draft",
        variantRevision: result.row.revision,
        actor: input.actor,
        detail: { previous_revision: current.revision, cancelled_jobs: result.cancelledJobs },
      })
      return { ok: true, variant: saved, cancelledJobs: result.cancelledJobs }
    },

    // 검수 요청 — 품질 검사를 돌려 결과를 저장한다. 통과하면 검수 대기로, 실패하면 작성 중에 머문다.
    async requestReview(input: { readonly campaignId: string; readonly variantId: string; readonly expectedRevision: number; readonly actor: string }): Promise<ServiceResult<{ readonly variant: MarketingVariantRow; readonly quality: QualityReport }>> {
      const loaded = await loadVariantInCampaign(input.campaignId, input.variantId)
      if (loaded === null) {
        return failure("not-found")
      }
      const { campaign, variant: current } = loaded
      const quality = evaluateAdCopy({ ...(await qualityContextFor(campaign, current)), mode: current.mode, copy: copyOf(current) })
      const passed = quality.status !== "fail"
      const result = await repo.recordReview(current.id, input.expectedRevision, quality, passed)
      if (result.kind === "stale") {
        return failure("stale")
      }
      await record({
        variantId: current.id,
        eventType: "review_requested",
        fromStatus: "draft",
        toStatus: result.row.review_status,
        variantRevision: result.row.revision,
        actor: input.actor,
        detail: { quality_status: quality.status, issue_codes: quality.issues.map((issue) => issue.code) },
      })
      return passed ? { ok: true, variant: result.row, quality } : failure("quality-fail", quality)
    },

    // 승인 — 지금 저장된 소재를 다시 검사한 뒤 승인 스냅샷을 남긴다.
    async approve(input: { readonly campaignId: string; readonly variantId: string; readonly expectedRevision: number; readonly actor: string }): Promise<ServiceResult<{ readonly variant: MarketingVariantRow }>> {
      const loaded = await loadVariantInCampaign(input.campaignId, input.variantId)
      if (loaded === null) {
        return failure("not-found")
      }
      const { campaign, variant: current } = loaded
      if (current.revision !== input.expectedRevision) {
        return failure("stale")
      }
      if (expectedContent(campaign, current).orderUrl !== current.order_url) {
        await reconcileCampaignLinks(campaign.id, input.actor)
        return failure("link-outdated")
      }
      const approvedAt = now()
      const decision = approveVariant({ variant: variantRowToDraft(current), qualityContext: await qualityContextFor(campaign, current), approvedBy: input.actor, approvedAt })
      if (!decision.ok) {
        return decision.reason === "quality-fail" ? failure("quality-fail", decision.quality) : failure(decision.reason === "order-url-not-allowed" ? "order-url" : "not-approved")
      }
      const result = await repo.approveVariant(current.id, input.expectedRevision, { approvalHash: decision.snapshot.approvalHash, approvedBy: input.actor, approvedAt })
      if (result.kind === "stale") {
        return failure("stale")
      }
      await record({ variantId: current.id, eventType: "approved", fromStatus: "needs_review", toStatus: "approved", variantRevision: result.row.revision, actor: input.actor })
      return { ok: true, variant: result.row }
    },

    // 게시 패키지 내보내기 — 승인본으로 배포 작업을 만든다. 이것만으로는 게시 완료가 아니다.
    // 승인한 뒤에 같은 채널에 같은 글이 먼저 게시됐을 수 있으므로, 내보내는 시점의 게시 이력으로 한 번 더 검사한다.
    async exportForPosting(input: { readonly campaignId: string; readonly variantId: string; readonly expectedRevision: number; readonly actor: string }): Promise<ServiceResult<{ readonly job: MarketingDistributionJobRow }>> {
      const loaded = await loadVariantInCampaign(input.campaignId, input.variantId)
      if (loaded === null) {
        return failure("not-found")
      }
      const { campaign, variant: current } = loaded
      if (current.revision !== input.expectedRevision) {
        return failure("stale")
      }
      if (current.review_status !== "approved") {
        return failure("not-approved")
      }
      // 마지막 방어선 — 상품 주소가 바뀐 뒤 링크를 맞추지 못한 소재가 옛 링크로 나가지 않게 한다
      if (expectedContent(campaign, current).orderUrl !== current.order_url) {
        await reconcileCampaignLinks(campaign.id, input.actor)
        return failure("link-outdated")
      }
      const quality = evaluateAdCopy({ ...(await qualityContextFor(campaign, current)), mode: current.mode, copy: copyOf(current) })
      if (quality.status === "fail") {
        return failure("quality-fail", quality)
      }
      const result = await repo.createJob({ variantId: current.id, expectedRevision: input.expectedRevision, createdBy: input.actor })
      if (result.kind !== "created") {
        return failure(result.kind)
      }
      await record({ variantId: current.id, jobId: result.job.id, eventType: "exported", toStatus: result.job.status, variantRevision: result.job.variant_revision, actor: input.actor })
      return { ok: true, job: result.job }
    },

    // 게시 확인 — 사람이 실제로 올린 글의 주소를 기록한다.
    async confirmPosted(input: { readonly campaignId: string; readonly variantId: string; readonly jobId: string; readonly postedUrl: string; readonly actor: string }): Promise<ServiceResult<{ readonly job: MarketingDistributionJobRow }>> {
      const postedUrl = input.postedUrl.trim()
      let isHttps = false
      try {
        isHttps = new URL(postedUrl).protocol === "https:"
      } catch {
        isHttps = false
      }
      if (!isHttps) {
        return failure("posted-url-invalid")
      }
      const loaded = await loadVariantInCampaign(input.campaignId, input.variantId)
      const job = await repo.findJob(input.jobId)
      // 작업이 이 화면의 그 소재 것인지 확인한다
      if (loaded === null || job?.variant_id !== loaded.variant.id) {
        return failure("not-found")
      }
      // 내보낸 뒤 소재가 수정됐다면 그 작업은 더 이상 유효한 승인본이 아니다
      if (job.variant_revision !== loaded.variant.revision) {
        return failure("stale")
      }
      const result = await repo.transitionJob(job.id, "manual_ready", "manual_confirmed", { postedUrl, confirmedBy: input.actor, confirmedAt: now() })
      if (result.kind !== "updated") {
        return failure("stale")
      }
      await record({ variantId: job.variant_id, jobId: job.id, eventType: "post_confirmed", fromStatus: "manual_ready", toStatus: "manual_confirmed", variantRevision: job.variant_revision, actor: input.actor, detail: { posted_url: postedUrl } })
      return { ok: true, job: result.row }
    },

    // 캠페인의 상품 주소를 바꾸고, 아직 게시되지 않은 소재의 주문 링크를 새 주소로 다시 만든다.
    // 링크가 바뀐 소재는 revision이 올라가 검수·승인을 다시 받아야 한다(승인한 링크와 나가는 링크가 달라지면 안 된다).
    // 이미 게시된 소재는 그대로 둔다 — 올라간 글의 링크는 여기서 바꿀 수 없다.
    async updateCampaignProductUrls(input: {
      readonly campaignId: string
      readonly productUrls: Readonly<Partial<Record<OrderDestinationCode, string>>>
      readonly actor: string
    }): Promise<ServiceResult<{ readonly campaign: MarketingCampaignRow; readonly relinked: number; readonly keptPosted: number; readonly pending: number }>> {
      const updated = await repo.updateCampaignProductUrls(input.campaignId, input.productUrls)
      if (updated.kind === "invalid") {
        return failure(updated.reason)
      }
      if (updated.kind === "not-found") {
        return failure("not-found")
      }
      const reconciled = await reconcileCampaignLinks(updated.campaign.id, input.actor)
      // 동시에 다른 저장이 있었다면 방금 저장한 값이 아니라 지금 저장되어 있는 값이 기준이다
      return { ok: true, campaign: reconciled.campaign ?? updated.campaign, relinked: reconciled.relinked, keptPosted: reconciled.keptPosted, pending: reconciled.pending }
    },

    async recordMetrics(observations: readonly MetricObservation[]): Promise<number> {
      return repo.upsertMetrics(observations)
    },

    async setChannel(input: { readonly channel: string; readonly publishMode?: "manual" | "disabled"; readonly accountRef?: string | null }): Promise<ServiceResult<Record<never, never>>> {
      if (!isMarketingChannelCode(input.channel)) {
        return failure("channel-unknown")
      }
      const result = await repo.updateChannel(getMarketingChannel(input.channel).code, {
        ...(input.publishMode === undefined ? {} : { publishMode: input.publishMode }),
        ...(input.accountRef === undefined ? {} : { accountRef: input.accountRef }),
      })
      if (result.kind === "invalid") {
        return failure(result.reason)
      }
      return result.kind === "updated" ? { ok: true } : failure("not-found")
    },
  }
}

export type MarketingService = ReturnType<typeof createMarketingService>
