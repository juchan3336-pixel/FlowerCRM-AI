// 자동 생성 캠페인 — 순수 판정 계층.
//
// 관리자 클릭 없이, 미리 근거를 확인해 둔 장소 목록(allowlist)을 pump가 20곳씩 스스로 승인해 생성한다
// (2026-11-10 지시: 확인 완료·미생성 물량을 사람 개입 없이 끝까지 처리).
//
// 범용 "verified면 자동 생성" 기능이 아니다 — 자동 확인(verified)은 명칭·주소·전화 일치만 뜻하고
// 시설 용도(빈소 운영·행사장 여부)나 화환 반입 가능 여부는 보지 않는다. 그래서 대상은 이 캠페인 설정에
// 명시된 장소 ID뿐이고, 새로 verified가 된 장소가 자동으로 편입되지 않는다.
//
// 스위치·설정은 settings 테이블에 둔다 (DDL 불필요):
//   auto_generate          = "on" 일 때만 동작 (기본 꺼짐)
//   auto_generate_campaign = AutoGenerateCampaign JSON
import { BATCH_MAX_ITEMS } from "./types"

export const AUTO_GENERATE_SETTING_KEY = "auto_generate"
export const AUTO_GENERATE_CAMPAIGN_SETTING_KEY = "auto_generate_campaign"
export const AUTO_GENERATE_APPROVER_PREFIX = "auto-generate:"

// 하루·전체 상한의 절대 천장 — 설정 오타로 한도가 사실상 무제한이 되는 것을 막는다.
export const AUTO_GENERATE_MAX_DAILY_LIMIT = 200
export const AUTO_GENERATE_MAX_TOTAL_LIMIT = 2000

export type AutoGenerateCampaign = {
  readonly id: string
  // 이 시각 이후에는 새 승인을 만들지 않는다.
  readonly expiresAt: string
  // 한 번 승인에 넣는 장소 수 (1 ~ BATCH_MAX_ITEMS).
  readonly batchSize: number
  // KST 하루 동안 이 캠페인이 승인할 수 있는 장소 수.
  readonly dailyLimit: number
  // 캠페인 전체 승인 장소 수 상한.
  readonly totalLimit: number
  // 근거 확인을 마친 생성 대상 — 이 목록 밖의 장소는 절대 승인하지 않는다.
  readonly allowPlaceIds: readonly string[]
  // 실패로 멈춘 캠페인을 다시 진행시킬 때 쓴다 — 이 시각 이전에 끝난 실패 승인은 정지 사유로 보지 않는다.
  readonly resumeAfter: string | null
}

// settings.auto_generate 값 해석 — "on"만 켜짐으로 본다 (그 외 값·행 없음 = 꺼짐).
export function parseAutoGenerateSetting(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "on"
}

const CAMPAIGN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,39}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// 설정 JSON을 엄격히 해석한다 — 한 항목이라도 어긋나면 캠페인 없음(null)으로 보고 아무것도 승인하지 않는다.
// 느슨하게 보정해서 진행하면 오타 하나가 대량 생성으로 이어진다.
export function parseAutoGenerateCampaign(value: unknown): AutoGenerateCampaign | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null
  }
  const raw = value as Record<string, unknown>
  const id = raw["id"]
  const expiresAt = raw["expiresAt"]
  const batchSize = raw["batchSize"]
  const dailyLimit = raw["dailyLimit"]
  const totalLimit = raw["totalLimit"]
  const allowPlaceIds = raw["allowPlaceIds"]
  const resumeAfter = raw["resumeAfter"] ?? null

  if (typeof id !== "string" || !CAMPAIGN_ID_PATTERN.test(id)) {
    return null
  }
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) {
    return null
  }
  if (!isIntegerInRange(batchSize, 1, BATCH_MAX_ITEMS)) {
    return null
  }
  if (!isIntegerInRange(dailyLimit, 1, AUTO_GENERATE_MAX_DAILY_LIMIT)) {
    return null
  }
  if (!isIntegerInRange(totalLimit, 1, AUTO_GENERATE_MAX_TOTAL_LIMIT)) {
    return null
  }
  if (!Array.isArray(allowPlaceIds) || !allowPlaceIds.every((entry): entry is string => typeof entry === "string" && UUID_PATTERN.test(entry))) {
    return null
  }
  if (new Set(allowPlaceIds).size !== allowPlaceIds.length) {
    return null
  }
  if (resumeAfter !== null && (typeof resumeAfter !== "string" || Number.isNaN(Date.parse(resumeAfter)))) {
    return null
  }
  return { id, expiresAt, batchSize, dailyLimit, totalLimit, allowPlaceIds, resumeAfter }
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
}

