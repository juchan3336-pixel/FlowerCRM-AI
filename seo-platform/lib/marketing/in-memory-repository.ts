// 광고 배포 저장소의 메모리 구현 — 테스트와 DB 없는 미리보기용.
// DB 제약(유일 키, 승인·게시 확인 CHECK, 조건부 갱신)을 같은 규칙으로 흉내 낸다.
import { randomUUID } from "node:crypto"

import type {
  Json,
  MarketingCampaignRow,
  MarketingChannelRow,
  MarketingDestinationRow,
  MarketingDistributionEventRow,
  MarketingDistributionJobRow,
  MarketingMetricsDailyRow,
  MarketingVariantRow,
} from "@/types/database"

import { listMarketingChannels } from "./channel-policy"
import { CANCELLABLE_JOB_STATUSES } from "./distribution-state"
import { listOrderDestinations } from "./order-destination"
import { dedupeObservations, metricDimensionKey, type MarketingRepository, type VariantContent } from "./repository"
import type { DistributionJobStatus } from "./types"

const MANUAL_STATUSES: readonly DistributionJobStatus[] = ["manual_ready", "manual_confirmed"]

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
  const channels: MarketingChannelRow[] = listMarketingChannels().map((channel) => ({
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
  }))
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

  return {
    listDestinations: () => Promise.resolve(destinations),
    listChannels: () => Promise.resolve(channels),

    createCampaign(input) {
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
      return Promise.resolve({ kind: "updated", row })
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
      if (current.revision !== expectedRevision || current.review_status !== "needs_review" || current.quality_checked_revision !== current.revision) {
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

    createJob(input) {
      const account = input.channelAccount ?? ""
      const duplicate = [...jobs.values()].some(
        (job) => job.variant_id === input.variantId && job.variant_revision === input.variantRevision && job.channel_account === account && job.destination_code === input.destinationCode,
      )
      if (duplicate) {
        return Promise.resolve({ kind: "duplicate" })
      }
      const at = now()
      const job: MarketingDistributionJobRow = {
        id: randomUUID(),
        variant_id: input.variantId,
        variant_revision: input.variantRevision,
        approval_hash: input.approvalHash,
        channel_code: input.channelCode,
        destination_code: input.destinationCode,
        order_url: input.orderUrl,
        channel_account: account,
        publish_mode: input.publishMode,
        status: input.publishMode === "manual" ? "manual_ready" : "queued",
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
      // DB CHECK와 같은 규칙 — 위반은 저장하지 않고 던진다(Supabase 구현에서는 DB가 거부한다).
      if (row.status !== "cancelled" && MANUAL_STATUSES.includes(row.status) !== (row.publish_mode === "manual")) {
        return Promise.reject(new Error(`marketing_distribution_jobs_mode_status_check: ${row.publish_mode} → ${row.status}`))
      }
      if (row.status === "manual_confirmed" && (row.posted_url === null || row.confirmed_by === null || row.confirmed_at === null)) {
        return Promise.reject(new Error("marketing_distribution_jobs_confirmed_check: 게시 주소·확인자·확인 시각이 필요합니다"))
      }
      jobs.set(jobId, row)
      return Promise.resolve({ kind: "updated", row })
    },

    cancelOpenJobs(variantId) {
      let cancelled = 0
      for (const job of jobs.values()) {
        if (job.variant_id === variantId && CANCELLABLE_JOB_STATUSES.includes(job.status)) {
          jobs.set(job.id, { ...job, status: "cancelled", updated_at: now() })
          cancelled += 1
        }
      }
      return Promise.resolve(cancelled)
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
