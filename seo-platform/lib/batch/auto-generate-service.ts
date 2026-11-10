import "server-only"

// 자동 생성 캠페인 — 실행 계층. 판정은 auto-generate-policy, 승인 준비는 approval-request-service,
// 활성화는 approval-execution-service의 기존 함수를 그대로 쓴다 (판정·스냅샷·토큰 경로를 복제하지 않는다).
//
// 호출 지점은 batch pump의 idle 분기 하나뿐이다 — pump가 이미 Preview 전용·OpenAI 전용·bypass·시크릿
// 게이트를 통과한 뒤이므로, 이 모듈은 새 endpoint·새 시크릿·새 Cron을 만들지 않는다.
// 같은 배포 안에서 executeActivate를 직접 부르므로 HTTP로 자기 자신을 부르는 경로도 없다.
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import { ACTIVE_APPROVAL_STATUSES, decideBatchCandidate } from "./candidate-policy"
import { approvalMaxCostUsd } from "./cost-policy"
import {
  AUTO_GENERATE_CAMPAIGN_SETTING_KEY,
  AUTO_GENERATE_SETTING_KEY,
  autoGenerateApprover,
  decideAutoGenerateStep,
  parseAutoGenerateCampaign,
  parseAutoGenerateSetting,
  type AutoGenerateCampaign,
  type CampaignApprovalSummary,
} from "./auto-generate-policy"

export type AutoGenerateStepOutcome =
  // 아무것도 하지 않음 — 사유는 진단용 코드.
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "started"; readonly approvalId: string; readonly placeCount: number }
  // 승인은 만들었지만 활성화가 거부됨 — 승인은 실패/만료로 남고 캠페인은 halted로 멈춘다.
  | { readonly kind: "activation-rejected"; readonly approvalId: string; readonly reason: string }

// 한 번에 적격 판정할 allowlist 조각 크기 — PostgREST in() URL 길이와 왕복 수의 절충.
const ELIGIBILITY_CHUNK = 60

export async function isAutoGenerateEnabled(): Promise<boolean> {
  const client = createSupabaseServiceRoleClient()
  const { data, error } = await client.from("settings").select("value").eq("key", AUTO_GENERATE_SETTING_KEY).maybeSingle()
  // 조회 실패는 "꺼짐"으로 본다 — 스위치를 읽지 못한 채로 생성하지 않는다.
  return error === null && parseAutoGenerateSetting(data?.value)
}

async function loadCampaignState(): Promise<{ enabled: boolean; campaign: AutoGenerateCampaign | null }> {
  const client = createSupabaseServiceRoleClient()
  const { data, error } = await client.from("settings").select("key,value").in("key", [AUTO_GENERATE_SETTING_KEY, AUTO_GENERATE_CAMPAIGN_SETTING_KEY])
  if (error !== null) {
    throw new Error(`Failed to read auto-generate settings: ${error.message}`)
  }
  const byKey = new Map(data.map((row) => [row.key, row.value]))
  return {
    enabled: parseAutoGenerateSetting(byKey.get(AUTO_GENERATE_SETTING_KEY)),
    campaign: parseAutoGenerateCampaign(byKey.get(AUTO_GENERATE_CAMPAIGN_SETTING_KEY)),
  }
}

