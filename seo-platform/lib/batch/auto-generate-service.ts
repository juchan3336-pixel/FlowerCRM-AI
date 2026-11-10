import "server-only"

// 자동 생성 캠페인 — 실행 계층. 판정은 auto-generate-policy, 승인 준비는 approval-request-service,
// 활성화는 approval-execution-service의 기존 함수를 그대로 쓴다 (판정·스냅샷·토큰 경로를 복제하지 않는다).
//
// 호출 지점은 batch pump 하나뿐이다 — pump가 이미 Preview 전용·OpenAI 전용·bypass·시크릿 게이트를
// 통과한 뒤이므로, 이 모듈은 새 endpoint·새 시크릿·새 Cron을 만들지 않는다.
// 같은 배포 안에서 executeActivate를 직접 부르므로 HTTP로 자기 자신을 부르는 경로도 없다.
//
// 한 걸음(runAutoGenerateStep)은 after() 안에서 돈다. after()는 함수 제한 시간(60초)을 늘려 주지 않고
// 중간에 죽을 수 있으므로: ①시간 예산을 넘기면 승인 행을 만들기 전에 물러나고 ②승인 행을 만든 뒤 죽은
// 경우는 다음 걸음의 복구 판정(decideOrphanApproval)이 수습한다.
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import { ACTIVE_APPROVAL_STATUSES, decideBatchCandidate } from "./candidate-policy"
import { approvalMaxCostUsd } from "./cost-policy"
import {
  AUTO_GENERATE_CAMPAIGN_SETTING_KEY,
  AUTO_GENERATE_SETTING_KEY,
  autoGenerateApprover,
  decideAutoApprovalRun,
  decideAutoGenerateStep,
  decideOrphanApproval,
  parseAutoGenerateCampaign,
  parseAutoGenerateMode,
  type ActiveApprovalSummary,
  type AutoApprovalRunDecision,
  type AutoGenerateCampaign,
  type AutoGenerateMode,
  type AutoGenerateStepDecision,
  type CampaignApprovalSummary,
  type CampaignRunSummary,
} from "./auto-generate-policy"
import { parseGenerationStoredMetadata } from "@/lib/ai/generation-mapping"
import type { BatchApprovalRow } from "@/types/database"

export type AutoGenerateStepOutcome =
  // 아무것도 하지 않음 — 사유는 진단용 코드.
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "started"; readonly approvalId: string; readonly placeCount: number }
  // 승인은 만들었지만 활성화되지 않았다 — 실행 흔적이 없으면 취소로 닫혔고, 캠페인은 확인 전까지 멈춘다.
  | { readonly kind: "activation-rejected"; readonly approvalId: string; readonly reason: string }
  // 토큰을 잃은 캠페인 승인을 닫았다.
  | { readonly kind: "recovered"; readonly approvalId: string }
  // 자동으로 수습할 수 없는 상태 — 사람이 조사해야 한다.
  | { readonly kind: "stuck"; readonly approvalId: string; readonly reason: string }

// 한 번에 적격 판정할 allowlist 조각 크기 — PostgREST in() URL 길이와 왕복 수의 절충.
const ELIGIBILITY_CHUNK = 60
// PostgREST 응답 행 상한(기본 1,000)에 잘리지 않게 이력을 나눠 읽는 단위.
const HISTORY_PAGE = 500
// 승인 행을 만들기 전에 쓸 수 있는 시간 — 이후 승인 준비(장소당 조회)·재검증·활성화에 남은 시간을 준다.
export const AUTO_GENERATE_PREPARE_BUDGET_MS = 20_000

type Clock = () => number

async function loadCampaignState(): Promise<{ mode: AutoGenerateMode; campaign: AutoGenerateCampaign | null }> {
  const client = createSupabaseServiceRoleClient()
  const { data, error } = await client.from("settings").select("key,value").in("key", [AUTO_GENERATE_SETTING_KEY, AUTO_GENERATE_CAMPAIGN_SETTING_KEY])
  if (error !== null) {
    throw new Error(`Failed to read auto-generate settings: ${error.message}`)
  }
  const byKey = new Map(data.map((row) => [row.key, row.value]))
  return {
    mode: parseAutoGenerateMode(byKey.get(AUTO_GENERATE_SETTING_KEY)),
    campaign: parseAutoGenerateCampaign(byKey.get(AUTO_GENERATE_CAMPAIGN_SETTING_KEY)),
  }
}

