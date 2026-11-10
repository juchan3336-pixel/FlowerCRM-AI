import "server-only"

// 광고 배포 저장소의 Supabase 구현 — service role 서버 경로 전용.
// 상태 전이는 전부 조건부 UPDATE다: 기대 revision·상태가 다르면 0행 갱신(stale)이고 아무것도 바뀌지 않는다.
// 유일 키 충돌(23505)은 오류가 아니라 결과 값(code-taken·duplicate)으로, 외래 키·CHECK 위반은 invalid로 돌려준다.
// 입력 검증은 repository.ts의 공통 함수를 메모리 구현과 함께 쓴다. DB 제약·트리거는 그 뒤의 마지막 방어선이다.
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { Json, MarketingDistributionJobRow } from "@/types/database"

import { canTransitionJob, CANCELLABLE_JOB_STATUSES, REVISION_LOCKING_JOB_STATUSES } from "./distribution-state"
import {
  dedupeObservations,
  imageRefsMatch,
  isAccountName,
  metricDimensionKey,
  validateCampaignInput,
  validateImageInput,
  validateProductUrls,
  validateVariantContent,
  validateVariantInput,
  type CreateJobResult,
  type InvalidReason,
  type MarketingRepository,
  type VariantContent,
} from "./repository"

const UNIQUE_VIOLATION = "23505"
const FOREIGN_KEY_VIOLATION = "23503"
const CHECK_VIOLATION = "23514"
// 상품 주소 저장이 겹쳤을 때 버전 올리기를 몇 번까지 다시 시도할지
const VERSION_BUMP_ATTEMPTS = 5
// DB 트리거 marketing_variants_check_link_version이 내는 오류 메시지의 표지
const LINK_VERSION_MARK = "link version"

function contentColumns(content: VariantContent): Record<string, Json> {
  return {
    destination_code: content.destinationCode,
    order_url: content.orderUrl,
    tracking_kind: content.trackingKind,
    tracking_params: { ...content.trackingParams },
    link_version: content.linkVersion,
    title: content.title,
    body: content.body,
    caption: content.caption,
    image_texts: [...content.imageTexts],
    image_refs: content.imageRefs.map((ref) => ({ image_id: ref.image_id, content_hash: ref.content_hash })),
  }
}