export function autoGenerateApprover(campaignId: string): string {
  return `${AUTO_GENERATE_APPROVER_PREFIX}${campaignId}`
}

export function isAutoGenerateApprover(approvedBy: string | null | undefined): boolean {
  return typeof approvedBy === "string" && approvedBy.startsWith(AUTO_GENERATE_APPROVER_PREFIX)
}

// 하루 경계는 운영 기준인 KST(UTC+9)다 — 그날 00:00 KST의 UTC 시각을 돌려준다.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export function kstDayStartIso(nowIso: string): string {
  const shifted = Date.parse(nowIso) + KST_OFFSET_MS
  return new Date(Math.floor(shifted / DAY_MS) * DAY_MS - KST_OFFSET_MS).toISOString()
}

// 이 캠페인이 지금까지 만든 승인 1건의 요약 — 예산 집계와 정지 판정에 쓴다.
export type CampaignApprovalSummary = {
  readonly status: string
  readonly approvedAt: string
  readonly placeIds: readonly string[]
}

export type AutoGenerateStepDecision =
  | { readonly kind: "disabled" }
  | { readonly kind: "no-campaign" }
  | { readonly kind: "campaign-expired" }
  // 진행 중(approved/queued/running) 승인이 있다 — 전역 1건 원칙.
  | { readonly kind: "busy" }
  // 직전 캠페인 승인이 비정상 종료 — 원인을 확인하기 전에는 새 승인을 만들지 않는다.
  | { readonly kind: "halted"; readonly status: string }
  | { readonly kind: "daily-limit" }
  | { readonly kind: "total-limit" }
  // allowlist를 전부 소진 — 캠페인 완료.
  | { readonly kind: "exhausted" }
  // 다음 승인에 넣을 후보 ID (적격 판정 전) 와 이번에 승인 가능한 최대 수.
  | { readonly kind: "ready"; readonly pendingPlaceIds: readonly string[]; readonly capacity: number }

// 비정상 종료로 보는 승인 상태 — completed만 정상이다.
const HALTING_STATUSES: readonly string[] = ["failed", "cancelled", "expired"]

export function decideAutoGenerateStep(
  input: Readonly<{
    enabled: boolean
    campaign: AutoGenerateCampaign | null
    nowIso: string
    activeApprovalCount: number
    campaignApprovals: readonly CampaignApprovalSummary[]
  }>,
): AutoGenerateStepDecision {
  if (!input.enabled) {
    return { kind: "disabled" }
  }
  const campaign = input.campaign
  if (campaign === null) {
    return { kind: "no-campaign" }
  }
  if (Date.parse(input.nowIso) >= Date.parse(campaign.expiresAt)) {
    return { kind: "campaign-expired" }
  }
  if (input.activeApprovalCount > 0) {
    return { kind: "busy" }
  }

  const ordered = [...input.campaignApprovals].sort((left, right) => Date.parse(right.approvedAt) - Date.parse(left.approvedAt))
  const latest = ordered[0]
  if (latest !== undefined && HALTING_STATUSES.includes(latest.status)) {
    const resumeAfter = campaign.resumeAfter === null ? null : Date.parse(campaign.resumeAfter)
    if (resumeAfter === null || Date.parse(latest.approvedAt) >= resumeAfter) {
      return { kind: "halted", status: latest.status }
    }
  }

  // 예산은 결과와 무관하게 "승인한 장소 수"로 보수적으로 센다 — 실패·취소분을 환급하지 않는다.
  const dayStart = Date.parse(kstDayStartIso(input.nowIso))
  const approvedToday = sum(ordered.filter((approval) => Date.parse(approval.approvedAt) >= dayStart).map((approval) => approval.placeIds.length))
  const approvedTotal = sum(ordered.map((approval) => approval.placeIds.length))
  const dailyRemaining = campaign.dailyLimit - approvedToday
  if (dailyRemaining <= 0) {
    return { kind: "daily-limit" }
  }
  const totalRemaining = campaign.totalLimit - approvedTotal
  if (totalRemaining <= 0) {
    return { kind: "total-limit" }
  }

  // 한 번 승인에 들어간 장소는 결과와 무관하게 다시 승인하지 않는다 (자동 재승인 금지).
  const alreadyApproved = new Set(ordered.flatMap((approval) => approval.placeIds))
  const pendingPlaceIds = campaign.allowPlaceIds.filter((placeId) => !alreadyApproved.has(placeId))
  if (pendingPlaceIds.length === 0) {
    return { kind: "exhausted" }
  }
  return { kind: "ready", pendingPlaceIds, capacity: Math.min(campaign.batchSize, dailyRemaining, totalRemaining, BATCH_MAX_ITEMS) }
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