// ── 진행 중 캠페인 승인의 item 실행 허가 ─────────────────────────
// pump가 캠페인 승인을 claim한 직후 부른다. 설정을 읽지 못하면 실행하지 않는다(일시정지).
export async function decideClaimedAutoApproval(approval: Pick<BatchApprovalRow, "approved_by" | "approved_place_ids">, nowIso: string): Promise<AutoApprovalRunDecision> {
  let state: Awaited<ReturnType<typeof loadCampaignState>>
  try {
    state = await loadCampaignState()
  } catch {
    return { kind: "pause", reason: "switch-off" }
  }
  return decideAutoApprovalRun({ mode: state.mode, campaign: state.campaign, approvedBy: approval.approved_by, approvedPlaceIds: approval.approved_place_ids, nowIso })
}

// 스위치 "cancel" — 진행 중 캠페인 승인과 그 배치를 함께 닫아 전역 승인 슬롯을 반납한다.
// 호출자는 이 승인의 pump lease를 쥐고 있어야 한다 (다른 pump가 item을 처리하는 중이 아님을 보장).
// 승인만 취소하면 running 배치가 고아로 남으므로 배치를 먼저 닫는다. 잔여 장소는 다시 승인되지 않는다.
export async function cancelClaimedAutoApproval(approval: Pick<BatchApprovalRow, "id" | "approved_by" | "batch_run_id">): Promise<void> {
  if (approval.batch_run_id !== null) {
    const { cancelGenerationBatch } = await import("./generation-batch-service")
    await cancelGenerationBatch(approval.batch_run_id, approval.approved_by)
  }
  const { createSupabaseApprovalRepository } = await import("./supabase-approval-repository")
  await createSupabaseApprovalRepository().cancelApprovalWithError(approval.id, { code: "auto-cancelled", message: "auto-cancelled:switch" })
}

