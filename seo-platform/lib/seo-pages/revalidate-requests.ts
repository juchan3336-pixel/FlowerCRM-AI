import "server-only"

// 공개 캐시 갱신 요청 — Production이 아닌 곳에서 공개 콘텐츠를 고친 뒤, Production에게 캐시 갱신을 맡긴다.
//
// 장소 페이지(/places/[slug])는 정적으로 생성되고 유한 재검증 주기가 없다. 캐시는 배포별로 격리돼 있어
// Preview 배포에서 revalidatePath를 불러도 Production 캐시에는 닿지 않는다. 운영 작업(ops task)은 Preview의
// batch pump에서 돌기 때문에, 거기서 고친 공개 FAQ는 누군가 Production에서 갱신을 불러 주기 전까지 옛 화면으로 남는다.
//
// 그래서: 고친 쪽은 settings에 요청 행을 남기고(requestPublicRevalidation),
// Production의 publish pump가 매 주기 그 행을 읽어 revalidate한 뒤 지운다(processRevalidateRequests).
// 요청 처리는 게시 스위치(auto_publish)·게시 금지(freeze)와 무관하다 — 이미 공개된 URL의 캐시만 갱신한다.
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { Json } from "@/types/database"

export const REVALIDATE_REQUEST_PREFIX = "revalidate_request:"
const REQUEST_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/
const PLACE_PATH_PATTERN = /^\/places\/[a-z0-9][a-z0-9-]*$/
const UNIQUE_VIOLATION = "23505"
const MAX_REQUESTS_PER_TICK = 5

export function revalidateRequestKey(id: string): string {
  return `${REVALIDATE_REQUEST_PREFIX}${id}`
}

// 공개 장소 경로만 받는다 — 임의 경로의 캐시를 흔드는 통로가 되지 않게.
export function isRevalidatablePlacePath(path: unknown): path is string {
  return typeof path === "string" && PLACE_PATH_PATTERN.test(path)
}

// 요청을 남긴다. 같은 ID의 요청이 이미 있으면 그대로 둔다 (아직 처리되지 않은 같은 요청).
// 저장됐거나 이미 있으면 true.
export async function requestPublicRevalidation(input: Readonly<{ id: string; path: string; by: string; nowIso: string }>): Promise<boolean> {
  if (!REQUEST_ID_PATTERN.test(input.id) || !isRevalidatablePlacePath(input.path)) {
    return false
  }
  const client = createSupabaseServiceRoleClient()
  const { error } = await client.from("settings").insert({ key: revalidateRequestKey(input.id), value: { path: input.path, by: input.by, requested_at: input.nowIso } as Json })
  return error === null || error.code === UNIQUE_VIOLATION
}

export type RevalidateRequestsOutcome = { readonly processed: number; readonly failed: number; readonly discarded: number }

// Production에서만 부른다. 한 주기에 몇 건만 처리하고, 캐시 갱신이 성공한 요청만 지운다.
// 실패한 요청은 남아서 다음 주기에 다시 시도된다. 형식이 잘못된 요청은 갱신 없이 지운다.
export async function processRevalidateRequests(revalidate: (path: string) => boolean): Promise<RevalidateRequestsOutcome> {
  const client = createSupabaseServiceRoleClient()
  const { data, error } = await client.from("settings").select("key,value").like("key", `${REVALIDATE_REQUEST_PREFIX}%`).order("key", { ascending: true }).limit(MAX_REQUESTS_PER_TICK)
  if (error !== null) {
    throw new Error(`Failed to read revalidate requests: ${error.message}`)
  }
  let processed = 0
  let failed = 0
  let discarded = 0
  for (const row of data) {
    const value = typeof row.value === "object" && row.value !== null && !Array.isArray(row.value) ? (row.value as Record<string, unknown>) : null
    const path = value === null ? null : value["path"]
    if (!isRevalidatablePlacePath(path)) {
      await client.from("settings").delete().eq("key", row.key)
      discarded += 1
      continue
    }
    if (!revalidate(path)) {
      failed += 1
      continue
    }
    const removed = await client.from("settings").delete().eq("key", row.key).select("key")
    if (removed.error !== null || removed.data.length !== 1) {
      // 갱신은 됐고 행만 남았다 — 다음 주기에 한 번 더 갱신된다 (해가 없다).
      failed += 1
      continue
    }
    processed += 1
  }
  return { processed, failed, discarded }
}
