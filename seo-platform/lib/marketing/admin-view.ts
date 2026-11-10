// 광고 배포 관리자 화면용 조회 모델과 표시 문구 — 화면은 이 모양만 받아 그린다.
// 조회를 화면과 분리해 두어, 저장소 없이 고정 데이터로도 같은 화면을 렌더할 수 있다(테스트·QA).
import type { ContentMode } from "@/lib/ai/content-mode"
import type { QualityIssue } from "@/lib/ai/content-quality"
import type { Json, MarketingCampaignRow, MarketingChannelRow, MarketingDestinationRow, MarketingDistributionJobRow, MarketingMetricsDailyRow, MarketingVariantRow } from "@/types/database"

import { combinedDistributionStatus } from "./distribution-state"
import type { ServiceFailure } from "./marketing-service"
import type { MarketingRepository } from "./repository"
import type { DistributionStatus, MarketingMetricSource, OrderDestinationCode } from "./types"

export const MODE_LABEL: Readonly<Record<ContentMode, string>> = {
  condolence: "근조",
  celebration: "예식·행사 축하",
  "corporate-celebration": "기업 축하(개업·취임)",
}

export const DESTINATION_LABEL: Readonly<Record<OrderDestinationCode, string>> = {
  imweb: "자사몰",
  smartstore: "스마트스토어",
}

export const STATUS_LABEL: Readonly<Record<DistributionStatus, string>> = {
  draft: "작성 중",
  needs_review: "검수 대기",
  approved: "승인됨",
  manual_ready: "게시 대기(내보냄)",
  manual_confirmed: "게시 확인됨",
  queued: "자동 게시 대기",
  publishing: "자동 게시 중",
  published: "자동 게시됨",
  unknown: "게시 결과 확인 필요",
  failed: "게시 실패",
}

export const METRIC_SOURCE_LABEL: Readonly<Record<MarketingMetricSource, string>> = {
  smartstore_report: "스마트스토어 통계",
  imweb_report: "자사몰 통계",
  naver_ads_report: "네이버 광고 보고서",
  google_ads_report: "구글 광고 보고서",
  manual: "직접 기록(운영 시간 등)",
}

const FAILURE_MESSAGE: Readonly<Record<ServiceFailure, string>> = {
  "not-found": "대상을 찾지 못했습니다. 목록을 새로 고쳐 주세요.",
  stale: "그사이 내용이 바뀌었거나 이미 처리됐습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.",
  "code-taken": "이미 쓰고 있는 코드입니다. 다른 코드를 입력해 주세요.",
  "quality-fail": "품질 검사에서 걸렸습니다. 아래 사유를 고친 뒤 다시 검수 요청해 주세요.",
  "not-approved": "승인된 소재가 아닙니다. 검수 요청과 승인을 먼저 진행해 주세요.",
  "channel-disabled": "이 채널은 배포가 중지되어 있습니다. 채널 설정에서 다시 켜 주세요.",
  duplicate: "이 승인본은 이미 같은 계정으로 내보냈습니다.",
  "invalid-account": "게시 계정 이름 형식이 맞지 않습니다.",
  "posted-url-invalid": "게시한 글의 주소를 https://로 시작하는 전체 주소로 입력해 주세요.",
  "channel-unknown": "지원하지 않는 채널입니다.",
  "empty-copy": "제목과 본문을 입력해 주세요.",
  "code-format": "코드는 영문·숫자·하이픈(-)·밑줄(_)만 1~50자로 입력해 주세요. 마침표와 한글, 공백은 쓸 수 없습니다.",
  period: "종료일이 시작일보다 빠릅니다.",
  budget: "예산은 0 이상의 정수(원)로 입력해 주세요.",
  "order-url": "주문 주소가 허용 범위 밖입니다. 자사몰(팔도플라워.com) 또는 우리 스마트스토어(free77888) 주소만 쓸 수 있습니다.",
  "reference-not-found": "연결된 캠페인을 찾지 못했습니다.",
  "image-ref": "등록되지 않은 이미지입니다.",
  "content-hash": "이미지 정보가 올바르지 않습니다.",
  "image-size": "이미지 크기가 올바르지 않습니다.",
  "account-format": "계정 이름은 공백 없이 한글·영문·숫자와 . _ @ - 만 1~100자로 입력해 주세요.",
  constraint: "저장 규칙에 맞지 않아 저장하지 못했습니다.",
}