// ── 한 걸음 ──────────────────────────────────────────────────────
// pump idle 분기에서 부른다: 조건이 맞으면 allowlist의 다음 적격 장소들로 승인 1건을 만들고 활성화한다.
// 첫 item은 다음 Cron 호출이 처리한다 (여기서는 접수까지만).
export async function runAutoGenerateStep(
  input: Readonly<{ nowIso: string; previewDeploymentSha: string | null; clock?: Clock }>,
): Promise<AutoGenerateStepOutcome> {
  const clock = input.clock ?? Date.now
  const startedAt = clock()

  // 고아 승인 수습은 스위치·캠페인 설정과 무관하게 먼저 한다. 멈추려고 스위치를 끄거나 캠페인을 지운
  // 바로 그 상황에서 고아가 전역 승인 슬롯을 쥐고 있으면 관리자 승인까지 막히기 때문이다.
  // (pump는 running + 배치 연결 승인만 집으므로, 이 걸음 말고는 고아에 닿는 경로가 없다.)
  const orphan = decideOrphanApproval(await loadActiveApprovals(null), input.nowIso)
  if (orphan.kind === "cancel-unactivated") {
    const { createSupabaseApprovalRepository } = await import("./supabase-approval-repository")
    const closed = await createSupabaseApprovalRepository().cancelUnactivatedApproval(orphan.approvalId, { code: "auto-orphan", message: "auto-orphan:activation-lost" })
    // 닫지 못했으면(그 사이 활성화됨) 정상 진행 중인 승인이다 — 건드리지 않고 다음 주기에 다시 본다.
    return closed === null ? { kind: "skipped", reason: "busy" } : { kind: "recovered", approvalId: orphan.approvalId }
  }
  if (orphan.kind === "stuck-unlinked") {
    return { kind: "stuck", approvalId: orphan.approvalId, reason: "running-without-batch" }
  }

  const first = await evaluateStep(input.nowIso, null)
  if (first.decision.kind !== "ready") {
    return { kind: "skipped", reason: skipReason(first.decision) }
  }
  const campaign = first.campaign
  if (campaign === null) {
    return { kind: "skipped", reason: "no-campaign" }
  }

  const placeIds = await pickEligiblePlaceIds(first.decision.pendingPlaceIds, first.decision.capacity, () => clock() - startedAt)
  if (placeIds.length === 0) {
    // allowlist에 남은 장소가 전부 부적격(제외·생성 이력·게시됨 등) — 더 할 일이 없다.
    return { kind: "skipped", reason: "no-eligible" }
  }
  if (clock() - startedAt > AUTO_GENERATE_PREPARE_BUDGET_MS) {
    // 승인 행을 만든 뒤 시간이 모자라 죽는 것보다, 만들기 전에 물러나는 편이 안전하다.
    return { kind: "skipped", reason: "slow-step" }
  }

  const approver = autoGenerateApprover(campaign.id)
  const { prepareApproval } = await import("./approval-request-service")
  const prepared = await prepareApproval({ placeIds, approvedBy: approver, maxCostUsd: approvalMaxCostUsd(placeIds.length), nowIso: input.nowIso })
  if (prepared.kind === "already-active") {
    return { kind: "skipped", reason: "busy" }
  }
  if (prepared.kind === "blocked") {
    // 적격 판정 직후에 상태가 바뀐 경우 — 승인 행은 만들어지지 않았다. 다음 주기에 다시 판정한다.
    return { kind: "skipped", reason: `blocked-${prepared.reason}` }
  }
  const approvalId = prepared.approval.id
  const { createSupabaseApprovalRepository } = await import("./supabase-approval-repository")
  const approvals = createSupabaseApprovalRepository()

  // 여기부터 이 승인이 전역 슬롯을 쥐고 있다 — 다른 요청은 새 승인을 만들 수 없다.
  // 슬롯을 쥔 상태에서 원장을 다시 읽어 판정한다: 처음 읽은 뒤 다른 승인이 생기고 끝났다면(느린 요청)
  // 오래된 집계로 한도를 넘겼을 수 있다. unique index는 "동시에 둘"만 막고 이 순서 뒤집힘은 막지 못한다.
  try {
    const second = await evaluateStep(input.nowIso, approvalId)
    const stillValid =
      second.campaign?.id === campaign.id &&
      second.decision.kind === "ready" &&
      placeIds.length <= second.decision.capacity &&
      placeIds.every((placeId) => second.decision.kind === "ready" && second.decision.pendingPlaceIds.includes(placeId))
    if (!stillValid) {
      await approvals.cancelUnactivatedApproval(approvalId, { code: "auto-recheck", message: `auto-recheck:${skipReason(second.decision)}` })
      return { kind: "activation-rejected", approvalId, reason: `recheck-${skipReason(second.decision)}` }
    }

    const { executeActivate } = await import("./approval-execution-service")
    const activated = await executeActivate({ activationToken: prepared.activationToken, nowIso: input.nowIso, previewDeploymentSha: input.previewDeploymentSha })
    if (activated.outcome.kind !== "accepted") {
      const reason = "reason" in activated.outcome ? activated.outcome.reason : activated.outcome.kind
      await closeIfUnactivated(approvalId, reason)
      return { kind: "activation-rejected", approvalId, reason }
    }
    return { kind: "started", approvalId, placeCount: placeIds.length }
  } catch {
    // 재검증·활성화 도중 예외 — 토큰은 이 함수가 끝나면 사라진다. 실행 흔적이 없을 때만 닫는다.
    // 이미 running으로 넘어갔다면 닫히지 않고(조건부 UPDATE 0행), 다음 걸음의 복구 판정이 본다.
    await closeIfUnactivated(approvalId, "threw")
    return { kind: "activation-rejected", approvalId, reason: "threw" }
  }
}

function skipReason(decision: AutoGenerateStepDecision): string {
  return decision.kind === "halted" ? `halted-${decision.reason}` : decision.kind
}

async function closeIfUnactivated(approvalId: string, reason: string): Promise<void> {
  try {
    const { createSupabaseApprovalRepository } = await import("./supabase-approval-repository")
    await createSupabaseApprovalRepository().cancelUnactivatedApproval(approvalId, { code: "auto-activate-failed", message: `auto-activate-failed:${reason}`.slice(0, 200) })
  } catch {
    // 정리 실패 — 승인이 approved로 남는다. 다음 걸음의 복구 판정이 3분 뒤 닫는다.
  }
}

