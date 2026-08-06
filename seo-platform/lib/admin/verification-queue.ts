import "server-only"

// 검증 관리 — 공식 검증(verified) 대기 후보를 카테고리별로 자동 추출한다.
//
// 승인 자동 생성의 후보는 verified 장소뿐이라, verified 공급이 끊기면 승인 화면이 비어
// 작업자가 콘솔에서 아무것도 할 수 없었다 (2026-08-06 실사용 피드백). 이 모듈은 그 앞 단계를
// 콘솔로 가져온다: 공식 홈페이지가 등록된 미검증 draft 장소를 추려 보여주고, 작업자가
// 홈페이지에서 명칭·주소·전화를 눈으로 확인한 뒤 클릭으로 verified를 반영한다.
// 검증 판단 자체는 자동화하지 않는다 — 실존 확인은 사람이 한다는 계약을 유지한다.
import { contentModeForCategory, mappedCategories, type ContentMode } from "@/lib/ai/content-mode"
import { isMemorialFacilityName } from "@/lib/domain/facility-type"
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { PlaceRow } from "@/types/database"

export type VerificationQueueCandidate = {
  readonly placeId: string
  readonly name: string
  readonly region: string
  readonly address: string | null
  readonly phone: string | null
  readonly homepage: string
  readonly category: string | null
  readonly contentMode: ContentMode
}

// 시설 유형 판정은 lib/domain/facility-type의 공용 규칙을 쓴다 — 큐·승인·게시가 같은 기준을 본다.
export function isLikelyNonParlorFacility(name: string): boolean {
  return isMemorialFacilityName(name)
}

// 큐 대상 하드 조건 — 서비스와 테스트가 공유한다.
// draft·미검증·홈페이지 보유·주소 보유·콘텐츠 모드 판정 가능이 전부 참이어야 한다.
// 장례(condolence) 모드는 시설 유형 휴리스틱을 추가로 지난다.
export function isVerificationQueueCandidate(place: Pick<PlaceRow, "status" | "homepage" | "address" | "category" | "name"> & { readonly official_verification_status?: string | null }): boolean {
  if (place.status !== "draft") return false
  if ((place.official_verification_status ?? null) !== null) return false
  if (typeof place.homepage !== "string" || place.homepage.trim().length === 0) return false
  if (typeof place.address !== "string" || place.address.trim().length === 0) return false
  const mode = contentModeForCategory(place.category)
  if (mode === null) return false
  if (mode === "condolence" && isLikelyNonParlorFacility(place.name)) return false
  return true
}

// 모드별 카테고리 원문 목록 — 미검증 풀이 수천 행이라 한 번에 읽으면 특정 모드(예: 장례식장)가
// 최신 수집분에 밀려 목록에서 사라진다. 모드마다 따로 조회해 세 모드가 모두 큐에 나타나게 한다.
function categoriesForMode(mode: ContentMode): readonly string[] {
  return mappedCategories().filter((category) => contentModeForCategory(category) === mode)
}

const QUEUE_MODES: readonly ContentMode[] = ["condolence", "celebration", "corporate-celebration"]

