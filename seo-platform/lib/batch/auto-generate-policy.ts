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
//   auto_generate          = "on"     새 승인을 만들고 진행한다
//                            "cancel" 진행 중인 캠페인 승인을 취소로 닫는다 (전역 승인 슬롯 반납)
//                            그 외     일시정지 — 진행 중 승인은 running으로 남아 슬롯을 계속 쥔다
//   auto_generate_campaign = AutoGenerateCampaign JSON
//
// 이 계층의 기본값은 "애매하면 아무것도 하지 않는다"다. 사람 클릭이 없는 만큼, 직전 배치의 결과가
// 나쁘거나 확인되지 않으면 다음 승인을 만들지 않고 멈춘다.
import { BATCH_MAX_ITEMS } from "./types"

export const AUTO_GENERATE_SETTING_KEY = "auto_generate"
export const AUTO_GENERATE_CAMPAIGN_SETTING_KEY = "auto_generate_campaign"
export const AUTO_GENERATE_APPROVER_PREFIX = "auto-generate:"

// 하루·전체 상한의 절대 천장 — 설정 오타로 한도가 사실상 무제한이 되는 것을 막는다.
export const AUTO_GENERATE_MAX_DAILY_LIMIT = 200
export const AUTO_GENERATE_MAX_TOTAL_LIMIT = 2000

export type AutoGenerateMode = "on" | "off" | "cancel"

// "on"·"cancel"만 의미가 있고, 그 외 값·행 없음은 전부 off(일시정지)다.
export function parseAutoGenerateMode(value: unknown): AutoGenerateMode {
  if (typeof value !== "string") {
    return "off"
  }
  const normalized = value.trim().toLowerCase()
  return normalized === "on" || normalized === "cancel" ? normalized : "off"
}

export type AutoGenerateCampaign = {
  readonly id: string
  // 이 시각 이후에는 새 승인도, 진행 중 승인의 다음 item도 실행하지 않는다.
  readonly expiresAt: string
  // 한 번 승인에 넣는 장소 수 (1 ~ BATCH_MAX_ITEMS).
  readonly batchSize: number
  // KST 하루 동안 이 캠페인이 승인할 수 있는 장소 수.
  readonly dailyLimit: number
  // 캠페인 전체 승인 장소 수 상한.
  readonly totalLimit: number
  // 근거 확인을 마친 생성 대상 — 이 목록 밖의 장소는 승인하지도, 이어서 실행하지도 않는다.
  readonly allowPlaceIds: readonly string[]
  // true면 배치가 끝날 때마다 결과 확인(acknowledgedApprovalIds 등록)이 있어야 다음 승인을 만든다 (파일럿).
  readonly requireReviewEachBatch: boolean
  // 직전 배치의 needs_review 비율이 이 값을 넘으면 멈춘다 (0 ~ 1).
  readonly maxNeedsReviewRatio: number
  // 결과를 확인하고 진행을 허락한 승인 ID — 정지 사유가 있는 승인은 여기 올라와야만 다음으로 넘어간다.
  // 시각이 아니라 승인 ID로 적는 이유: 확인한 "그 실패"만 넘기고, 이후의 새 실패는 반드시 다시 멈추게 하려는 것.
  readonly acknowledgedApprovalIds: readonly string[]
}

const CAMPAIGN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,39}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// 설정 JSON을 엄격히 해석한다 — 한 항목이라도 어긋나면 캠페인 없음(null)으로 보고 아무것도 승인하지 않는다.
// 느슨하게 보정해서 진행하면 오타 하나가 대량 생성으로 이어진다. 기본값으로 채우는 항목도 없다.
export function parseAutoGenerateCampaign(value: unknown): AutoGenerateCampaign | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null
  }
  const raw = value as Record<string, unknown>
  const { id, expiresAt, batchSize, dailyLimit, totalLimit, allowPlaceIds, requireReviewEachBatch, maxNeedsReviewRatio, acknowledgedApprovalIds } = raw

  if (typeof id !== "string" || !CAMPAIGN_ID_PATTERN.test(id)) {
    return null
  }
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) {
    return null
  }
  if (!isIntegerInRange(batchSize, 1, BATCH_MAX_ITEMS) || !isIntegerInRange(dailyLimit, 1, AUTO_GENERATE_MAX_DAILY_LIMIT) || !isIntegerInRange(totalLimit, 1, AUTO_GENERATE_MAX_TOTAL_LIMIT)) {
    return null
  }
  if (!isUniqueUuidList(allowPlaceIds) || allowPlaceIds.length > AUTO_GENERATE_MAX_TOTAL_LIMIT) {
    return null
  }
  if (typeof requireReviewEachBatch !== "boolean") {
    return null
  }
  if (typeof maxNeedsReviewRatio !== "number" || !Number.isFinite(maxNeedsReviewRatio) || maxNeedsReviewRatio < 0 || maxNeedsReviewRatio > 1) {
    return null
  }
  if (!isUniqueUuidList(acknowledgedApprovalIds)) {
    return null
  }
  return { id, expiresAt, batchSize, dailyLimit, totalLimit, allowPlaceIds, requireReviewEachBatch, maxNeedsReviewRatio, acknowledgedApprovalIds }
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
}

