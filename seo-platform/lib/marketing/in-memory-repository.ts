// 광고 배포 저장소의 메모리 구현 — 테스트와 DB 없는 미리보기용.
// DB 제약(유일 키, 외래 키, 승인·게시 확인 CHECK, 이미지 참조 검사, 작업 전이·스냅샷 보호)을 같은 규칙으로 흉내 낸다.
// 입력 검증은 repository.ts의 공통 함수를 Supabase 구현과 함께 쓴다 — 같은 입력에는 같은 결과가 나와야 한다.
import { randomUUID } from "node:crypto"

import type {
  Json,
  MarketingCampaignRow,
  MarketingChannelRow,
  MarketingDestinationRow,
  MarketingDistributionEventRow,
  MarketingDistributionJobRow,
  MarketingImageRow,
  MarketingMetricsDailyRow,
  MarketingVariantRow,
} from "@/types/database"

import { listMarketingChannels } from "./channel-policy"
import { canTransitionJob, CANCELLABLE_JOB_STATUSES } from "./distribution-state"
import { listOrderDestinations } from "./order-destination"
import {
  dedupeObservations,
  imageRefsMatch,
  isAccountName,
  metricDimensionKey,
  resolveJobAccount,
  validateCampaignInput,
  validateImageInput,
  validateVariantContent,
  validateVariantInput,
  variantPayload,
  type MarketingRepository,
  type VariantContent,
} from "./repository"

