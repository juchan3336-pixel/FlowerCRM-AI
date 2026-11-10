// 광고 배포 업무 흐름 — 관리자 화면의 버튼 하나가 여기 함수 하나에 대응한다.
//
//   캠페인 만들기 → 소재 작성 → 검수 요청(품질 검사) → 승인 → 게시 패키지 내보내기 → 사람이 게시 → 게시 주소 확인
//
// 규칙은 순수 계층(approval·ad-quality·order-destination·tracking-url)이, 저장은 저장소가 맡고
// 여기서는 순서를 잇고 감사 기록을 남긴다. 저장소를 주입받으므로 DB 없이 메모리 구현으로 전 과정을 검증할 수 있다.
import type { ContentMode } from "@/lib/ai/content-mode"
import type { QualityReport } from "@/lib/ai/content-quality"
import type { Json, MarketingCampaignRow, MarketingDistributionJobRow, MarketingVariantRow } from "@/types/database"

import { evaluateAdCopy } from "./ad-quality"
import { approveVariant } from "./approval"
import { getMarketingChannel, isMarketingChannelCode } from "./channel-policy"
import { resolveOrderDestination, type ApprovedProductUrls } from "./order-destination"
import { variantImageRefs, variantRowToDraft, type InvalidReason, type MarketingRepository, type MetricObservation, type VariantContent } from "./repository"
import { buildTrackedOrderUrl, isTrackingCode } from "./tracking-url"
import type { AdCopy, MarketingChannelCode, OrderDestinationCode } from "./types"

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

  async function recentBodies(channel: MarketingChannelCode): Promise<readonly string[]> {
    const payloads = await repo.listPostedPayloads(channel, RECENT_POSTED_BODIES)
    return payloads.map(bodyOfPayload).filter((body): body is string => body !== null)
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
      await repo.appendEvent({ variantId: result.variant.id, eventType: "created", toStatus: "draft", variantRevision: 1, actor: input.actor })
      return { ok: true, variant: result.variant }
    },

    // 문안·목적지 수정 — revision이 올라가고 검수·승인을 다시 받아야 한다. 이전 승인본의 게시 전 작업은 폐기된다.
    async reviseVariant(input: {
      readonly variantId: string
      readonly expectedRevision: number
      readonly destination?: OrderDestinationCode
      readonly copy: VariantCopyInput
      readonly actor: string
    }): Promise<ServiceResult<{ readonly variant: MarketingVariantRow; readonly cancelledJobs: number }>> {
      if (input.copy.title.trim().length === 0 || input.copy.body.trim().length === 0) {
        return failure("empty-copy")
      }
      const current = await repo.findVariant(input.variantId)
      if (current === null) {
        return failure("not-found")
      }
      const campaign = await repo.findCampaign(current.campaign_id)
      if (campaign === null) {
        return failure("not-found")
      }
      // 이미지 구성은 이 흐름에서 바꾸지 않는다 — 기존 참조를 그대로 유지한다
      const content = buildContent(campaign, current.code, current.channel_code, input.destination ?? current.destination_code, input.copy, variantImageRefs(current))
      const result = await repo.reviseVariant(current.id, input.expectedRevision, content)
      if (result.kind === "invalid") {
        return failure(result.reason)
      }
      if (result.kind === "stale") {
        return failure("stale")
      }
      await repo.appendEvent({
        variantId: current.id,
        eventType: "revised",
        fromStatus: current.review_status,
        toStatus: "draft",
        variantRevision: result.row.revision,
        actor: input.actor,
        detail: { previous_revision: current.revision, cancelled_jobs: result.cancelledJobs },
      })
      return { ok: true, variant: result.row, cancelledJobs: result.cancelledJobs }
    },

    // 검수 요청 — 품질 검사를 돌려 결과를 저장한다. 통과하면 검수 대기로, 실패하면 작성 중에 머문다.
    async requestReview(input: { readonly variantId: string; readonly expectedRevision: number; readonly actor: string }): Promise<ServiceResult<{ readonly variant: MarketingVariantRow; readonly quality: QualityReport }>> {
      const current = await repo.findVariant(input.variantId)
      if (current === null) {
        return failure("not-found")
      }
      const quality = evaluateAdCopy({ mode: current.mode, copy: copyOf(current), recentBodies: await recentBodies(current.channel_code) })
      const passed = quality.status !== "fail"
      const result = await repo.recordReview(current.id, input.expectedRevision, quality, passed)
      if (result.kind === "stale") {
        return failure("stale")
      }
      await repo.appendEvent({
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
    async approve(input: { readonly variantId: string; readonly expectedRevision: number; readonly actor: string }): Promise<ServiceResult<{ readonly variant: MarketingVariantRow }>> {
      const current = await repo.findVariant(input.variantId)
      if (current === null) {
        return failure("not-found")
      }
      if (current.revision !== input.expectedRevision) {
        return failure("stale")
      }
      const approvedAt = now()
      const decision = approveVariant({ variant: variantRowToDraft(current), qualityContext: { recentBodies: await recentBodies(current.channel_code) }, approvedBy: input.actor, approvedAt })
      if (!decision.ok) {
        return decision.reason === "quality-fail" ? failure("quality-fail", decision.quality) : failure(decision.reason === "order-url-not-allowed" ? "order-url" : "not-approved")
      }
      const result = await repo.approveVariant(current.id, input.expectedRevision, { approvalHash: decision.snapshot.approvalHash, approvedBy: input.actor, approvedAt })
      if (result.kind === "stale") {
        return failure("stale")
      }
      await repo.appendEvent({ variantId: current.id, eventType: "approved", fromStatus: "needs_review", toStatus: "approved", variantRevision: result.row.revision, actor: input.actor })
      return { ok: true, variant: result.row }
    },

    // 게시 패키지 내보내기 — 승인본으로 배포 작업을 만든다. 이것만으로는 게시 완료가 아니다.
    async exportForPosting(input: { readonly variantId: string; readonly expectedRevision: number; readonly actor: string }): Promise<ServiceResult<{ readonly job: MarketingDistributionJobRow }>> {
      const result = await repo.createJob({ variantId: input.variantId, expectedRevision: input.expectedRevision, createdBy: input.actor })
      if (result.kind !== "created") {
        return failure(result.kind)
      }
      await repo.appendEvent({ variantId: input.variantId, jobId: result.job.id, eventType: "exported", toStatus: result.job.status, variantRevision: result.job.variant_revision, actor: input.actor })
      return { ok: true, job: result.job }
    },

    // 게시 확인 — 사람이 실제로 올린 글의 주소를 기록한다.
    async confirmPosted(input: { readonly jobId: string; readonly postedUrl: string; readonly actor: string }): Promise<ServiceResult<{ readonly job: MarketingDistributionJobRow }>> {
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
      const job = await repo.findJob(input.jobId)
      if (job === null) {
        return failure("not-found")
      }
      const result = await repo.transitionJob(job.id, "manual_ready", "manual_confirmed", { postedUrl, confirmedBy: input.actor, confirmedAt: now() })
      if (result.kind !== "updated") {
        return failure("stale")
      }
      await repo.appendEvent({ variantId: job.variant_id, jobId: job.id, eventType: "post_confirmed", fromStatus: "manual_ready", toStatus: "manual_confirmed", variantRevision: job.variant_revision, actor: input.actor, detail: { posted_url: postedUrl } })
      return { ok: true, job: result.row }
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