// pump idle 분기에서 부르는 한 걸음: 조건이 맞으면 allowlist의 다음 적격 장소들로 승인 1건을 만들고 활성화한다.
// 첫 item은 다음 Cron 호출이 처리한다 (여기서는 접수까지만).
export async function runAutoGenerateStep(input: Readonly<{ nowIso: string; previewDeploymentSha: string | null }>): Promise<AutoGenerateStepOutcome> {
  const { enabled, campaign } = await loadCampaignState()
  if (!enabled) {
    return { kind: "skipped", reason: "disabled" }
  }
  if (campaign === null) {
    return { kind: "skipped", reason: "no-campaign" }
  }

  const client = createSupabaseServiceRoleClient()
  const approver = autoGenerateApprover(campaign.id)
  const [active, history] = await Promise.all([
    client.from("batch_approvals").select("id", { count: "exact", head: true }).in("status", [...ACTIVE_APPROVAL_STATUSES] as never[]),
    client.from("batch_approvals").select("status,approved_at,approved_place_ids").eq("approved_by", approver),
  ])
  if (active.error !== null || active.count === null || history.error !== null) {
    // 예산·진행 상태를 읽지 못하면 진행하지 않는다 — 0건으로 간주하고 승인하면 한도를 넘길 수 있다.
    throw new Error("Failed to read approval state for auto-generate")
  }
  const campaignApprovals: CampaignApprovalSummary[] = history.data.map((row) => ({
    status: row.status,
    approvedAt: row.approved_at,
    placeIds: row.approved_place_ids,
  }))

  const decision = decideAutoGenerateStep({ enabled, campaign, nowIso: input.nowIso, activeApprovalCount: active.count, campaignApprovals })
  if (decision.kind !== "ready") {
    return { kind: "skipped", reason: decision.kind === "halted" ? `halted-${decision.status}` : decision.kind }
  }

  const placeIds = await pickEligiblePlaceIds(decision.pendingPlaceIds, decision.capacity)
  if (placeIds.length === 0) {
    // allowlist에 남은 장소가 전부 부적격(제외·생성 이력·게시됨 등) — 더 할 일이 없다.
    return { kind: "skipped", reason: "no-eligible" }
  }

  const { prepareApproval } = await import("./approval-request-service")
  const prepared = await prepareApproval({ placeIds, approvedBy: approver, maxCostUsd: approvalMaxCostUsd(placeIds.length), nowIso: input.nowIso })
  if (prepared.kind === "already-active") {
    return { kind: "skipped", reason: "busy" }
  }
  if (prepared.kind === "blocked") {
    // 적격 판정 직후에 상태가 바뀐 경우 — 승인 행은 만들어지지 않았다. 다음 주기에 다시 판정한다.
    return { kind: "skipped", reason: `blocked-${prepared.reason}` }
  }

  const { executeActivate } = await import("./approval-execution-service")
  const activated = await executeActivate({ activationToken: prepared.activationToken, nowIso: input.nowIso, previewDeploymentSha: input.previewDeploymentSha })
  if (activated.outcome.kind !== "accepted") {
    const reason = "reason" in activated.outcome ? activated.outcome.reason : activated.outcome.kind
    await closeUnactivatedApproval(prepared.approval.id, reason)
    return { kind: "activation-rejected", approvalId: prepared.approval.id, reason }
  }
  return { kind: "started", approvalId: prepared.approval.id, placeCount: placeIds.length }
}

// allowlist 순서를 지키며 적격 장소를 capacity만큼 고른다.
// 판정은 관리자 후보 화면과 같은 decideBatchCandidate — 시설 명칭 차단(추모·숙박)·excluded·생성 이력·slug 충돌이 모두 여기서 걸린다.
async function pickEligiblePlaceIds(pendingPlaceIds: readonly string[], capacity: number): Promise<readonly string[]> {
  const client = createSupabaseServiceRoleClient()
  const picked: string[] = []
  for (let offset = 0; offset < pendingPlaceIds.length && picked.length < capacity; offset += ELIGIBILITY_CHUNK) {
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

// 활성화가 거부된 승인을 열린 채로 두면 전역 1건 원칙 때문에 관리자 승인까지 막힌다.
// 실행 증거가 전혀 없는(approved/queued·미소진·미연결) 경우에만 취소로 닫는다 — 그 외에는 건드리지 않는다.
async function closeUnactivatedApproval(approvalId: string, reason: string): Promise<void> {
  const { createSupabaseApprovalRepository } = await import("./supabase-approval-repository")
  const approvals = createSupabaseApprovalRepository()
  try {
    const current = await approvals.findApprovalById(approvalId)
    if (
      current !== null &&
      (current.status === "approved" || current.status === "queued") &&
      current.activation_consumed_at === null &&
      current.batch_run_id === null
    ) {
      await approvals.cancelApprovalWithError(approvalId, { code: "auto-activate-failed", message: `auto-activate-failed:${reason}`.slice(0, 200) })
    }
  } catch {
    // 정리 실패는 삼킨다 — 승인 만료 시각이 지나면 기존 만료 처리가 닫는다.
  }
}
