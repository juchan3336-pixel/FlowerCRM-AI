import "server-only"

// 승인 Batch 자동 실행 v1 — 승인 화면 후보 조회 (PR-C).
// 하드 조건 판정은 기존 decideBatchCandidate를 그대로 재사용하고, 승인 화면에 필요한
// 표시 필드(전화·검증 출처·verified_at·업종/모드·처리 상태·예상 토큰/비용)만 덧붙인다.
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import { contentModeForCategory, mappedCategories, type ContentMode } from "@/lib/ai/content-mode"
import type { ApprovalCandidateInput } from "./approval-policy"
import { ACTIVE_APPROVAL_STATUSES, ACTIVE_BATCH_ITEM_STATUSES, decideBatchCandidate, type BatchIneligibleReason } from "./candidate-policy"
import { ESTIMATED_COST_USD_PER_PLACE, ESTIMATED_TOKENS_PER_PLACE } from "./cost-policy"
import type { PlaceRow } from "@/types/database"

export type ApprovalCandidateView = {
  readonly placeId: string
  readonly name: string
  readonly region: string
  readonly address: string | null
  readonly phone: string | null
  readonly verifiedAt: string | null
  readonly verificationSourceUrls: readonly string[]
  readonly estimatedTokens: number
  readonly estimatedCostUsd: number
  readonly eligible: boolean
  readonly reason: BatchIneligibleReason | null
  // 업종 원문과 중앙 resolver가 판정한 콘텐츠 모드 — 모드 필터·표시용 (PR C).
  readonly category: string | null
  readonly contentMode: ContentMode | null
  readonly hasGeneration: boolean
  readonly seoPageStatus: string | null
}

// 승인 후보 = 공식 검증(verified) 완료된 draft 장소.
// published·미검증·excluded는 쿼리 단계에서 걸러지고, generation·seo_page·진행 중 처리 보유는 판정에서 걸러진다.
//
// 모드별로 나눠 읽는다: 전체를 verified_at 순으로 한 번에 자르면 물량이 많은 모드가 목록을 독점한다
// (2026-08-07: 후보 361곳 중 근조가 28곳인데 상위 50 안에는 4곳만 들어와 "장례식장이 4곳뿐"으로 보였다).
export async function listApprovalCandidates(limitPerMode = 60): Promise<readonly ApprovalCandidateView[]> {
  const client = createSupabaseServiceRoleClient()
  const collected: PlaceRow[] = []
  for (const mode of APPROVAL_QUEUE_MODES) {
    const { data: places, error } = await client
      .from("places")
      .select("*")
      .eq("status", "draft")
      .eq("official_verification_status", "verified")
      .in("category", [...categoriesForMode(mode)])
      .order("verified_at", { ascending: false })
      .limit(limitPerMode)
    if (error !== null) {
      throw new Error(`Failed to list approval candidates: ${error.message}`)
    }
    collected.push(...places)
  }
  return buildApprovalCandidateViews(collected)
}

// 모드별 실제 후보 수 — 화면 필터 칩에 표시한다. 조회 상한과 무관한 진짜 총계다.
export type ApprovalCandidateTotals = Readonly<Record<ContentMode, number>>

export async function countApprovalCandidatesByMode(): Promise<ApprovalCandidateTotals> {
  const client = createSupabaseServiceRoleClient()
  const entries = await Promise.all(
    APPROVAL_QUEUE_MODES.map(async (mode) => {
      const { count } = await client
        .from("places")
        .select("id", { count: "exact", head: true })
        .eq("status", "draft")
        .eq("official_verification_status", "verified")
        .in("category", [...categoriesForMode(mode)])
      return [mode, count ?? 0] as const
    }),
  )
  return Object.fromEntries(entries) as ApprovalCandidateTotals
}

const APPROVAL_QUEUE_MODES: readonly ContentMode[] = ["condolence", "celebration", "corporate-celebration"]

function categoriesForMode(mode: ContentMode): readonly string[] {
  return mappedCategories().filter((category) => contentModeForCategory(category) === mode)
}

