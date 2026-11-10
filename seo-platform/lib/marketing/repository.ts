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
  MarketingImageRow,
  MarketingMetricsDailyRow,
  MarketingVariantRow,
} from "@/types/database"
import type { ContentMode } from "@/lib/ai/content-mode"

import { checkDestinationUrl } from "./order-destination"
import { isTrackingCode } from "./tracking-url"
import type { DistributionJobStatus, MarketingChannelCode, MarketingMetricSource, MarketingVariantDraft, OrderDestinationCode, PublishMode, TrackingKind } from "./types"

export type CasResult<Row> = { readonly kind: "updated"; readonly row: Row } | { readonly kind: "stale" }

// 저장 전에 거부된 입력. 두 구현이 같은 입력에 같은 reason을 돌려준다.
//   code-format         코드가 영문/숫자/-_ 1~50자가 아님
//   period              종료일이 시작일보다 빠름
//   budget              예산이 음수이거나 정수가 아님
//   order-url           주문 링크가 그 목적지의 허용 범위 밖
//   reference-not-found 가리키는 캠페인이 없음
//   image-ref           등록되지 않은 이미지이거나 적힌 해시가 그 이미지의 해시와 다름
//   content-hash        이미지 해시가 SHA-256(hex 64자)이 아님
//   image-size          이미지 가로·세로가 양의 정수가 아님
//   account-format      게시 계정 이름이 공백 없는 한글/영문/숫자/._@- 1~100자가 아님
//   constraint          그 밖의 DB 제약 위반
export type InvalidReason = "code-format" | "period" | "budget" | "order-url" | "reference-not-found" | "image-ref" | "content-hash" | "image-size" | "account-format" | "constraint"
export type InvalidResult = { readonly kind: "invalid"; readonly reason: InvalidReason }

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
  // 이 주문 링크를 조립할 때 읽은 캠페인의 product_urls_version.
  // 저장 시점에 캠페인의 현재 버전과 다르면 저장이 거부된다 — 옛 상품 주소로 만든 링크가 최신 링크를 덮어쓰지 못한다.
  readonly linkVersion: number
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

// 배포 작업 생성 입력 — 무엇을 내보낼지는 넘기지 않는다. 저장소가 현재 승인본에서 직접 복사한다.
export type CreateJobInput = {
  readonly variantId: string
  // 호출자가 보고 있던 revision. 그사이 소재가 바뀌었으면 작업이 생기지 않는다.
  readonly expectedRevision: number
  // 게시 계정. 생략하면 작업 생성 시점의 채널 계정(account_ref)이 작업에 고정된다.
  readonly channelAccount?: string
  readonly scheduledAt?: string | null
  readonly createdBy: string
}

export type CreateJobResult =
  | { readonly kind: "created"; readonly job: MarketingDistributionJobRow }
  // 같은 승인본을 같은 계정·목적지로 이미 내보냈다
  | { readonly kind: "duplicate" }
  // 소재가 없거나, 승인 상태가 아니거나, 기대한 revision이 아니다
  | { readonly kind: "not-approved" }
  // 채널 배포가 중지되어 있다
  | { readonly kind: "channel-disabled" }
  // 지정한 게시 계정 이름이 형식에 맞지 않는다
  | { readonly kind: "invalid-account" }

export type RegisterImageInput = {
  readonly storagePath: string
  readonly contentHash: string
  readonly kind: MarketingImageRow["kind"]
  readonly isRealPhoto: boolean
  readonly rightsStatus: MarketingImageRow["rights_status"]
  readonly width?: number | null
  readonly height?: number | null
  readonly note?: string | null
  readonly createdBy: string
}

export type ChannelSettingsPatch = {
  readonly publishMode?: PublishMode
  readonly accountRef?: string | null
}

// 작업 상태를 바꾸면서 함께 기록할 값
export type JobTransitionPatch = {
  readonly postedUrl?: string
  readonly confirmedBy?: string
  readonly confirmedAt?: string
  readonly providerPostId?: string
  readonly lastErrorCode?: string
}

