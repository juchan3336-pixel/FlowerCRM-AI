// 광고 배포 저장소 계약 — Supabase 구현(supabase-repository.ts)과 메모리 구현(in-memory-repository.ts)이 함께 따른다.
//
// 상태를 바꾸는 연산은 전부 "기대 값이 일치할 때만" 갱신한다(조건부 UPDATE). 기대와 다르면 stale을 돌려주고
// 아무것도 바꾸지 않는다 — 두 사람이 같은 소재를 동시에 고치거나 같은 버튼을 두 번 눌러도 한 번만 반영된다.
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
import type { ContentMode } from "@/lib/ai/content-mode"

import type { DistributionJobStatus, MarketingChannelCode, MarketingMetricSource, MarketingVariantDraft, OrderDestinationCode, TrackingKind } from "./types"

export type CasResult<Row> = { readonly kind: "updated"; readonly row: Row } | { readonly kind: "stale" }

export type CreateCampaignInput = {
  readonly code: string
  readonly name: string
  readonly mode: ContentMode
  readonly region?: string | null
  readonly startsOn?: string | null
  readonly endsOn?: string | null
  readonly budgetCapKrw?: number | null
  readonly productUrls?: Readonly<Partial<Record<OrderDestinationCode, string>>>
  readonly createdBy: string
}

// 사용 이미지 한 장 — 내용 해시까지 함께 고정한다(같은 경로에 다른 파일이 올라와도 승인본은 달라지지 않는다)
export type VariantImageRef = {
  readonly image_id: string
  readonly content_hash: string
}

// 소재의 내용 — 이 중 하나라도 바뀌면 revision이 올라간다
export type VariantContent = {
  readonly destinationCode: OrderDestinationCode
  readonly orderUrl: string
  readonly trackingKind: TrackingKind
  readonly trackingParams: Readonly<Record<string, string>>
  readonly title: string
  readonly body: string
  readonly caption: string | null
  readonly imageTexts: readonly string[]
  readonly imageRefs: readonly VariantImageRef[]
}

export type CreateVariantInput = VariantContent & {
  readonly campaignId: string
  readonly code: string
  readonly channelCode: MarketingChannelCode
  readonly mode: ContentMode
  readonly createdBy: string
}

export type VariantApprovalInput = {
  readonly approvalHash: string
  readonly approvedBy: string
  readonly approvedAt: string
}

export type CreateJobInput = {
  readonly variantId: string
  readonly variantRevision: number
  readonly approvalHash: string
  readonly channelCode: MarketingChannelCode
  readonly destinationCode: OrderDestinationCode
  readonly orderUrl: string
  readonly channelAccount?: string
  readonly publishMode: "manual" | "api"
  readonly scheduledAt?: string | null
  readonly createdBy: string
}

// 작업 상태를 바꾸면서 함께 기록할 값
export type JobTransitionPatch = {
  readonly postedUrl?: string
  readonly confirmedBy?: string
  readonly confirmedAt?: string
  readonly providerPostId?: string
  readonly lastErrorCode?: string
}

export type AppendEventInput = {
  readonly variantId: string
  readonly jobId?: string | null
  readonly eventType: string
  readonly fromStatus?: string | null
  readonly toStatus?: string | null
  readonly variantRevision?: number | null
  readonly actor: string
  readonly detail?: Json
}

// 일별 성과 관측값 한 건. 수집하지 못한 지표는 생략(null) — 0으로 채우지 않는다.
export type MetricObservation = {
  readonly date: string
  readonly source: MarketingMetricSource
  readonly channelCode?: MarketingChannelCode | null
  readonly campaignId?: string | null
  readonly variantId?: string | null
  readonly destinationCode?: OrderDestinationCode | null
  readonly impressions?: number | null
  readonly clicks?: number | null
  readonly visits?: number | null
  readonly orders?: number | null
  readonly revenueKrw?: number | null
  readonly adCostKrw?: number | null
  readonly workMinutes?: number | null
  readonly attributionNote?: string | null
}