// 설정·진행 중 승인·캠페인 이력·직전 배치 결과를 읽어 판정한다.
// excludeApprovalId는 방금 만든 자기 승인 — 재검증 때 자기 자신을 진행 중·이력으로 세지 않게 뺀다.
async function evaluateStep(
  nowIso: string,
  excludeApprovalId: string | null,
): Promise<{ campaign: AutoGenerateCampaign | null; decision: AutoGenerateStepDecision }> {
  const { mode, campaign } = await loadCampaignState()
  if (mode !== "on" || campaign === null) {
    return { campaign, decision: decideAutoGenerateStep({ mode, campaign, nowIso, activeApprovalCount: 0, campaignApprovals: [], latestRun: null }) }
  }

  const activeApprovals = await loadActiveApprovals(excludeApprovalId)
  const history = (await loadCampaignHistory(autoGenerateApprover(campaign.id))).filter((row) => row.id !== excludeApprovalId)
  const campaignApprovals: CampaignApprovalSummary[] = history.map((row) => ({
    id: row.id,
    status: row.status,
    approvedAt: row.approved_at,
    placeIds: row.approved_place_ids,
    approvedMaxCostUsd: row.approved_max_cost_usd,
  }))
  const latest = [...history].sort((left, right) => Date.parse(right.approved_at) - Date.parse(left.approved_at))[0]
  const latestRunId = latest?.batch_run_id ?? null
  const latestRun = latestRunId === null ? null : await loadRunSummary(latestRunId)

  return {
    campaign,
    decision: decideAutoGenerateStep({ mode, campaign, nowIso, activeApprovalCount: activeApprovals.length, campaignApprovals, latestRun }),
  }
}

// 진행 중(approved/queued/running) 승인 전부 — 관리자 승인 포함. excludeApprovalId는 방금 만든 자기 승인.
async function loadActiveApprovals(excludeApprovalId: string | null): Promise<readonly ActiveApprovalSummary[]> {
  const client = createSupabaseServiceRoleClient()
  const active = await client
    .from("batch_approvals")
    .select("id,status,approved_by,approved_at,activation_consumed_at,batch_run_id")
    .in("status", [...ACTIVE_APPROVAL_STATUSES] as never[])
  if (active.error !== null) {
    // 진행 상태를 읽지 못하면 진행하지 않는다 — 0건으로 간주하고 승인하면 전역 1건·한도를 어길 수 있다.
    throw new Error("Failed to read active approvals for auto-generate")
  }
  return active.data
    .filter((row) => row.id !== excludeApprovalId)
    .map((row) => ({
      id: row.id,
      status: row.status,
      approvedBy: row.approved_by,
      approvedAt: row.approved_at,
      activationConsumedAt: row.activation_consumed_at,
      batchRunId: row.batch_run_id,
    }))
}

type HistoryRow = Pick<BatchApprovalRow, "id" | "status" | "approved_at" | "approved_place_ids" | "batch_run_id" | "approved_max_cost_usd">

