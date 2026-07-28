import "server-only"

// 승인 Batch 자동 실행 v1 — 승인 화면 후보 조회 (PR-C).
// 하드 조건 판정은 기존 decideBatchCandidate를 그대로 재사용하고, 승인 화면에 필요한
// 표시 필드(전화·검증 출처·verified_at·예상 토큰/비용)만 덧붙인다.
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { ApprovalCandidateInput } from "./approval-policy"
import { decideBatchCandidate, type BatchIneligibleReason } from "./candidate-policy"
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
}

// 승인 후보 = 공식 검증(verified) 완료된 draft 장소.
// published·미검증·excluded는 쿼리 단계에서 걸러지고, generation·seo_page 보유는 판정에서 걸러진다.
export async function listApprovalCandidates(limit = 50): Promise<readonly ApprovalCandidateView[]> {
  const client = createSupabaseServiceRoleClient()
  const { data: places, error } = await client
    .from("places")
    .select("*")
    .eq("status", "draft")
    .eq("official_verification_status", "verified")
    .order("verified_at", { ascending: false })
    .limit(limit)
  if (error !== null) {
    throw new Error(`Failed to list approval candidates: ${error.message}`)
  }

  const views: ApprovalCandidateView[] = []
  for (const place of places) {
    views.push(await toApprovalCandidateView(place))
  }
  return views
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

async function toApprovalCandidateView(place: PlaceRow): Promise<ApprovalCandidateView> {
  const client = createSupabaseServiceRoleClient()
  const [{ count: generationCount }, slugDup, seoPage] = await Promise.all([
    client.from("ai_generations").select("id", { count: "exact", head: true }).eq("place_id", place.id),
    place.slug === null
      ? Promise.resolve({ count: 0 })
      : client.from("places").select("id", { count: "exact", head: true }).eq("slug", place.slug).neq("id", place.id),
    place.slug === null
      ? Promise.resolve({ count: 0 })
      : client.from("seo_pages").select("id", { count: "exact", head: true }).eq("path", `/places/${place.slug}`),
  ])
  const decision = decideBatchCandidate({
    place,
    generationCount: generationCount ?? 0,
    slugDuplicateCount: slugDup.count ?? 0,
    seoPagePathExists: (seoPage.count ?? 0) > 0,
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
  }
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