// 판정에 필요한 부가 정보를 장소당 6쿼리가 아니라 전체 6쿼리로 모은다.
// (장소당 조회면 후보 300곳에 1,800회 왕복이라 화면이 제한 시간을 넘긴다.)
async function buildApprovalCandidateViews(places: readonly PlaceRow[]): Promise<readonly ApprovalCandidateView[]> {
  if (places.length === 0) {
    return []
  }
  const client = createSupabaseServiceRoleClient()
  const ids = places.map((place) => place.id)
  const slugs = places.map((place) => place.slug).filter((slug): slug is string => slug !== null)
  const paths = slugs.map((slug) => `/places/${slug}`)

  const [generations, seoByPlace, seoByPath, slugTwins, activeItems, activeApprovals] = await Promise.all([
    client.from("ai_generations").select("place_id").in("place_id", ids),
    client.from("seo_pages").select("place_id,status").eq("page_type", "place").in("place_id", ids),
    slugs.length === 0 ? Promise.resolve({ data: [] }) : client.from("seo_pages").select("path").in("path", paths),
    slugs.length === 0 ? Promise.resolve({ data: [] }) : client.from("places").select("id,slug").in("slug", slugs),
    client.from("batch_run_items").select("place_id").in("place_id", ids).in("status", [...ACTIVE_BATCH_ITEM_STATUSES] as never[]),
    client.from("batch_approvals").select("approved_place_ids").in("status", [...ACTIVE_APPROVAL_STATUSES] as never[]),
  ])

  const generationCounts = countBy((generations.data ?? []).map((row) => row.place_id))
  const seoStatusByPlace = new Map((seoByPlace.data ?? []).flatMap((row) => (row.place_id === null ? [] : [[row.place_id, row.status] as const])))
  const existingPaths = new Set((seoByPath.data ?? []).map((row) => row.path))
  const slugOwners = countBy((slugTwins.data ?? []).map((row) => row.slug).filter((slug): slug is string => slug !== null))
  const activeItemPlaces = new Set((activeItems.data ?? []).map((row) => row.place_id))
  const activeApprovalPlaces = new Set((activeApprovals.data ?? []).flatMap((row) => row.approved_place_ids))

  return places.map((place) => {
    const generationCount = generationCounts.get(place.id) ?? 0
    const decision = decideBatchCandidate({
      place,
      generationCount,
      // 같은 slug를 쓰는 다른 장소 수 — 자기 자신을 뺀다.
      slugDuplicateCount: place.slug === null ? 0 : Math.max(0, (slugOwners.get(place.slug) ?? 0) - 1),
      seoPagePathExists: place.slug !== null && existingPaths.has(`/places/${place.slug}`),
      verificationSourceUrls: place.verification_source_urls ?? null,
      activeBatchItemCount: activeItemPlaces.has(place.id) ? 1 : 0,
      activeApprovalCount: activeApprovalPlaces.has(place.id) ? 1 : 0,
    })
    return {
      placeId: place.id,
      name: place.name,
      // region·city가 같은 값인 경우가 많아 중복을 제거한다 (예: "대구 · 대구 · 북구" → "대구 · 북구").
      region: [...new Set([place.region, place.city, place.district].filter((value): value is string => value !== null && value.length > 0))].join(" · "),
      address: place.address,
      phone: place.phone,
      verifiedAt: place.verified_at ?? null,
      verificationSourceUrls: normalizeSourceUrls(place.verification_source_urls),
      estimatedTokens: ESTIMATED_TOKENS_PER_PLACE,
      estimatedCostUsd: ESTIMATED_COST_USD_PER_PLACE,
      eligible: decision.eligible,
      reason: decision.eligible ? null : decision.reason,
      category: place.category,
      contentMode: decision.mode,
      hasGeneration: generationCount > 0,
      seoPageStatus: seoStatusByPlace.get(place.id) ?? null,
    }
  })
}

function countBy(values: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return counts
}

// 승인 요청 검증용 — 요청받은 placeId의 실제 DB 상태를 읽어 판정 입력으로 만든다.
// 폼이 보낸 값은 신뢰하지 않는다 (임의 주입 차단). 존재하지 않는 id는 결과에서 빠진다.
export async function loadApprovalCandidateInputs(placeIds: readonly string[]): Promise<readonly ApprovalCandidateInput[]> {
  if (placeIds.length === 0) {
    return []
  }
  const client = createSupabaseServiceRoleClient()
  const { data: places, error } = await client.from("places").select("*").in("id", [...new Set(placeIds)])
  if (error !== null) {
    throw new Error(`Failed to load approval candidates: ${error.message}`)
  }

  const byId = new Map(places.map((place) => [place.id, place]))
  const inputs: ApprovalCandidateInput[] = []
  // 요청 순서를 유지해 승인 스냅샷 순서가 사용자가 본 순서와 같게 한다.
  for (const placeId of placeIds) {
    const place = byId.get(placeId)
    if (place === undefined) {
      continue
    }
    const [{ count: generationCount }, seoPage] = await Promise.all([
      client.from("ai_generations").select("id", { count: "exact", head: true }).eq("place_id", place.id),
      client.from("seo_pages").select("id", { count: "exact", head: true }).eq("page_type", "place").eq("place_id", place.id),
    ])
    inputs.push({
      place: {
        id: place.id,
        name: place.name,
        address: place.address,
        phone: place.phone,
        slug: place.slug,
        status: place.status,
        category: place.category,
        official_verification_status: place.official_verification_status ?? null,
        verification_source_urls: place.verification_source_urls ?? null,
      },
      generationCount: generationCount ?? 0,
      seoPageExists: (seoPage.count ?? 0) > 0,
      estimatedTokens: ESTIMATED_TOKENS_PER_PLACE,
      estimatedCostUsd: ESTIMATED_COST_USD_PER_PLACE,
    })
  }
  return inputs
}

// verification_source_urls는 Json 컬럼이라 배열·문자열 어느 쪽이든 안전하게 문자열 목록으로 만든다.
export function normalizeSourceUrls(value: unknown): readonly string[] {
  if (typeof value === "string") {
    return value.trim().length > 0 ? [value.trim()] : []
  }
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
}