export function createInMemoryMarketingRepository(now: () => string = () => new Date().toISOString()): MarketingRepository {
  const seededAt = now()
  const destinations: MarketingDestinationRow[] = listOrderDestinations().map((destination) => ({
    code: destination.code,
    label: destination.label,
    base_url: destination.baseUrl,
    enabled: true,
    verified_at: null,
    created_at: seededAt,
    updated_at: seededAt,
  }))
  const channels = new Map<string, MarketingChannelRow>(
    listMarketingChannels().map((channel) => [
      channel.code,
      {
        code: channel.code,
        label: channel.label,
        tier: channel.tier,
        publish_mode: channel.publishMode,
        medium: channel.medium,
        default_destination_code: channel.defaultDestination,
        account_ref: null,
        policy_url: null,
        policy_checked_at: null,
        created_at: seededAt,
        updated_at: seededAt,
      },
    ]),
  )
  const images = new Map<string, MarketingImageRow>()
  const campaigns = new Map<string, MarketingCampaignRow>()
  const variants = new Map<string, MarketingVariantRow>()
  const jobs = new Map<string, MarketingDistributionJobRow>()
  const events: MarketingDistributionEventRow[] = []
  const metrics = new Map<string, MarketingMetricsDailyRow>()

  const contentColumns = (content: VariantContent) => ({
    destination_code: content.destinationCode,
    order_url: content.orderUrl,
    tracking_kind: content.trackingKind,
    tracking_params: { ...content.trackingParams } as Json,
    title: content.title,
    body: content.body,
    caption: content.caption,
    image_texts: [...content.imageTexts],
    image_refs: content.imageRefs.map((ref) => ({ image_id: ref.image_id, content_hash: ref.content_hash })) as Json,
  })

  const contentInvalid = (content: VariantContent) => {
    const reason = validateVariantContent(content)
    if (reason !== null) {
      return reason
    }
    return imageRefsMatch(content.imageRefs, [...images.values()]) ? null : ("image-ref" as const)
  }

  return {
    listDestinations: () => Promise.resolve(destinations),
    listChannels: () => Promise.resolve([...channels.values()]),

    updateChannel(code, patch) {
      if (typeof patch.accountRef === "string" && !isAccountName(patch.accountRef)) {
        return Promise.resolve({ kind: "invalid", reason: "account-format" })
      }
      const current = channels.get(code)
      if (current === undefined) {
        return Promise.resolve({ kind: "not-found" })
      }
      const row: MarketingChannelRow = {
        ...current,
        publish_mode: patch.publishMode ?? current.publish_mode,
        account_ref: patch.accountRef === undefined ? current.account_ref : patch.accountRef,
        updated_at: now(),
      }
      channels.set(code, row)
      return Promise.resolve({ kind: "updated", channel: row })
    },

    registerImage(input) {
      const reason = validateImageInput(input)
      if (reason !== null) {
        return Promise.resolve({ kind: "invalid", reason })
      }
      if ([...images.values()].some((image) => image.storage_path === input.storagePath || image.content_hash === input.contentHash)) {
        return Promise.resolve({ kind: "duplicate" })
      }
      const image: MarketingImageRow = {
        id: randomUUID(),
        storage_path: input.storagePath,
        content_hash: input.contentHash,
        kind: input.kind,
        is_real_photo: input.isRealPhoto,
        rights_status: input.rightsStatus,
        privacy_checked_by: null,
        privacy_checked_at: null,
        width: input.width ?? null,
        height: input.height ?? null,
        note: input.note ?? null,
        created_by: input.createdBy,
        created_at: now(),
      }
      images.set(image.id, image)
      return Promise.resolve({ kind: "created", image })
    },
    findImages: (imageIds) => Promise.resolve([...images.values()].filter((image) => imageIds.includes(image.id))),

    createCampaign(input) {
      const reason = validateCampaignInput(input)
      if (reason !== null) {
        return Promise.resolve({ kind: "invalid", reason })
      }
      if ([...campaigns.values()].some((campaign) => campaign.code === input.code)) {
        return Promise.resolve({ kind: "code-taken" })
      }
      const at = now()
      const campaign: MarketingCampaignRow = {
        id: randomUUID(),
        code: input.code,
        name: input.name,
        mode: input.mode,
        region: input.region ?? null,
        starts_on: input.startsOn ?? null,
        ends_on: input.endsOn ?? null,
        budget_cap_krw: input.budgetCapKrw ?? null,
        status: "draft",
        product_urls: { ...input.productUrls },
        created_by: input.createdBy,
        created_at: at,
        updated_at: at,
      }
      campaigns.set(campaign.id, campaign)
      return Promise.resolve({ kind: "created", campaign })
    },
    findCampaign: (campaignId) => Promise.resolve(campaigns.get(campaignId) ?? null),
    listCampaigns: () => Promise.resolve([...campaigns.values()]),

    createVariant(input) {
      const reason = validateVariantInput(input) ?? contentInvalid(input)
      if (reason !== null) {
        return Promise.resolve({ kind: "invalid", reason })
      }
      if (!campaigns.has(input.campaignId)) {
        return Promise.resolve({ kind: "invalid", reason: "reference-not-found" })
      }
      if ([...variants.values()].some((variant) => variant.campaign_id === input.campaignId && variant.code === input.code)) {
        return Promise.resolve({ kind: "code-taken" })
      }
      const at = now()
      const variant: MarketingVariantRow = {
        id: randomUUID(),
        campaign_id: input.campaignId,
        code: input.code,
        channel_code: input.channelCode,
        mode: input.mode,
        ...contentColumns(input),
        revision: 1,
        review_status: "draft",
        quality_report: null,
        quality_checked_revision: null,
        approved_revision: null,
        approval_hash: null,
        approved_by: null,
        approved_at: null,
        created_by: input.createdBy,
        created_at: at,
        updated_at: at,
      }
      variants.set(variant.id, variant)
      return Promise.resolve({ kind: "created", variant })
    },
    findVariant: (variantId) => Promise.resolve(variants.get(variantId) ?? null),
    listVariants: (campaignId) => Promise.resolve([...variants.values()].filter((variant) => variant.campaign_id === campaignId)),

    reviseVariant(variantId, expectedRevision, content) {
      const reason = contentInvalid(content)
      if (reason !== null) {
        return Promise.resolve({ kind: "invalid", reason })
      }
      const current = variants.get(variantId)
      if (current === undefined) {
        return Promise.resolve({ kind: "stale" })
      }
      if (current.revision !== expectedRevision) {
        return Promise.resolve({ kind: "stale" })
      }
      const row: MarketingVariantRow = {
        ...current,
        ...contentColumns(content),
        revision: current.revision + 1,
        review_status: "draft",
        quality_report: null,
        quality_checked_revision: null,
        approved_revision: null,
        approval_hash: null,
        approved_by: null,
        approved_at: null,
        updated_at: now(),
      }
      variants.set(variantId, row)
      // 수정 전 revision까지의 게시 전 작업만 폐기한다
      let cancelledJobs = 0
      for (const job of jobs.values()) {
        if (job.variant_id === variantId && job.variant_revision <= expectedRevision && CANCELLABLE_JOB_STATUSES.includes(job.status)) {
          jobs.set(job.id, { ...job, status: "cancelled", updated_at: now() })
          cancelledJobs += 1
        }
      }
      return Promise.resolve({ kind: "updated", row, cancelledJobs })
    },

    recordReview(variantId, expectedRevision, quality, passed) {
      const current = variants.get(variantId)
      if (current === undefined) {
        return Promise.resolve({ kind: "stale" })
      }
      if (current.revision !== expectedRevision || current.review_status !== "draft") {
        return Promise.resolve({ kind: "stale" })
      }
      const row: MarketingVariantRow = { ...current, quality_report: quality, quality_checked_revision: current.revision, review_status: passed ? "needs_review" : "draft", updated_at: now() }
      variants.set(variantId, row)
      return Promise.resolve({ kind: "updated", row })
    },

    approveVariant(variantId, expectedRevision, approval) {
      const current = variants.get(variantId)
      if (current === undefined) {
        return Promise.resolve({ kind: "stale" })
      }
      if (current.revision !== expectedRevision || current.review_status !== "needs_review" || current.quality_checked_revision !== current.revision || current.quality_report === null) {
        return Promise.resolve({ kind: "stale" })
      }
      const row: MarketingVariantRow = {
        ...current,
        review_status: "approved",
        approved_revision: current.revision,
        approval_hash: approval.approvalHash,
        approved_by: approval.approvedBy,
        approved_at: approval.approvedAt,
        updated_at: now(),
      }
      variants.set(variantId, row)
      return Promise.resolve({ kind: "updated", row })
    },

    // DB 함수 create_marketing_distribution_job과 같은 순서로 판정한다
    createJob(input) {
      const variant = variants.get(input.variantId)
      if (variant === undefined) {
        return Promise.resolve({ kind: "not-approved" })
      }
      if (variant.review_status !== "approved" || variant.revision !== input.expectedRevision || variant.approved_revision !== variant.revision || variant.approval_hash === null) {
        return Promise.resolve({ kind: "not-approved" })
      }
      const channel = channels.get(variant.channel_code)
      const mode = channel?.publish_mode
      if (mode === undefined || mode === "disabled") {
        return Promise.resolve({ kind: "channel-disabled" })
      }
      const account = resolveJobAccount(input.channelAccount, channel?.account_ref ?? null)
      if (account === null) {
        return Promise.resolve({ kind: "invalid-account" })
      }
      const duplicate = [...jobs.values()].some(
        (job) => job.variant_id === variant.id && job.variant_revision === variant.revision && job.channel_account === account && job.destination_code === variant.destination_code,
      )
      if (duplicate) {
        return Promise.resolve({ kind: "duplicate" })
      }
      const at = now()
      const job: MarketingDistributionJobRow = {
        id: randomUUID(),
        variant_id: variant.id,
        variant_revision: variant.revision,
        approval_hash: variant.approval_hash,
        channel_code: variant.channel_code,
        destination_code: variant.destination_code,
        order_url: variant.order_url,
        payload: variantPayload(variant),
        channel_account: account,
        publish_mode: mode,
        status: mode === "manual" ? "manual_ready" : "queued",
        scheduled_at: input.scheduledAt ?? null,
        attempt: 0,
        provider_post_id: null,
        posted_url: null,
        confirmed_by: null,
        confirmed_at: null,
        last_error_code: null,
        created_by: input.createdBy,
        created_at: at,
        updated_at: at,
      }
      jobs.set(job.id, job)
      return Promise.resolve({ kind: "created", job })
    },
    findJob: (jobId) => Promise.resolve(jobs.get(jobId) ?? null),
    listJobs: (variantId) => Promise.resolve([...jobs.values()].filter((job) => job.variant_id === variantId)),

    transitionJob(jobId, expectedStatus, nextStatus, patch) {
      if (!canTransitionJob(expectedStatus, nextStatus)) {
        return Promise.resolve({ kind: "forbidden" })
      }
      const current = jobs.get(jobId)
      if (current === undefined) {
        return Promise.resolve({ kind: "stale" })
      }
      if (current.status !== expectedStatus) {
        return Promise.resolve({ kind: "stale" })
      }
      const row: MarketingDistributionJobRow = {
        ...current,
        status: nextStatus,
        posted_url: patch?.postedUrl ?? current.posted_url,
        confirmed_by: patch?.confirmedBy ?? current.confirmed_by,
        confirmed_at: patch?.confirmedAt ?? current.confirmed_at,
        provider_post_id: patch?.providerPostId ?? current.provider_post_id,
        last_error_code: patch?.lastErrorCode ?? current.last_error_code,
        updated_at: now(),
      }
      // DB CHECK(marketing_distribution_jobs_confirmed_check)와 같은 규칙 — Supabase 구현에서는 DB가 거부한다.
      if (row.status === "manual_confirmed" && (row.posted_url === null || row.confirmed_by === null || row.confirmed_at === null)) {
        return Promise.reject(new Error("marketing_distribution_jobs_confirmed_check: 게시 주소·확인자·확인 시각이 필요합니다"))
      }
      jobs.set(jobId, row)
      return Promise.resolve({ kind: "updated", row })
    },

    listPostedPayloads(channelCode, limit) {
      const posted = [...jobs.values()]
        .filter((job) => job.channel_code === channelCode && (job.status === "manual_confirmed" || job.status === "published"))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      return Promise.resolve(posted.slice(0, limit).map((job) => job.payload))
    },

    appendEvent(input) {
      events.push({
        id: randomUUID(),
        variant_id: input.variantId,
        job_id: input.jobId ?? null,
        event_type: input.eventType,
        from_status: input.fromStatus ?? null,
        to_status: input.toStatus ?? null,
        variant_revision: input.variantRevision ?? null,
        actor: input.actor,
        detail: input.detail ?? {},
        created_at: now(),
      })
      return Promise.resolve()
    },
    listEvents: (variantId) => Promise.resolve(events.filter((event) => event.variant_id === variantId)),

    upsertMetrics(observations) {
      const unique = dedupeObservations(observations)
      for (const observation of unique) {
        const dimensionKey = metricDimensionKey(observation)
        const key = `${observation.date}|${observation.source}|${dimensionKey}`
        metrics.set(key, {
          id: metrics.get(key)?.id ?? randomUUID(),
          date: observation.date,
          source: observation.source,
          dimension_key: dimensionKey,
          channel_code: observation.channelCode ?? null,
          campaign_id: observation.campaignId ?? null,
          variant_id: observation.variantId ?? null,
          destination_code: observation.destinationCode ?? null,
          impressions: observation.impressions ?? null,
          clicks: observation.clicks ?? null,
          visits: observation.visits ?? null,
          orders: observation.orders ?? null,
          revenue_krw: observation.revenueKrw ?? null,
          ad_cost_krw: observation.adCostKrw ?? null,
          work_minutes: observation.workMinutes ?? null,
          attribution_note: observation.attributionNote ?? null,
          fetched_at: now(),
        })
      }
      return Promise.resolve(unique.length)
    },
    listMetrics: (range) => Promise.resolve([...metrics.values()].filter((row) => row.date >= range.from && row.date <= range.to)),
  }
}
