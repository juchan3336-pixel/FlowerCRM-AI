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
  "link-outdated": "상품 주소가 바뀌어 이 소재의 주문 링크를 새 주소로 맞췄습니다. 내용을 확인하고 검수 요청부터 다시 진행해 주세요.",
  "already-posted": "이미 게시된 소재는 고칠 수 없습니다. 다른 글이 필요하면 새 소재를 만들어 주세요.",
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
  "ai-disabled": "AI 자동 생성이 꺼져 있습니다. Vercel Production 환경 변수 MARKETING_AI_PROVIDER, OPENAI_API_KEY, OPENAI_MODEL을 설정하고 다시 배포해 주세요.",
  "ai-cost-too-high": "설정된 AI 모델은 초안 한 편의 예상 비용이 허용 범위를 넘습니다. OPENAI_MODEL을 gpt-4.1-mini로 설정해 주세요.",
  "ai-unknown": "AI 응답을 받지 못했습니다. 요청이 처리됐는지 알 수 없어 자동으로 다시 시도하지 않았습니다. 잠시 뒤 다시 눌러 주세요.",
  "ai-failed": "AI 생성에 실패했습니다. 키와 모델 설정을 확인한 뒤 다시 시도해 주세요.",
  "save-failed": "글은 만들었지만 소재로 저장하지 못했습니다. 다시 시도해 주세요.",
  "cap-daily-count": "오늘 만들 수 있는 AI 초안 수(하루 10편)를 모두 썼습니다. 내일 다시 시도해 주세요.",
  "cap-daily-usd": "오늘의 AI 생성 예산을 모두 썼습니다. 내일 다시 시도해 주세요.",
  "cap-monthly-usd": "이번 달 AI 생성 예산을 모두 썼습니다.",
  "generations-missing": "AI 생성 기록 테이블이 없습니다. migration 202611100002_marketing_generations.sql을 실행해 주세요.",
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
  "product-urls-saved": "상품 주소를 저장했습니다.",
  "draft-generated": "AI가 초안을 만들었고 품질 검사를 통과했습니다. 내용을 읽어 보고 승인해 주세요.",
  "draft-generated-style": "AI가 초안을 만들었습니다. 다시 쓰게 했는데도 반복·빈말 같은 문장 문제가 남아 있을 수 있으니, 읽어 보고 '수정하기'로 다듬은 뒤 승인해 주세요.",
  "draft-generated-fail": "AI가 초안을 만들었지만 품질 검사에 걸린 항목이 남아 있습니다. '수정하기'로 고친 뒤 검수 요청해 주세요.",
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

// 한 행이 가리키는 범위 — 채널·캠페인·소재. null은 "그 차원 전체"다.
function scopeOf(row: MarketingMetricsDailyRow): readonly (string | null)[] {
  return [row.channel_code, row.campaign_id, row.variant_id]
}

// 두 행의 범위가 겹칠 수 있는가 — 어느 차원에서든 둘 다 값이 있고 서로 다르면 겹치지 않는다(예: 블로그 vs 플레이스).
// 한쪽이 그 차원 전체(null)면 겹친다고 본다(예: "전체" vs "캠페인 A", "블로그 전체" vs "캠페인 A 전체").
function scopesOverlap(a: MarketingMetricsDailyRow, b: MarketingMetricsDailyRow): boolean {
  const other = scopeOf(b)
  return scopeOf(a).every((value, index) => value === null || other[index] === null || value === other[index])
}

// a가 b를 완전히 포함하는가 — a가 지정한 차원은 전부 b와 같고, a가 더 넓다.
function scopeCovers(a: MarketingMetricsDailyRow, b: MarketingMetricsDailyRow): boolean {
  const other = scopeOf(b)
  return scopeOf(a).every((value, index) => value === null || value === other[index])
}

function specifiedCount(row: MarketingMetricsDailyRow): number {
  return scopeOf(row).filter((value) => value !== null).length
}

export type TotalsSelection = {
  // 합계에 쓰는 행 — 서로 범위가 겹치지 않는다
  readonly counted: readonly MarketingMetricsDailyRow[]
  // 더 넓은 행에 포함되어 뺀 행 (예: "전체"가 있는 날의 "캠페인별") — 정상적인 세부 내역이다
  readonly nested: readonly MarketingMetricsDailyRow[]
  // 포함 관계는 아닌데 범위가 겹칠 수 있어 뺀 행 (예: "블로그 전체"와 "캠페인 A 전체") — 입력 단위를 맞춰야 한다
  readonly ambiguous: readonly MarketingMetricsDailyRow[]
}

// 같은 날짜·출처·목적지 안에서 범위가 겹치는 수치를 함께 더하면 같은 주문·비용을 두 번 센다.
// 넓은 범위의 행부터 받아들이고, 이미 받아들인 행과 겹치는 행은 합계에서 뺀다.
// 범위가 서로 다른 행(다른 채널, 다른 캠페인)은 겹치지 않으므로 모두 더한다.
export function selectForTotals(rows: readonly MarketingMetricsDailyRow[]): TotalsSelection {
  const groups = new Map<string, MarketingMetricsDailyRow[]>()
  for (const row of rows) {
    const key = `${row.date}|${row.source}|${row.destination_code ?? ""}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const counted: MarketingMetricsDailyRow[] = []
  const nested: MarketingMetricsDailyRow[] = []
  const ambiguous: MarketingMetricsDailyRow[] = []
  for (const group of groups.values()) {
    const kept: MarketingMetricsDailyRow[] = []
    // 넓은 범위 먼저. 지정한 차원 수가 같으면 채널 → 캠페인 → 소재 단위 순으로 우선한다(정렬은 안정적이다).
    const ordered = [...group].sort((a, b) => specifiedCount(a) - specifiedCount(b) || scopeOf(a).findIndex((value) => value !== null) - scopeOf(b).findIndex((value) => value !== null))
    for (const row of ordered) {
      const clash = kept.filter((accepted) => scopesOverlap(accepted, row))
      if (clash.length === 0) {
        kept.push(row)
      } else if (clash.some((accepted) => scopeCovers(accepted, row))) {
        nested.push(row)
      } else {
        ambiguous.push(row)
      }
    }
    counted.push(...kept)
  }
  return { counted, nested, ambiguous }
}

export function rowsForTotals(rows: readonly MarketingMetricsDailyRow[]): readonly MarketingMetricsDailyRow[] {
  return selectForTotals(rows).counted
}

// 합계 — 한 건도 수집되지 않은 지표는 0이 아니라 null(미수집)로 남긴다. 겹치는 단위는 rowsForTotals로 먼저 걸러 넘긴다.
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
  const counted = rowsForTotals(rows)
  return {
    imweb: sumMetrics(counted.filter((row) => row.destination_code === "imweb")),
    smartstore: sumMetrics(counted.filter((row) => row.destination_code === "smartstore")),
  }
}