// 화면 입력 단계에서 걸러진 사유
const FORM_ERROR_MESSAGE: Readonly<Record<string, string>> = {
  "campaign-input": "캠페인 이름과 종류를 입력해 주세요.",
  "not-reviewed": "내용을 직접 읽고 확인했다는 체크를 해야 승인할 수 있습니다.",
  "metrics-input": "날짜와 출처를 고르고, 수치를 하나 이상 숫자로 입력해 주세요.",
  server: "저장소에 연결하지 못했습니다. 광고 배포 테이블(migration 202611100001)이 적용됐는지 확인해 주세요.",
}

function isServiceFailure(reason: string): reason is ServiceFailure {
  return Object.hasOwn(FAILURE_MESSAGE, reason)
}

export function failureMessage(reason: string): string {
  if (isServiceFailure(reason)) {
    return FAILURE_MESSAGE[reason]
  }
  // 주소에서 온 값이라 toString 같은 상속 속성 이름일 수 있다 — 자기 속성만 본다.
  return (Object.hasOwn(FORM_ERROR_MESSAGE, reason) ? FORM_ERROR_MESSAGE[reason] : undefined) ?? "처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요."
}

const NOTICE_MESSAGE: Readonly<Record<string, string>> = {
  "campaign-created": "캠페인을 만들었습니다. 이제 채널별 소재를 작성해 주세요.",
  "variant-created": "소재를 저장했습니다. 내용을 확인하고 검수 요청을 눌러 주세요.",
  "variant-revised": "수정했습니다. 수정한 소재는 검수와 승인을 다시 받아야 합니다.",
  "review-passed": "품질 검사를 통과했습니다. 내용을 확인한 뒤 승인해 주세요.",
  approved: "승인했습니다. 게시 패키지를 내보내 글을 올려 주세요.",
  exported: "게시 패키지를 준비했습니다. 아래 내용을 복사해 채널에 올린 뒤, 올린 글의 주소를 입력해 주세요.",
  confirmed: "게시를 확인했습니다.",
  "metrics-saved": "성과를 기록했습니다.",
  "channel-saved": "채널 설정을 저장했습니다.",
}

export function noticeMessage(code: string): string | null {
  return (Object.hasOwn(NOTICE_MESSAGE, code) ? NOTICE_MESSAGE[code] : undefined) ?? null
}

export type VariantView = {
  readonly row: MarketingVariantRow
  readonly status: DistributionStatus
  readonly qualityStatus: "pass" | "warn" | "fail" | null
  readonly qualityIssues: readonly QualityIssue[]
  // 현재 revision의 살아 있는 작업 (게시 대기 또는 게시 확인)
  readonly currentJob: MarketingDistributionJobRow | null
  // 이 소재로 실제 게시된 글 주소들 (이전 revision 포함)
  readonly postedUrls: readonly string[]
}

// Array.isArray는 readonly 배열을 좁혀 주지 않는다 — Json에서 객체만 꺼내는 좁히기를 따로 둔다.
function asJsonObject(value: Json | null | undefined): Readonly<Record<string, Json | undefined>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Readonly<Record<string, Json | undefined>>) : null
}

function toIssue(value: Json): QualityIssue | null {
  const issue = asJsonObject(value)
  if (issue === null) {
    return null
  }
  const { level, code, message } = issue
  return (level === "fail" || level === "warn") && typeof code === "string" && typeof message === "string" ? { level, code, message } : null
}

export function parseQualityReport(report: Json | null): { readonly status: "pass" | "warn" | "fail" | null; readonly issues: readonly QualityIssue[] } {
  const parsed = asJsonObject(report)
  if (parsed === null) {
    return { status: null, issues: [] }
  }
  const { status, issues } = parsed
  return {
    status: status === "pass" || status === "warn" || status === "fail" ? status : null,
    issues: Array.isArray(issues) ? (issues as readonly Json[]).map(toIssue).filter((issue): issue is QualityIssue => issue !== null) : [],
  }
}