function isUniqueUuidList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string" && UUID_PATTERN.test(entry)) && new Set(value).size === value.length
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
  readonly id: string
  readonly status: string
  readonly approvedAt: string
  readonly placeIds: readonly string[]
  readonly approvedMaxCostUsd: number
}

// 가장 최근 캠페인 승인에 연결된 배치의 실제 결과 — 승인이 completed여도 내부가 전부 실패일 수 있다
// (run은 item 결과와 무관하게 completed로 닫힌다). 그래서 다음 승인 허가는 item을 직접 본다.
export type CampaignRunSummary = {
  readonly itemCount: number
  readonly failedCount: number
  readonly needsReviewCount: number
  // 비용 상한·취소 등으로 생성되지 못하고 건너뛴 item.
  readonly skippedCount: number
  // 생성은 됐는데 비용이 기록되지 않은 item — 0원으로 간주하지 않는다.
  readonly costUnknownCount: number
  readonly actualCostUsd: number
}

export type AutoGenerateHaltReason =
  | "approval-failed"
  | "approval-cancelled"
  | "approval-expired"
  // 승인은 completed인데 연결된 배치 결과를 읽지 못했다.
  | "run-unknown"
  | "items-failed"
  | "items-skipped"
  | "cost-unknown"
  | "cost-over"
  | "needs-review-ratio"
  | "awaiting-review"

export type AutoGenerateStepDecision =
  | { readonly kind: "disabled" }
  | { readonly kind: "no-campaign" }
  | { readonly kind: "campaign-expired" }
  // 진행 중(approved/queued/running) 승인이 있다 — 전역 1건 원칙.
  | { readonly kind: "busy" }
  // 직전 캠페인 승인의 결과가 나쁘거나 확인되지 않았다 — 그 승인 ID가 acknowledgedApprovalIds에 오를 때까지 멈춘다.
  | { readonly kind: "halted"; readonly reason: AutoGenerateHaltReason; readonly approvalId: string }
  | { readonly kind: "daily-limit" }
  | { readonly kind: "total-limit" }
  // allowlist를 전부 소진 — 캠페인 완료.
  | { readonly kind: "exhausted" }
  // 다음 승인에 넣을 후보 ID (적격 판정 전) 와 이번에 승인 가능한 최대 수.
  | { readonly kind: "ready"; readonly pendingPlaceIds: readonly string[]; readonly capacity: number }

const HALTING_APPROVAL_STATUSES: Readonly<Record<string, AutoGenerateHaltReason>> = {
  failed: "approval-failed",
  cancelled: "approval-cancelled",
  expired: "approval-expired",
}