// 미검증 draft 장소 중 검증 작업이 가능한 후보를 모드별로 추출한다.
// AI 생성 이력·SEO 페이지가 이미 있는 장소는 검증해도 승인 후보가 되지 못하므로 함께 걸러
// '검증하면 곧바로 생성 승인 가능한' 후보만 남긴다. 같은 정규화 이름은 첫 행만 남긴다(중복 수집 방어).
export async function listVerificationQueueCandidates(limitPerMode = 20): Promise<readonly VerificationQueueCandidate[]> {
  const client = createSupabaseServiceRoleClient()
  const filtered: PlaceRow[] = []
  const seenNames = new Set<string>()
  for (const mode of QUEUE_MODES) {
    const { data: places, error } = await client
      .from("places")
      .select("*")
      .eq("status", "draft")
      .is("official_verification_status", null)
      .not("homepage", "is", null)
      .not("address", "is", null)
      .in("category", [...categoriesForMode(mode)])
      .order("collected_at", { ascending: false, nullsFirst: false })
      .limit(200)
    if (error !== null) {
      throw new Error(`Failed to list verification queue candidates: ${error.message}`)
    }
    let kept = 0
    for (const place of places) {
      if (!isVerificationQueueCandidate(place)) continue
      const nameKey = place.normalized_name.length > 0 ? place.normalized_name : place.name
      if (seenNames.has(nameKey)) continue
      seenNames.add(nameKey)
      filtered.push(place)
      kept += 1
      // 생성·SEO 보유 필터에서 일부 빠질 수 있어 모드당 여유분(3배)까지 모은다.
      if (kept >= limitPerMode * 3) break
    }
  }
  if (filtered.length === 0) {
    return []
  }

  const ids = filtered.map((place) => place.id)
  const [{ data: generationRows }, { data: seoRows }] = await Promise.all([
    client.from("ai_generations").select("place_id").in("place_id", ids),
    client.from("seo_pages").select("place_id").in("place_id", ids),
  ])
  const hasGeneration = new Set((generationRows ?? []).map((row) => row.place_id))
  const hasSeoPage = new Set((seoRows ?? []).map((row) => row.place_id).filter((value): value is string => value !== null))

  const views: VerificationQueueCandidate[] = []
  const perModeCount = new Map<ContentMode, number>()
  for (const place of filtered) {
    if (hasGeneration.has(place.id) || hasSeoPage.has(place.id)) continue
    const mode = contentModeForCategory(place.category)
    if (mode === null) continue
    // 모드별 상한 — 한 모드가 목록을 독점하지 않게 한다 (필터를 바꿔도 각 모드 후보가 보이도록).
    const current = perModeCount.get(mode) ?? 0
    if (current >= limitPerMode) continue
    perModeCount.set(mode, current + 1)
    views.push({
      placeId: place.id,
      name: place.name,
      region: [...new Set([place.region, place.city, place.district].filter((value): value is string => value !== null && value.length > 0))].join(" · "),
      address: place.address,
      phone: place.phone,
      homepage: (place.homepage ?? "").trim(),
      category: place.category,
      contentMode: mode,
    })
  }
  return views
}

export const VERIFY_MAX_ITEMS = 10

export type MarkVerifiedResult = {
  readonly requested: number
  readonly updated: number
  // 조건 불충족(이미 검증됨·draft 아님·홈페이지 없음 등)으로 건너뛴 장소 이름들.
  readonly skipped: readonly string[]
}

// 선택 장소를 조건부로 verified 처리한다 — 이미 verified/excluded인 행은 절대 덮어쓰지 않는다.
// 출처는 장소의 공식 홈페이지 URL을 그대로 기록한다 (작업자가 그 페이지를 확인했다는 계약).
export async function markPlacesVerified(input: Readonly<{ placeIds: readonly string[]; verifiedBy: string; nowIso: string }>): Promise<MarkVerifiedResult> {
  const uniqueIds = [...new Set(input.placeIds)].slice(0, VERIFY_MAX_ITEMS)
  const client = createSupabaseServiceRoleClient()
  let updated = 0
  const skipped: string[] = []
  for (const placeId of uniqueIds) {
    const { data: place } = await client.from("places").select("*").eq("id", placeId).maybeSingle()
    if (place === null || !isVerificationQueueCandidate(place)) {
      skipped.push(place?.name ?? placeId)
      continue
    }
    const homepage = (place.homepage ?? "").trim()
    const { data: rows, error } = await client
      .from("places")
      .update({
        official_verification_status: "verified",
        verified_at: input.nowIso,
        verified_by: input.verifiedBy,
        verification_source_urls: [homepage],
      })
      .eq("id", placeId)
      .eq("status", "draft")
      .is("official_verification_status", null)
      .select("id")
    if (error !== null) {
      throw new Error(`Failed to mark place verified: ${error.message}`)
    }
    if (rows.length === 1) {
      updated += 1
    } else {
      skipped.push(place.name)
    }
  }
  return { requested: uniqueIds.length, updated, skipped }
}