// 실제로 게시된 작업 한 건의 내용과 그 소재
export type PostedPayload = {
  readonly variantId: string
  readonly payload: Json
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
  // 운영 설정(게시 방식·계정) 변경. 채널 설정의 권위는 DB다 — 코드의 채널 목록은 초기값일 뿐이다.
  updateChannel(code: MarketingChannelCode, patch: ChannelSettingsPatch): Promise<{ readonly kind: "updated"; readonly channel: MarketingChannelRow } | { readonly kind: "not-found" } | InvalidResult>

  // 이미지 등록. 경로나 내용 해시가 이미 있으면 duplicate — 같은 경로에 다른 파일을 올릴 수 없다.
  registerImage(input: RegisterImageInput): Promise<{ readonly kind: "created"; readonly image: MarketingImageRow } | { readonly kind: "duplicate" } | InvalidResult>
  findImages(imageIds: readonly string[]): Promise<readonly MarketingImageRow[]>

  createCampaign(input: CreateCampaignInput): Promise<{ readonly kind: "created"; readonly campaign: MarketingCampaignRow } | { readonly kind: "code-taken" } | InvalidResult>
  // 목적지별 상품 주소 교체 — 넘긴 값이 그대로 새 값이 된다(빠진 목적지는 스토어 홈으로 돌아간다).
  // 저장할 때마다 product_urls_version이 1 올라간다.
  updateCampaignProductUrls(
    campaignId: string,
    productUrls: Readonly<Partial<Record<OrderDestinationCode, string>>>,
  ): Promise<{ readonly kind: "updated"; readonly campaign: MarketingCampaignRow } | { readonly kind: "not-found" } | InvalidResult>
  findCampaign(campaignId: string): Promise<MarketingCampaignRow | null>
  listCampaigns(): Promise<readonly MarketingCampaignRow[]>

  createVariant(input: CreateVariantInput): Promise<{ readonly kind: "created"; readonly variant: MarketingVariantRow } | { readonly kind: "code-taken" } | { readonly kind: "campaign-changed" } | InvalidResult>
  findVariant(variantId: string): Promise<MarketingVariantRow | null>
  listVariants(campaignId: string): Promise<readonly MarketingVariantRow[]>

  // 내용 수정 — revision을 1 올리고 draft로 되돌리며 품질 결과와 승인 스냅샷을 지운다.
  // 수정 전 revision까지의 게시 전 작업(manual_ready·queued)은 함께 폐기한다. 새 revision의 작업은 건드리지 않는다.
  // 이미 게시됐거나 게시 결과를 확인 중인 작업이 있는 소재는 locked — 올라간 글과 기록이 달라지면 안 된다.
  reviseVariant(
    variantId: string,
    expectedRevision: number,
    content: VariantContent,
  ): Promise<
    | { readonly kind: "updated"; readonly row: MarketingVariantRow; readonly cancelledJobs: number }
    | { readonly kind: "stale" }
    | { readonly kind: "locked" }
    // 링크를 만든 뒤 캠페인의 상품 주소가 바뀌었다 — 캠페인을 다시 읽어 링크를 새로 만들어야 한다
    | { readonly kind: "campaign-changed" }
    | InvalidResult
  >
  // 품질 검사 결과 기록. passed=true면 draft → needs_review, false면 draft에 머문다.
  recordReview(variantId: string, expectedRevision: number, quality: Json, passed: boolean): Promise<CasResult<MarketingVariantRow>>
  // needs_review → approved. 현재 revision에 대한 품질 검사가 있어야 한다.
  approveVariant(variantId: string, expectedRevision: number, approval: VariantApprovalInput): Promise<CasResult<MarketingVariantRow>>

  // 현재 승인본에서 revision·해시·링크·내용을 복사해 작업을 만든다(원자 연산).
  createJob(input: CreateJobInput): Promise<CreateJobResult>
  findJob(jobId: string): Promise<MarketingDistributionJobRow | null>
  listJobs(variantId: string): Promise<readonly MarketingDistributionJobRow[]>
  // 허용된 전이(canTransitionJob)만 반영한다. 금지 전이는 forbidden, 기대 상태가 다르면 stale.
  transitionJob(
    jobId: string,
    expectedStatus: DistributionJobStatus,
    nextStatus: DistributionJobStatus,
    patch?: JobTransitionPatch,
  ): Promise<CasResult<MarketingDistributionJobRow> | { readonly kind: "forbidden" }>

  // 그 채널에 실제로 게시된(게시 확인·API 게시 완료) 작업의 내용 스냅샷 — 최근 것부터. 복제 게시 검사에 쓴다.
  listPostedPayloads(channelCode: MarketingChannelCode, limit: number): Promise<readonly PostedPayload[]>

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

const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/

export function validateCampaignInput(input: CreateCampaignInput): InvalidReason | null {
  if (!isTrackingCode(input.code)) {
    return "code-format"
  }
  if (typeof input.startsOn === "string" && typeof input.endsOn === "string" && input.endsOn < input.startsOn) {
    return "period"
  }
  if (typeof input.budgetCapKrw === "number" && (!Number.isInteger(input.budgetCapKrw) || input.budgetCapKrw < 0)) {
    return "budget"
  }
  const productUrls = input.productUrls ?? {}
  for (const destination of ["imweb", "smartstore"] as const) {
    const url = productUrls[destination]
    if (url !== undefined && !checkDestinationUrl(destination, url).ok) {
      return "order-url"
    }
  }
  return null
}

export function validateProductUrls(productUrls: Readonly<Partial<Record<OrderDestinationCode, string>>>): InvalidReason | null {
  for (const destination of ["imweb", "smartstore"] as const) {
    const url = productUrls[destination]
    if (url !== undefined && !checkDestinationUrl(destination, url).ok) {
      return "order-url"
    }
  }
  return null
}

export function validateVariantInput(input: Pick<CreateVariantInput, "code">): InvalidReason | null {
  return isTrackingCode(input.code) ? null : "code-format"
}

export function validateVariantContent(content: VariantContent): InvalidReason | null {
  if (!checkDestinationUrl(content.destinationCode, content.orderUrl).ok) {
    return "order-url"
  }
  if (content.imageRefs.some((ref) => !CONTENT_HASH_PATTERN.test(ref.content_hash))) {
    return "content-hash"
  }
  return null
}

// 가로·세로는 없거나(null) 양의 정수여야 한다 — DB의 width/height CHECK·integer 열과 같은 규칙
function isValidDimension(value: number | null | undefined): boolean {
  return value === null || value === undefined || (Number.isInteger(value) && value > 0)
}

export function validateImageInput(input: RegisterImageInput): InvalidReason | null {
  if (!CONTENT_HASH_PATTERN.test(input.contentHash)) {
    return "content-hash"
  }
  return isValidDimension(input.width) && isValidDimension(input.height) ? null : "image-size"
}

// 게시 계정 이름 형식 — 공백 없는 한글/영문/숫자/._@- 1~100자. DB의 CHECK·함수와 같은 정규식이다.
// 앞뒤 공백을 다듬지 않는다: JS와 SQL의 trim이 지우는 문자가 달라(탭·개행) 같은 입력이 다른 계정이 될 수 있다.
const ACCOUNT_PATTERN = /^[0-9A-Za-z가-힣._@-]{1,100}$/

export function isAccountName(value: string): boolean {
  return ACCOUNT_PATTERN.test(value)
}

// 작업에 고정할 게시 계정 — 명시한 계정이 없으면("" 또는 생략) 지금 채널에 설정된 계정. DB 함수와 같은 규칙이다.
// 형식에 맞지 않는 계정은 null(거부).
export function resolveJobAccount(requested: string | null | undefined, channelAccountRef: string | null): string | null {
  if (requested === null || requested === undefined || requested === "") {
    return channelAccountRef ?? ""
  }
  return isAccountName(requested) ? requested : null
}

// 소재가 가리키는 이미지가 전부 등록되어 있고 해시가 일치하는지
export function imageRefsMatch(refs: readonly VariantImageRef[], images: readonly Pick<MarketingImageRow, "id" | "content_hash">[]): boolean {
  return refs.every((ref) => images.some((image) => image.id === ref.image_id && image.content_hash === ref.content_hash))
}

// 승인본 전체 내용 스냅샷 — 배포 작업에 복사해 두는 값. DB 함수(create_marketing_distribution_job)가 만드는 것과 같은 모양이다.
export function variantPayload(row: MarketingVariantRow): Json {
  return {
    mode: row.mode,
    title: row.title,
    body: row.body,
    caption: row.caption,
    image_texts: [...row.image_texts],
    image_refs: row.image_refs,
    tracking_kind: row.tracking_kind,
    tracking_params: row.tracking_params,
  }
}

// 저장된 소재를 승인 해시·품질 검사가 받는 형태로 바꾼다.
// 이미지는 "이미지 id:내용 해시"로 넣는다 — 다른 이미지로 바꾸거나 파일 내용이 달라지면 승인 해시도 달라진다.
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
    imageRefs: variantImageRefs(row).map((ref) => `${ref.image_id}:${ref.content_hash}`),
    revision: row.revision,
  }
}