export function decideAutoGenerateStep(
  input: Readonly<{
    mode: AutoGenerateMode
    campaign: AutoGenerateCampaign | null
    nowIso: string
    activeApprovalCount: number
    campaignApprovals: readonly CampaignApprovalSummary[]
    // 가장 최근 캠페인 승인의 배치 결과. 승인이 없거나 completed가 아니면 쓰이지 않는다.
    latestRun: CampaignRunSummary | null
  }>,
): AutoGenerateStepDecision {
  if (input.mode !== "on") {
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
  if (latest !== undefined && !campaign.acknowledgedApprovalIds.includes(latest.id)) {
    const reason = haltReasonForLatest(latest, input.latestRun, campaign)
    if (reason !== null) {
      return { kind: "halted", reason, approvalId: latest.id }
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

function haltReasonForLatest(latest: CampaignApprovalSummary, run: CampaignRunSummary | null, campaign: AutoGenerateCampaign): AutoGenerateHaltReason | null {
  const byStatus = HALTING_APPROVAL_STATUSES[latest.status]
  if (byStatus !== undefined) {
    return byStatus
  }
  // 여기 오는 종료 상태는 completed뿐이다 (진행 중 상태는 busy에서 이미 걸렸다). 그 밖의 값도 결과를 요구한다.
  if (run === null || run.itemCount === 0) {
    return "run-unknown"
  }
  if (run.failedCount > 0) {
    return "items-failed"
  }
  if (run.skippedCount > 0) {
    return "items-skipped"
  }
  if (run.costUnknownCount > 0) {
    return "cost-unknown"
  }
  if (run.actualCostUsd > latest.approvedMaxCostUsd) {
    return "cost-over"
  }
  if (run.needsReviewCount / run.itemCount > campaign.maxNeedsReviewRatio) {
    return "needs-review-ratio"
  }
  return campaign.requireReviewEachBatch ? "awaiting-review" : null
}

// ── 진행 중 캠페인 승인의 item 실행 허가 ─────────────────────────
// pump가 캠페인 승인을 claim할 때마다 본다. 스위치만이 아니라 "지금 설정된 그 캠페인의 승인인가"와
// "대상이 아직 allowlist에 있는가"까지 확인한다 — 캠페인을 교체하거나 장소를 목록에서 뺀 뒤 스위치를
// 다시 켰을 때 옛 승인의 잔여가 그대로 생성되는 것을 막는다.
export type AutoApprovalRunDecision =
  | { readonly kind: "run" }
  | { readonly kind: "cancel" }
  | { readonly kind: "pause"; readonly reason: "switch-off" | "no-campaign" | "other-campaign" | "campaign-expired" | "place-not-allowed" }

export function decideAutoApprovalRun(
  input: Readonly<{ mode: AutoGenerateMode; campaign: AutoGenerateCampaign | null; approvedBy: string; approvedPlaceIds: readonly string[]; nowIso: string }>,
): AutoApprovalRunDecision {
  if (input.mode === "cancel") {
    return { kind: "cancel" }
  }
  if (input.mode !== "on") {
    return { kind: "pause", reason: "switch-off" }
  }
  const campaign = input.campaign
  if (campaign === null) {
    return { kind: "pause", reason: "no-campaign" }
  }
  if (input.approvedBy !== autoGenerateApprover(campaign.id)) {
    return { kind: "pause", reason: "other-campaign" }
  }
  if (Date.parse(input.nowIso) >= Date.parse(campaign.expiresAt)) {
    return { kind: "pause", reason: "campaign-expired" }
  }
  const allowed = new Set(campaign.allowPlaceIds)
  if (!input.approvedPlaceIds.every((placeId) => allowed.has(placeId))) {
    return { kind: "pause", reason: "place-not-allowed" }
  }
  return { kind: "run" }
}

// ── 고아 승인 복구 판정 ──────────────────────────────────────────
// 승인 행을 만든 뒤 활성화 도중 함수가 죽으면 토큰이 사라져 그 승인은 스스로 진행하지 못한다.
// 그대로 두면 전역 승인 슬롯을 영원히 쥔다 (만료 시각이 지나도 상태를 바꿔 주는 주기 작업은 없다).
export const AUTO_GENERATE_STALE_APPROVAL_MS = 3 * 60 * 1000

export type ActiveApprovalSummary = {
  readonly id: string
  readonly status: string
  readonly approvedBy: string
  readonly approvedAt: string
  readonly activationConsumedAt: string | null
  readonly batchRunId: string | null
}

export type OrphanApprovalDecision =
  // 실행 흔적이 전혀 없는 캠페인 승인 — 같은 조건의 조건부 UPDATE로 닫아도 안전하다.
  | { readonly kind: "cancel-unactivated"; readonly approvalId: string }
  // running인데 배치가 연결되지 않았다 — pump가 영원히 집지 못한다. 연결 안 된 배치가 남았을 수 있어
  // 자동으로 닫지 않고 사람이 조사하게 남긴다.
  | { readonly kind: "stuck-unlinked"; readonly approvalId: string }
  | { readonly kind: "none" }

export function decideOrphanApproval(active: readonly ActiveApprovalSummary[], nowIso: string): OrphanApprovalDecision {
  const now = Date.parse(nowIso)
  for (const approval of active) {
    if (!isAutoGenerateApprover(approval.approvedBy) || now - Date.parse(approval.approvedAt) < AUTO_GENERATE_STALE_APPROVAL_MS) {
      continue
    }
    if (approval.batchRunId !== null) {
      continue
    }
    if ((approval.status === "approved" || approval.status === "queued") && approval.activationConsumedAt === null) {
      return { kind: "cancel-unactivated", approvalId: approval.id }
    }
    if (approval.status === "running") {
      return { kind: "stuck-unlinked", approvalId: approval.id }
    }
  }
  return { kind: "none" }
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