export type MarketingRepository = {
  listDestinations(): Promise<readonly MarketingDestinationRow[]>
  listChannels(): Promise<readonly MarketingChannelRow[]>

  createCampaign(input: CreateCampaignInput): Promise<{ readonly kind: "created"; readonly campaign: MarketingCampaignRow } | { readonly kind: "code-taken" }>
  findCampaign(campaignId: string): Promise<MarketingCampaignRow | null>
  listCampaigns(): Promise<readonly MarketingCampaignRow[]>

  createVariant(input: CreateVariantInput): Promise<{ readonly kind: "created"; readonly variant: MarketingVariantRow } | { readonly kind: "code-taken" }>
  findVariant(variantId: string): Promise<MarketingVariantRow | null>
  listVariants(campaignId: string): Promise<readonly MarketingVariantRow[]>

  // 내용 수정 — revision을 1 올리고 draft로 되돌리며 품질 결과와 승인 스냅샷을 지운다.
  reviseVariant(variantId: string, expectedRevision: number, content: VariantContent): Promise<CasResult<MarketingVariantRow>>
  // 품질 검사 결과 기록. passed=true면 draft → needs_review, false면 draft에 머문다.
  recordReview(variantId: string, expectedRevision: number, quality: Json, passed: boolean): Promise<CasResult<MarketingVariantRow>>
  // needs_review → approved. 현재 revision에 대한 품질 검사가 있어야 한다.
  approveVariant(variantId: string, expectedRevision: number, approval: VariantApprovalInput): Promise<CasResult<MarketingVariantRow>>

  createJob(input: CreateJobInput): Promise<{ readonly kind: "created"; readonly job: MarketingDistributionJobRow } | { readonly kind: "duplicate" }>
  findJob(jobId: string): Promise<MarketingDistributionJobRow | null>
  listJobs(variantId: string): Promise<readonly MarketingDistributionJobRow[]>
  transitionJob(jobId: string, expectedStatus: DistributionJobStatus, nextStatus: DistributionJobStatus, patch?: JobTransitionPatch): Promise<CasResult<MarketingDistributionJobRow>>
  // 아직 외부에 나가지 않은 작업(manual_ready·queued)을 폐기한다. 폐기한 건수를 돌려준다.
  cancelOpenJobs(variantId: string): Promise<number>

  appendEvent(input: AppendEventInput): Promise<void>
  listEvents(variantId: string): Promise<readonly MarketingDistributionEventRow[]>

  // 같은 (날짜, 출처, 집계 단위)는 덮어쓴다 — 같은 보고서를 다시 가져와도 행이 늘지 않는다.
  upsertMetrics(observations: readonly MetricObservation[]): Promise<number>
  listMetrics(range: { readonly from: string; readonly to: string }): Promise<readonly MarketingMetricsDailyRow[]>
}

// 집계 단위 키 — 차원 열을 고정 순서로 이은 값. 없는 차원은 빈 문자열.
export function metricDimensionKey(observation: MetricObservation): string {
  return [observation.channelCode ?? "", observation.campaignId ?? "", observation.variantId ?? "", observation.destinationCode ?? ""].join("|")
}

// 같은 호출 안에 같은 관측 키가 두 번 있으면 마지막 값만 남긴다(한 번의 upsert에서 같은 행을 두 번 건드리지 않도록).
export function dedupeObservations(observations: readonly MetricObservation[]): readonly MetricObservation[] {
  const byKey = new Map<string, MetricObservation>()
  for (const observation of observations) {
    byKey.set(`${observation.date}|${observation.source}|${metricDimensionKey(observation)}`, observation)
  }
  return [...byKey.values()]
}

function isImageRef(value: unknown): value is VariantImageRef {
  return typeof value === "object" && value !== null && "image_id" in value && "content_hash" in value && typeof value.image_id === "string" && typeof value.content_hash === "string"
}

export function variantImageRefs(row: Pick<MarketingVariantRow, "image_refs">): readonly VariantImageRef[] {
  return Array.isArray(row.image_refs) ? row.image_refs.filter(isImageRef) : []
}

// 저장된 소재를 승인 해시·품질 검사가 받는 형태로 바꾼다.
// 이미지는 경로가 아니라 내용 해시로 넣는다 — 파일이 바뀌면 승인 해시도 달라진다.
export function variantRowToDraft(row: MarketingVariantRow): MarketingVariantDraft {
  return {
    mode: row.mode,
    channel: row.channel_code,
    destination: row.destination_code,
    orderUrl: row.order_url,
    copy: {
      title: row.title,
      body: row.body,
      ...(row.caption === null ? {} : { caption: row.caption }),
      ...(row.image_texts.length === 0 ? {} : { imageTexts: row.image_texts }),
    },
    imageRefs: variantImageRefs(row).map((ref) => ref.content_hash),
    revision: row.revision,
  }
}