// DB가 거부한 제약 위반을 계약의 reason으로 옮긴다. 그 밖의 오류는 null(던진다).
function invalidReasonOf(code: string): InvalidReason | null {
  if (code === FOREIGN_KEY_VIOLATION) {
    return "reference-not-found"
  }
  return code === CHECK_VIOLATION ? "constraint" : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// create_marketing_distribution_job의 반환값({"kind": ..., "job"?: ...}) 해석
function parseCreateJobResult(data: unknown): CreateJobResult {
  if (isRecord(data)) {
    if (data["kind"] === "created" && isRecord(data["job"])) {
      return { kind: "created", job: data["job"] as unknown as MarketingDistributionJobRow }
    }
    if (data["kind"] === "duplicate" || data["kind"] === "not-approved" || data["kind"] === "channel-disabled" || data["kind"] === "invalid-account") {
      return { kind: data["kind"] }
    }
  }
  throw new SupabaseMarketingRepositoryError("create job", "unexpected function result")
}

export function createSupabaseMarketingRepository(): MarketingRepository {
  const client = createSupabaseServiceRoleClient()

  async function findImages(imageIds: readonly string[]) {
    if (imageIds.length === 0) {
      return []
    }
    const { data, error } = await client.from("marketing_images").select("*").in("id", [...imageIds])
    if (error !== null) {
      throw new SupabaseMarketingRepositoryError("find images", error.message)
    }
    return data
  }

  async function contentInvalid(content: VariantContent): Promise<InvalidReason | null> {
    const reason = validateVariantContent(content)
    if (reason !== null) {
      return reason
    }
    const images = await findImages(content.imageRefs.map((ref) => ref.image_id))
    return imageRefsMatch(content.imageRefs, images) ? null : "image-ref"
  }

  return {
    async listDestinations() {
      const { data, error } = await client.from("marketing_destinations").select("*").order("code")
      if (error !== null) {
        throw new SupabaseMarketingRepositoryError("list destinations", error.message)
      }
      return data
    },

    async listChannels() {
      const { data, error } = await client.from("marketing_channels").select("*").order("tier").order("code")
      if (error !== null) {
        throw new SupabaseMarketingRepositoryError("list channels", error.message)
      }
      return data
    },

    async updateChannel(code, patch) {
      if (typeof patch.accountRef === "string" && !isAccountName(patch.accountRef)) {
        return { kind: "invalid", reason: "account-format" }
      }
      const update: Record<string, Json> = {}
      if (patch.publishMode !== undefined) {
        update["publish_mode"] = patch.publishMode
      }
      if (patch.accountRef !== undefined) {
        update["account_ref"] = patch.accountRef
      }
      const query = Object.keys(update).length === 0 ? client.from("marketing_channels").select("*").eq("code", code) : client.from("marketing_channels").update(update).eq("code", code).select("*")
      const { data, error } = await query.maybeSingle()
      if (error !== null) {
        throw new SupabaseMarketingRepositoryError("update channel", error.message)
      }
      return data === null ? { kind: "not-found" } : { kind: "updated", channel: data }
    },

    async registerImage(input) {
      const reason = validateImageInput(input)
      if (reason !== null) {
        return { kind: "invalid", reason }
      }
      const { data, error } = await client
        .from("marketing_images")
        .insert({
          storage_path: input.storagePath,
          content_hash: input.contentHash,
          kind: input.kind,
          is_real_photo: input.isRealPhoto,
          rights_status: input.rightsStatus,
          width: input.width ?? null,
          height: input.height ?? null,
          note: input.note ?? null,
          created_by: input.createdBy,
        })
        .select("*")
        .single()
      if (error !== null) {
        if (error.code === UNIQUE_VIOLATION) {
          return { kind: "duplicate" }
        }
        const invalid = invalidReasonOf(error.code)
        if (invalid !== null) {
          return { kind: "invalid", reason: invalid }
        }
        throw new SupabaseMarketingRepositoryError("register image", error.message)
      }
      return { kind: "created", image: data }
    },

    findImages,

    async createCampaign(input) {
      const reason = validateCampaignInput(input)
      if (reason !== null) {
        return { kind: "invalid", reason }
      }
      const { data, error } = await client
        .from("marketing_campaigns")
        .insert({
          code: input.code,
          name: input.name,
          mode: input.mode,
          region: input.region ?? null,
          starts_on: input.startsOn ?? null,
          ends_on: input.endsOn ?? null,
          budget_cap_krw: input.budgetCapKrw ?? null,
          product_urls: { ...input.productUrls },
          created_by: input.createdBy,
        })
        .select("*")
        .single()
      if (error !== null) {
        if (error.code === UNIQUE_VIOLATION) {
          return { kind: "code-taken" }
        }
        const invalid = invalidReasonOf(error.code)
        if (invalid !== null) {
          return { kind: "invalid", reason: invalid }
        }
        throw new SupabaseMarketingRepositoryError("create campaign", error.message)
      }
      return { kind: "created", campaign: data }
    },

    async updateCampaignProductUrls(campaignId, productUrls) {
      const reason = validateProductUrls(productUrls)
      if (reason !== null) {
        return { kind: "invalid", reason }
      }
      // 버전을 1 올리는 조건부 갱신 — 읽은 버전이 그대로일 때만 쓴다. 동시에 다른 저장이 있었다면 다시 읽어 시도한다.
      for (let attempt = 0; attempt < VERSION_BUMP_ATTEMPTS; attempt += 1) {
        const current = await client.from("marketing_campaigns").select("product_urls_version").eq("id", campaignId).maybeSingle()
        if (current.error !== null) {
          throw new SupabaseMarketingRepositoryError("read campaign version", current.error.message)
        }
        if (current.data === null) {
          return { kind: "not-found" }
        }
        const version = current.data.product_urls_version
        const { data, error } = await client
          .from("marketing_campaigns")
          .update({ product_urls: { ...productUrls }, product_urls_version: version + 1 })
          .eq("id", campaignId)
          .eq("product_urls_version", version)
          .select("*")
          .maybeSingle()
        if (error !== null) {
          throw new SupabaseMarketingRepositoryError("update campaign product urls", error.message)
        }
        if (data !== null) {
          return { kind: "updated", campaign: data }
        }
      }
      throw new SupabaseMarketingRepositoryError("update campaign product urls", "version changed repeatedly")
    },

    async findCampaign(campaignId) {
      const { data, error } = await client.from("marketing_campaigns").select("*").eq("id", campaignId).maybeSingle()
      if (error !== null) {
        throw new SupabaseMarketingRepositoryError("find campaign", error.message)
      }
      return data
    },

    async listCampaigns() {
      const { data, error } = await client.from("marketing_campaigns").select("*").order("created_at", { ascending: false })
      if (error !== null) {
        throw new SupabaseMarketingRepositoryError("list campaigns", error.message)
      }
      return data
    },

    async createVariant(input) {
      const reason = validateVariantInput(input) ?? (await contentInvalid(input))
      if (reason !== null) {
        return { kind: "invalid", reason }
      }
      const { data, error } = await client
        .from("marketing_variants")
        .insert({ campaign_id: input.campaignId, code: input.code, channel_code: input.channelCode, mode: input.mode, created_by: input.createdBy, ...contentColumns(input) })
        .select("*")
        .single()
      if (error !== null) {
        if (error.code === UNIQUE_VIOLATION) {
          return { kind: "code-taken" }
        }
        if (error.code === CHECK_VIOLATION && error.message.includes(LINK_VERSION_MARK)) {
          return { kind: "campaign-changed" }
        }
        const invalid = invalidReasonOf(error.code)
        if (invalid !== null) {
          return { kind: "invalid", reason: invalid }
        }
        throw new SupabaseMarketingRepositoryError("create variant", error.message)
      }
      return { kind: "created", variant: data }
    },

    async findVariant(variantId) {
      const { data, error } = await client.from("marketing_variants").select("*").eq("id", variantId).maybeSingle()
      if (error !== null) {
        throw new SupabaseMarketingRepositoryError("find variant", error.message)
      }
      return data
    },

    async listVariants(campaignId) {
      const { data, error } = await client.from("marketing_variants").select("*").eq("campaign_id", campaignId).order("created_at", { ascending: false })
      if (error !== null) {
        throw new SupabaseMarketingRepositoryError("list variants", error.message)
      }
      return data
    },

    async reviseVariant(variantId, expectedRevision, content) {
      const reason = await contentInvalid(content)
      if (reason !== null) {
        return { kind: "invalid", reason }
      }
      // 게시됐거나 게시 결과 확인 중인 작업이 있으면 고칠 수 없다. 이 조회와 아래 갱신 사이에 게시 확인이 끼어드는
      // 경우는 DB 트리거(marketing_variants_block_revise_after_post)가 막는다 — 그때는 아래에서 locked로 옮긴다.
      const locking = await client.from("marketing_distribution_jobs").select("id").eq("variant_id", variantId).in("status", [...REVISION_LOCKING_JOB_STATUSES]).limit(1)
      if (locking.error !== null) {
        throw new SupabaseMarketingRepositoryError("check posted jobs", locking.error.message)
      }
      if (locking.data.length > 0) {
        return { kind: "locked" }
      }
      const { data, error } = await client
        .from("marketing_variants")
        .update({
          ...contentColumns(content),
          revision: expectedRevision + 1,
          review_status: "draft",
          quality_report: null,
          quality_checked_revision: null,
          approved_revision: null,
          approval_hash: null,
          approved_by: null,
          approved_at: null,
        })
        .eq("id", variantId)
        .eq("revision", expectedRevision)
        .select("*")
        .maybeSingle()
      if (error !== null) {
        if (error.code === CHECK_VIOLATION && error.message.includes("already posted")) {
          return { kind: "locked" }
        }
        if (error.code === CHECK_VIOLATION && error.message.includes(LINK_VERSION_MARK)) {
          return { kind: "campaign-changed" }
        }
        const invalid = invalidReasonOf(error.code)
        if (invalid !== null) {
          return { kind: "invalid", reason: invalid }
        }
        throw new SupabaseMarketingRepositoryError("revise variant", error.message)
      }
      if (data === null) {
        return { kind: "stale" }
      }
      // 수정 전 revision까지의 게시 전 작업만 폐기한다. revision 상한이 있으므로, 이 호출이 늦게 도착해도
      // 그사이 새 revision으로 만들어진 작업은 건드리지 않는다.
      const cancelled = await client
        .from("marketing_distribution_jobs")
        .update({ status: "cancelled" })
        .eq("variant_id", variantId)
        .lte("variant_revision", expectedRevision)
        .in("status", [...CANCELLABLE_JOB_STATUSES])
        .select("id")
      if (cancelled.error !== null) {
        throw new SupabaseMarketingRepositoryError("cancel superseded jobs", cancelled.error.message)
      }
      return { kind: "updated", row: data, cancelledJobs: cancelled.data.length }
    },

    async recordReview(variantId, expectedRevision, quality, passed) {
      const { data, error } = await client
        .from("marketing_variants")
        .update({ quality_report: quality, quality_checked_revision: expectedRevision, review_status: passed ? "needs_review" : "draft" })
        .eq("id", variantId)
        .eq("revision", expectedRevision)
        .eq("review_status", "draft")
        .select("*")
        .maybeSingle()
      if (error !== null) {
        throw new SupabaseMarketingRepositoryError("record review", error.message)
      }
      return data === null ? { kind: "stale" } : { kind: "updated", row: data }
    },

    async approveVariant(variantId, expectedRevision, approval) {
      const { data, error } = await client
        .from("marketing_variants")
        .update({ review_status: "approved", approved_revision: expectedRevision, approval_hash: approval.approvalHash, approved_by: approval.approvedBy, approved_at: approval.approvedAt })
        .eq("id", variantId)
        .eq("revision", expectedRevision)
        .eq("review_status", "needs_review")
        .eq("quality_checked_revision", expectedRevision)
        .not("quality_report", "is", null)
        .select("*")
        .maybeSingle()
      if (error !== null) {
        throw new SupabaseMarketingRepositoryError("approve variant", error.message)
      }
      return data === null ? { kind: "stale" } : { kind: "updated", row: data }
    },

    // 판정과 복사는 DB 함수가 소재 행을 잠근 채 한 번에 한다 — 읽고 나서 넣는 사이에 소재가 바뀌는 틈이 없다.
    async createJob(input) {
      const { data, error } = await client.rpc("create_marketing_distribution_job", {
        p_variant_id: input.variantId,
        p_expected_revision: input.expectedRevision,
        p_channel_account: input.channelAccount ?? "",
        p_scheduled_at: input.scheduledAt ?? null,
        p_created_by: input.createdBy,
      })
      if (error !== null) {
        throw new SupabaseMarketingRepositoryError("create job", error.message)
      }
      return parseCreateJobResult(data)
    },

    async findJob(jobId) {
      const { data, error } = await client.from("marketing_distribution_jobs").select("*").eq("id", jobId).maybeSingle()
      if (error !== null) {
        throw new SupabaseMarketingRepositoryError("find job", error.message)
      }
      return data
    },

    async listJobs(variantId) {
      const { data, error } = await client.from("marketing_distribution_jobs").select("*").eq("variant_id", variantId).order("created_at", { ascending: false })
      if (error !== null) {
        throw new SupabaseMarketingRepositoryError("list jobs", error.message)
      }
      return data
    },

    async transitionJob(jobId, expectedStatus, nextStatus, patch) {
      if (!canTransitionJob(expectedStatus, nextStatus)) {
        return { kind: "forbidden" }
      }
      const update: Record<string, Json> = { status: nextStatus }
      if (patch?.postedUrl !== undefined) {
        update["posted_url"] = patch.postedUrl
      }
      if (patch?.confirmedBy !== undefined) {
        update["confirmed_by"] = patch.confirmedBy
      }
      if (patch?.confirmedAt !== undefined) {
        update["confirmed_at"] = patch.confirmedAt
      }
      if (patch?.providerPostId !== undefined) {
        update["provider_post_id"] = patch.providerPostId
      }
      if (patch?.lastErrorCode !== undefined) {
        update["last_error_code"] = patch.lastErrorCode
      }
      const { data, error } = await client.from("marketing_distribution_jobs").update(update).eq("id", jobId).eq("status", expectedStatus).select("*").maybeSingle()
      // 소재가 그사이 수정되어 이 작업이 현재 승인본이 아니면 DB 트리거가 게시 확인을 거부한다 — stale로 옮긴다.
      if (error?.code === CHECK_VIOLATION && error.message.includes("superseded")) {
        return { kind: "stale" }
      }
      if (error !== null) {
        throw new SupabaseMarketingRepositoryError("transition job", error.message)
      }
      return data === null ? { kind: "stale" } : { kind: "updated", row: data }
    },

    async listPostedPayloads(channelCode, limit) {
      const { data, error } = await client
        .from("marketing_distribution_jobs")
        .select("variant_id, payload")
        .eq("channel_code", channelCode)
        .in("status", ["manual_confirmed", "published"])
        .order("updated_at", { ascending: false })
        .limit(limit)
      if (error !== null) {
        throw new SupabaseMarketingRepositoryError("list posted payloads", error.message)
      }
      return data.map((row) => ({ variantId: row.variant_id, payload: row.payload }))
    },

    async appendEvent(input) {
      const { error } = await client.from("marketing_distribution_events").insert({
        variant_id: input.variantId,
        job_id: input.jobId ?? null,
        event_type: input.eventType,
        from_status: input.fromStatus ?? null,
        to_status: input.toStatus ?? null,
        variant_revision: input.variantRevision ?? null,
        actor: input.actor,
        detail: input.detail ?? {},
      })
      if (error !== null) {
        throw new SupabaseMarketingRepositoryError("append event", error.message)
      }
    },

    async listEvents(variantId) {
      const { data, error } = await client.from("marketing_distribution_events").select("*").eq("variant_id", variantId).order("created_at", { ascending: false })
      if (error !== null) {
        throw new SupabaseMarketingRepositoryError("list events", error.message)
      }
      return data
    },

    async upsertMetrics(observations) {
      const unique = dedupeObservations(observations)
      if (unique.length === 0) {
        return 0
      }
      const fetchedAt = new Date().toISOString()
      const rows = unique.map((observation) => ({
        date: observation.date,
        source: observation.source,
        dimension_key: metricDimensionKey(observation),
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
        fetched_at: fetchedAt,
      }))
      const { error } = await client.from("marketing_metrics_daily").upsert(rows, { onConflict: "date,source,dimension_key" })
      if (error !== null) {
        throw new SupabaseMarketingRepositoryError("upsert metrics", error.message)
      }
      return rows.length
    },

    async listMetrics(range) {
      const { data, error } = await client.from("marketing_metrics_daily").select("*").gte("date", range.from).lte("date", range.to).order("date", { ascending: false })
      if (error !== null) {
        throw new SupabaseMarketingRepositoryError("list metrics", error.message)
      }
      return data
    },
  }
}

export class SupabaseMarketingRepositoryError extends Error {
  readonly name = "SupabaseMarketingRepositoryError"

  constructor(operation: string, detail: string) {
    super(`Marketing repository failed (${operation}): ${detail}`)
  }
}