export function toVariantView(row: MarketingVariantRow, jobs: readonly MarketingDistributionJobRow[]): VariantView {
  const quality = row.quality_checked_revision === row.revision ? parseQualityReport(row.quality_report) : { status: null, issues: [] }
  return {
    row,
    status: combinedDistributionStatus({ reviewStatus: row.review_status, revision: row.revision, jobs: jobs.map((job) => ({ status: job.status, variantRevision: job.variant_revision })) }),
    qualityStatus: quality.status,
    qualityIssues: quality.issues,
    currentJob: jobs.find((job) => job.variant_revision === row.revision && job.status !== "cancelled") ?? null,
    postedUrls: jobs.flatMap((job) => (job.posted_url === null ? [] : [job.posted_url])),
  }
}

export type CampaignSummary = {
  readonly campaign: MarketingCampaignRow
  readonly variantCount: number
  readonly postedCount: number
  readonly waitingCount: number
}

export type MarketingOverview = {
  readonly destinations: readonly MarketingDestinationRow[]
  readonly channels: readonly MarketingChannelRow[]
  readonly campaigns: readonly CampaignSummary[]
}

export async function loadMarketingOverview(repo: MarketingRepository): Promise<MarketingOverview> {
  const [destinations, channels, campaigns] = await Promise.all([repo.listDestinations(), repo.listChannels(), repo.listCampaigns()])
  const summaries = await Promise.all(
    campaigns.map(async (campaign) => {
      const detail = await loadCampaignVariants(repo, campaign.id)
      return {
        campaign,
        variantCount: detail.length,
        postedCount: detail.filter((variant) => variant.postedUrls.length > 0).length,
        waitingCount: detail.filter((variant) => variant.status === "manual_ready").length,
      }
    }),
  )
  return { destinations, channels, campaigns: summaries }
}

async function loadCampaignVariants(repo: MarketingRepository, campaignId: string): Promise<readonly VariantView[]> {
  const variants = await repo.listVariants(campaignId)
  return Promise.all(variants.map(async (variant) => toVariantView(variant, await repo.listJobs(variant.id))))
}

export type CampaignDetail = {
  readonly campaign: MarketingCampaignRow
  readonly channels: readonly MarketingChannelRow[]
  readonly destinations: readonly MarketingDestinationRow[]
  readonly variants: readonly VariantView[]
}

export async function loadCampaignDetail(repo: MarketingRepository, campaignId: string): Promise<CampaignDetail | null> {
  const campaign = await repo.findCampaign(campaignId)
  if (campaign === null) {
    return null
  }
  const [channels, destinations, variants] = await Promise.all([repo.listChannels(), repo.listDestinations(), loadCampaignVariants(repo, campaignId)])
  return { campaign, channels, destinations, variants }
}

export type MetricsTotals = {
  readonly visits: number | null
  readonly orders: number | null
  readonly revenueKrw: number | null
  readonly adCostKrw: number | null
  readonly workMinutes: number | null
}

// 합계 — 한 건도 수집되지 않은 지표는 0이 아니라 null(미수집)로 남긴다.
export function sumMetrics(rows: readonly MarketingMetricsDailyRow[]): MetricsTotals {
  const add = (pick: (row: MarketingMetricsDailyRow) => number | null): number | null => {
    const values = rows.map(pick).filter((value): value is number => value !== null)
    return values.length === 0 ? null : values.reduce((total, value) => total + value, 0)
  }
  return {
    visits: add((row) => row.visits),
    orders: add((row) => row.orders),
    revenueKrw: add((row) => row.revenue_krw),
    adCostKrw: add((row) => row.ad_cost_krw),
    workMinutes: add((row) => row.work_minutes),
  }
}

// 주문 목적지별 합계 — 두 쇼핑몰은 집계 기준이 달라 한 숫자로 합치지 않는다.
export function metricsByDestination(rows: readonly MarketingMetricsDailyRow[]): Readonly<Record<OrderDestinationCode, MetricsTotals>> {
  return {
    imweb: sumMetrics(rows.filter((row) => row.destination_code === "imweb")),
    smartstore: sumMetrics(rows.filter((row) => row.destination_code === "smartstore")),
  }
}
