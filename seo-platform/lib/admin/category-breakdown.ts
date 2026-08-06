import "server-only"

// 업종별 현황 — 수집된 전체 수와 실제 공개된 수를 나란히 본다.
//
// 지금까지 대시보드는 총계만 보여 줘서 "장례식장이 몇 곳이고 그중 몇 곳이 나갔는지"를
// 알 수 없었다 (2026-08-06: 전체 20,552곳 중 funeral이 380곳뿐이라는 사실을 DB를 직접 조회해야 알았다).
// 수집 편중과 배포 진행을 화면에서 바로 읽을 수 있게 한다.
//
// PostgREST는 group by를 지원하지 않으므로 category 열만 전량 읽어 애플리케이션에서 센다.
// (20,552행 × 문자열 1개 — 목록 조회보다 가볍고, 대시보드는 force-dynamic이라 매번 최신이다.)
import { contentModeForCategory, type ContentMode } from "@/lib/ai/content-mode"
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"

export type CategoryBreakdownRow = {
  readonly category: string
  // 콘텐츠 모드가 매핑된 업종만 생성·게시 대상이다. null이면 아직 지원하지 않는 업종.
  readonly contentMode: ContentMode | null
  readonly total: number
  readonly published: number
  readonly verified: number
}

export type CategoryBreakdown = {
  readonly rows: readonly CategoryBreakdownRow[]
  readonly totalPlaces: number
  readonly totalPublished: number
  // 지원 업종(생성 가능)과 미지원 업종의 합계 — 수집 편중을 한 줄로 보여준다.
  readonly supportedTotal: number
  readonly unsupportedTotal: number
}

const PAGE_SIZE = 1000

// category·status·검증 상태만 읽어 업종별로 센다. 페이지네이션은 PostgREST 1,000행 상한 때문.
export async function loadCategoryBreakdown(): Promise<CategoryBreakdown> {
  const client = createSupabaseServiceRoleClient()
  const counts = new Map<string, { total: number; published: number; verified: number }>()
  let offset = 0
  let totalPlaces = 0
  let totalPublished = 0

  for (;;) {
    const { data, error } = await client
      .from("places")
      .select("category,status,official_verification_status")
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)
    if (error !== null) {
      throw new Error(`Failed to load category breakdown: ${error.message}`)
    }
    for (const row of data) {
      const category = typeof row.category === "string" && row.category.length > 0 ? row.category : "(미분류)"
      const entry = counts.get(category) ?? { total: 0, published: 0, verified: 0 }
      entry.total += 1
      if (row.status === "published") {
        entry.published += 1
        totalPublished += 1
      }
      if (row.official_verification_status === "verified") {
        entry.verified += 1
      }
      counts.set(category, entry)
      totalPlaces += 1
    }
    if (data.length < PAGE_SIZE) {
      break
    }
    offset += PAGE_SIZE
  }

  const rows = [...counts.entries()]
    .map(([category, entry]) => ({
      category,
      contentMode: contentModeForCategory(category),
      total: entry.total,
      published: entry.published,
      verified: entry.verified,
    }))
    // 공개된 수가 많은 순 → 같으면 수집량 순. 실제로 배포가 진행 중인 업종이 위로 온다.
    .sort((a, b) => b.published - a.published || b.total - a.total)

  const supportedTotal = rows.filter((row) => row.contentMode !== null).reduce((sum, row) => sum + row.total, 0)

  return {
    rows,
    totalPlaces,
    totalPublished,
    supportedTotal,
    unsupportedTotal: totalPlaces - supportedTotal,
  }
}