// 캠페인 승인 이력을 전부 읽는다 — 응답 행 상한에 잘린 이력으로 판정하면 한도·재승인 금지가 무너진다.
async function loadCampaignHistory(approver: string): Promise<readonly HistoryRow[]> {
  const client = createSupabaseServiceRoleClient()
  const rows: HistoryRow[] = []
  for (let from = 0; ; from += HISTORY_PAGE) {
    const page = await client
      .from("batch_approvals")
      .select("id,status,approved_at,approved_place_ids,batch_run_id,approved_max_cost_usd")
      .eq("approved_by", approver)
      .order("approved_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + HISTORY_PAGE - 1)
    if (page.error !== null) {
      throw new Error("Failed to read campaign approval history")
    }
    rows.push(...page.data)
    if (page.data.length < HISTORY_PAGE) {
      return rows
    }
  }
}

// 배치 item의 실제 결과 요약. 읽지 못하면 null — 판정은 이를 "결과 미상"으로 보고 멈춘다.
async function loadRunSummary(batchRunId: string): Promise<CampaignRunSummary | null> {
  const client = createSupabaseServiceRoleClient()
  const { data, error } = await client.from("batch_run_items").select("status,cost_usd,generation_id,retry_generation_id").eq("batch_id", batchRunId)
  if (error !== null) {
    return null
  }
  // item.cost_usd는 비용을 계산하지 못한 생성도 0으로 더해 저장한다 — 0원과 "모름"이 구분되지 않는다.
  // 그래서 생성 기록(재시도 포함)의 추정 비용을 직접 읽어, 하나라도 없으면 그 item을 비용 미상으로 센다.
  const generationIds = [...new Set(data.flatMap((item) => [item.generation_id, item.retry_generation_id]).filter((value): value is string => typeof value === "string"))]
  const costKnown = new Set<string>()
  if (generationIds.length > 0) {
    const generations = await client.from("ai_generations").select("id,output").in("id", generationIds)
    if (generations.error !== null) {
      return null
    }
    for (const row of generations.data) {
      if (parseGenerationStoredMetadata(row.output).estimatedCost !== null) {
        costKnown.add(row.id)
      }
    }
  }
  const isCostUnknown = (item: (typeof data)[number]): boolean =>
    item.generation_id !== null && (item.cost_usd === null || [item.generation_id, item.retry_generation_id].some((generationId) => typeof generationId === "string" && !costKnown.has(generationId)))
  return {
    itemCount: data.length,
    failedCount: data.filter((item) => item.status === "failed" || item.status === "publish_failed").length,
    needsReviewCount: data.filter((item) => item.status === "needs_review").length,
    // 종료된 배치에 남은 미처리 상태도 "생성되지 못함"으로 센다.
    skippedCount: data.filter((item) => item.status === "skipped" || item.status === "queued" || item.status === "processing" || item.status === "interrupted").length,
    costUnknownCount: data.filter(isCostUnknown).length,
    actualCostUsd: data.reduce((total, item) => total + (item.cost_usd ?? 0), 0),
  }
}

// allowlist 순서를 지키며 적격 장소를 capacity만큼 고른다.
// 판정은 관리자 후보 화면과 같은 decideBatchCandidate — 시설 명칭 차단(추모·숙박)·excluded·생성 이력·slug 충돌이 모두 여기서 걸린다.
// 시간 예산을 넘기면 지금까지 고른 것만 돌려준다 (호출자가 예산 초과를 다시 확인한다).
async function pickEligiblePlaceIds(pendingPlaceIds: readonly string[], capacity: number, elapsedMs: () => number): Promise<readonly string[]> {
  const client = createSupabaseServiceRoleClient()
  const picked: string[] = []
  for (let offset = 0; offset < pendingPlaceIds.length && picked.length < capacity; offset += ELIGIBILITY_CHUNK) {
    if (elapsedMs() > AUTO_GENERATE_PREPARE_BUDGET_MS) {
      break
    }
    const chunk = pendingPlaceIds.slice(offset, offset + ELIGIBILITY_CHUNK)
    const places = await client.from("places").select("*").in("id", chunk)
    if (places.error !== null) {
      throw new Error(`Failed to load auto-generate candidates: ${places.error.message}`)
    }
    const slugs = places.data.map((place) => place.slug).filter((slug): slug is string => slug !== null && slug.trim().length > 0)
    const paths = slugs.map((slug) => `/places/${slug}`)
    const [generations, seoByPlace, seoByPath, slugTwins] = await Promise.all([
      client.from("ai_generations").select("place_id").in("place_id", chunk),
      client.from("seo_pages").select("place_id").eq("page_type", "place").in("place_id", chunk),
      slugs.length === 0 ? Promise.resolve({ data: [], error: null }) : client.from("seo_pages").select("path").in("path", paths),
      slugs.length === 0 ? Promise.resolve({ data: [], error: null }) : client.from("places").select("id,slug").in("slug", slugs),
    ])
    if (generations.error !== null || seoByPlace.error !== null || seoByPath.error !== null || slugTwins.error !== null) {
      // 조회 오류를 "이력 없음"으로 읽으면 이미 생성된 장소를 다시 승인하게 된다.
      throw new Error("Failed to load auto-generate candidate state")
    }
    const withGeneration = new Set(generations.data.map((row) => row.place_id))
    const withSeoPage = new Set(seoByPlace.data.map((row) => row.place_id))
    const existingPaths = new Set(seoByPath.data.map((row) => row.path))
    const slugOwners = new Map<string, number>()
    for (const row of slugTwins.data) {
      if (row.slug !== null) {
        slugOwners.set(row.slug, (slugOwners.get(row.slug) ?? 0) + 1)
      }
    }
    const byId = new Map(places.data.map((place) => [place.id, place]))
    for (const placeId of chunk) {
      const place = byId.get(placeId)
      if (place === undefined || picked.length >= capacity) {
        continue
      }
      const decision = decideBatchCandidate({
        place,
        generationCount: withGeneration.has(place.id) ? 1 : 0,
        slugDuplicateCount: place.slug === null ? 0 : Math.max(0, (slugOwners.get(place.slug) ?? 0) - 1),
        seoPagePathExists: withSeoPage.has(place.id) || (place.slug !== null && existingPaths.has(`/places/${place.slug}`)),
        verificationSourceUrls: place.verification_source_urls ?? null,
      })
      if (decision.eligible) {
        picked.push(place.id)
      }
    }
  }
  return picked
}
