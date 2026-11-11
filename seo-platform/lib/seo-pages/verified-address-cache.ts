// 검수 주소 등록 장소의 공개 캐시 맞추기 — Production의 publish pump가 매 주기 부른다.
//
// 장소 페이지(/places/[slug])와 sitemap은 캐시돼 있고 유한 재검증 주기가 없다. 등록 장소의 DB 원문(이름·slug·주소)은
// 시트 동기화나 수동 수정으로 언제든 바뀔 수 있고, 그러면 공개 판정이 matched ↔ conflict로 바뀐다
// (conflict는 공개 표면에서 내려가고, 엔트리를 갱신하거나 원문이 돌아오면 다시 올라온다).
// 쓰는 쪽마다 캐시 갱신을 걸면 빠지는 경로가 생기므로, 여기서 "지금의 판정"을 마지막으로 반영한 판정과 비교해
// 달라진 장소만 갱신한다. 갱신이 실패하면 기록을 올리지 않아 다음 주기에 다시 시도된다.
// 목록·허브·홈은 요청마다 새로 그리므로(dynamic) 따로 갱신할 캐시가 없다.
import { resolveVerifiedAddress, VERIFIED_ADDRESSES, type VerifiedAddressEntry } from "@/lib/domain/verified-address"
import type { Json } from "@/types/database"

export const VERIFIED_ADDRESS_CACHE_STATE_KEY = "verified-address-cache-state"

const PLACE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/

export type VerifiedAddressPlaceSnapshot = { readonly id: string; readonly slug: string | null; readonly name: string | null; readonly address: string | null }

export type VerifiedAddressCachePlan = {
  // 갱신할 장소별 경로 묶음 — 한 장소의 경로가 모두 성공해야 그 장소의 기록을 올린다.
  readonly changes: readonly { readonly placeId: string; readonly signature: string; readonly paths: readonly string[] }[]
  // 변함없는 장소의 기록 (그대로 유지) — 등록에서 빠진 장소의 기록은 여기 없으므로 저장할 때 사라진다.
  readonly unchanged: Readonly<Record<string, string>>
}

// 판정 서명 — 공개 결과를 바꾸는 값만 담는다 (matched의 revision·주소, conflict 여부, 현재 slug).
export function verifiedAddressSignature(entry: VerifiedAddressEntry, place: VerifiedAddressPlaceSnapshot | undefined): string {
  if (place === undefined) {
    return "missing"
  }
  const resolution = resolveVerifiedAddress({ placeId: place.id, slug: place.slug, name: place.name, rawAddress: place.address }, [entry])
  const state = resolution.kind === "matched" ? `matched:${String(resolution.revision)}:${resolution.address}` : resolution.kind
  return `${state}|${place.slug ?? ""}`
}

export function planVerifiedAddressCacheSync(
  entries: readonly VerifiedAddressEntry[],
  places: readonly VerifiedAddressPlaceSnapshot[],
  recorded: Readonly<Record<string, string>>,
): VerifiedAddressCachePlan {
  const byId = new Map(places.map((place) => [place.id, place]))
  const changes: { placeId: string; signature: string; paths: string[] }[] = []
  const unchanged: Record<string, string> = {}
  for (const entry of entries) {
    const place = byId.get(entry.placeId)
    const signature = verifiedAddressSignature(entry, place)
    if (recorded[entry.placeId] === signature) {
      unchanged[entry.placeId] = signature
      continue
    }
    // 등록 당시 slug의 경로와 지금 slug의 경로를 모두 갱신한다 (slug가 바뀌었으면 옛 경로의 캐시도 내려야 한다).
    const slugs = [...new Set([entry.expectedSlug, place?.slug ?? null].filter((slug): slug is string => slug !== null && PLACE_SLUG_PATTERN.test(slug)))]
    changes.push({ placeId: entry.placeId, signature, paths: slugs.map((slug) => `/places/${slug}`) })
  }
  return { changes, unchanged }
}

export type VerifiedAddressCacheOutcome = { readonly refreshed: number; readonly failed: number }

// revalidate는 경로 하나와 sitemap을 함께 갱신하고 성공 여부를 돌려준다 (publish-runner의 revalidatePublicPlacePaths).
export async function reconcileVerifiedAddressCache(revalidate: (path: string) => boolean, entries: readonly VerifiedAddressEntry[] = VERIFIED_ADDRESSES): Promise<VerifiedAddressCacheOutcome> {
  const { createSupabaseServiceRoleClient } = await import("@/lib/supabase/server")
  const client = createSupabaseServiceRoleClient()
  const stateRow = await client.from("settings").select("value").eq("key", VERIFIED_ADDRESS_CACHE_STATE_KEY).maybeSingle()
  if (stateRow.error !== null) {
    throw new Error(`Failed to read verified address cache state: ${stateRow.error.message}`)
  }
  const recorded = parseRecordedState(stateRow.data?.value)
  if (entries.length === 0 && Object.keys(recorded).length === 0) {
    return { refreshed: 0, failed: 0 }
  }
  const placeRows =
    entries.length === 0
      ? { data: [] as VerifiedAddressPlaceSnapshot[], error: null }
      : await client
          .from("places")
          .select("id,slug,name,address")
          .in(
            "id",
            entries.map((entry) => entry.placeId),
          )
  if (placeRows.error !== null) {
    throw new Error(`Failed to read verified address places: ${placeRows.error.message}`)
  }
  const plan = planVerifiedAddressCacheSync(entries, placeRows.data, recorded)
  const removedIds = Object.keys(recorded).filter((placeId) => !entries.some((entry) => entry.placeId === placeId))
  if (plan.changes.length === 0 && removedIds.length === 0) {
    return { refreshed: 0, failed: 0 }
  }
  const next: Record<string, string> = { ...plan.unchanged }
  let refreshed = 0
  let failed = 0
  for (const change of plan.changes) {
    const ok = change.paths.every((path) => revalidate(path))
    if (ok) {
      next[change.placeId] = change.signature
      refreshed += 1
    } else {
      // 옛 기록을 그대로 둔다 — 다음 주기에 다시 다르다고 판정돼 재시도된다.
      const previous = recorded[change.placeId]
      if (previous !== undefined) {
        next[change.placeId] = previous
      }
      failed += 1
    }
  }
  // 등록에서 빠진 장소는 기록만 지운다 — 그 장소의 경로는 엔트리가 없어 여기서 알 수 없다.
  // 엔트리를 지우는 변경은 그 장소의 글을 다시 만들어 게시하는 절차와 함께 해야 한다 (게시 가드가 옛 기록을 막는다).
  const saved = await client.from("settings").upsert({ key: VERIFIED_ADDRESS_CACHE_STATE_KEY, value: next as Json }, { onConflict: "key" })
  if (saved.error !== null) {
    throw new Error(`Failed to save verified address cache state: ${saved.error.message}`)
  }
  return { refreshed, failed }
}

function parseRecordedState(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {}
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((pair): pair is [string, string] => typeof pair[1] === "string"))
}
