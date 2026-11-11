// 검수 주소 등록 장소의 공개 캐시 맞추기 — Production의 publish pump가 매 주기 부른다.
//
// 장소 페이지(/places/[slug])와 sitemap은 캐시돼 있고 유한 재검증 주기가 없다. 등록 장소의 DB 원문(이름·slug·주소)은
// 시트 동기화나 수동 수정으로 언제든 바뀔 수 있고, 그러면 공개 판정이 matched ↔ conflict로 바뀐다
// (conflict는 공개 표면에서 내려가고, 엔트리를 갱신하거나 원문이 돌아오면 다시 올라온다).
// 쓰는 쪽마다 캐시 갱신을 걸면 빠지는 경로가 생기므로, 여기서 "지금의 판정"을 마지막으로 반영한 판정과 비교해
// 달라진 장소만 재검증을 요청한다.
//
// - 기록에는 판정 서명과 함께 그때 갱신한 경로를 남긴다. slug가 바뀌거나 엔트리가 사라져도 이전 경로를 잃지 않고
//   이전·새 경로를 모두 재검증한다.
// - 한 장소의 경로가 모두 성공해야 그 장소의 기록을 올린다. 실패하거나 기록 저장이 실패하면 다음 주기에 다시 시도된다.
// - 정상적인 1분 주기 호출에서 변경을 감지해 재검증을 요청한다. 호출·조회·재검증이 실패하면 그만큼 늦어진다.
//   revalidatePath 호출이 성공했다는 것과 공개 응답이 실제로 바뀌었다는 것은 별개다 — 배포 뒤 공개 URL로 확인한다.
// - 목록·허브·홈은 요청마다 새로 그리므로(dynamic) 따로 갱신할 캐시가 없다.
import { resolveVerifiedAddress, VERIFIED_ADDRESSES, type VerifiedAddressEntry } from "@/lib/domain/verified-address"
import type { Json } from "@/types/database"

export const VERIFIED_ADDRESS_CACHE_STATE_KEY = "verified-address-cache-state"

const PLACE_PATH_PATTERN = /^\/places\/[a-z0-9][a-z0-9-]*$/

export type VerifiedAddressPlaceSnapshot = { readonly id: string; readonly slug: string | null; readonly name: string | null; readonly address: string | null }

// 장소별 기록 — 마지막으로 반영한 판정 서명과, 그 판정을 반영하며 갱신한 경로.
export type VerifiedAddressCacheRecord = { readonly signature: string; readonly paths: readonly string[] }
export type VerifiedAddressCacheState = Readonly<Record<string, VerifiedAddressCacheRecord>>

export type VerifiedAddressCacheChange = {
  readonly placeId: string
  // null이면 엔트리가 사라진 장소 — 이전 경로를 갱신한 뒤 기록을 지운다.
  readonly next: VerifiedAddressCacheRecord | null
  // 이번에 재검증할 경로 (이전 기록의 경로 + 새 경로)
  readonly paths: readonly string[]
}

export type VerifiedAddressCachePlan = {
  readonly changes: readonly VerifiedAddressCacheChange[]
  readonly unchanged: VerifiedAddressCacheState
}

// 판정 서명 — 공개 결과를 바꾸는 값만 담는다 (matched의 revision·주소, conflict 여부, 등록 slug, 현재 slug).
export function verifiedAddressSignature(entry: VerifiedAddressEntry, place: VerifiedAddressPlaceSnapshot | undefined): string {
  if (place === undefined) {
    return `missing|${entry.expectedSlug}|`
  }
  const resolution = resolveVerifiedAddress({ placeId: place.id, slug: place.slug, name: place.name, rawAddress: place.address }, [entry])
  const state = resolution.kind === "matched" ? `matched:${String(resolution.revision)}:${resolution.address}` : resolution.kind
  return `${state}|${entry.expectedSlug}|${place.slug ?? ""}`
}

function placePathsOf(slugs: readonly (string | null | undefined)[]): string[] {
  return [...new Set(slugs.filter((slug): slug is string => typeof slug === "string").map((slug) => `/places/${slug}`).filter((path) => PLACE_PATH_PATTERN.test(path)))]
}

export function planVerifiedAddressCacheSync(entries: readonly VerifiedAddressEntry[], places: readonly VerifiedAddressPlaceSnapshot[], recorded: VerifiedAddressCacheState): VerifiedAddressCachePlan {
  const byId = new Map(places.map((place) => [place.id, place]))
  const changes: VerifiedAddressCacheChange[] = []
  const unchanged: Record<string, VerifiedAddressCacheRecord> = {}
  for (const entry of entries) {
    const place = byId.get(entry.placeId)
    const signature = verifiedAddressSignature(entry, place)
    const previous = recorded[entry.placeId]
    if (previous?.signature === signature) {
      unchanged[entry.placeId] = previous
      continue
    }
    // 지금 유효한 경로: 등록 slug의 경로와 현재 slug의 경로.
    const currentPaths = placePathsOf([entry.expectedSlug, place?.slug])
    // 재검증 대상: 이전에 갱신했던 경로까지 — 등록·DB slug가 함께 A→B로 바뀌어도 /places/A 캐시를 내린다.
    const paths = [...new Set([...(previous?.paths ?? []).filter((path) => PLACE_PATH_PATTERN.test(path)), ...currentPaths])]
    changes.push({ placeId: entry.placeId, next: { signature, paths: currentPaths }, paths })
  }
  // 엔트리가 사라진 장소 — 이전 경로를 갱신하고(공개 판정이 바뀌었다) 기록을 지운다.
  for (const [placeId, previous] of Object.entries(recorded)) {
    if (!entries.some((entry) => entry.placeId === placeId)) {
      changes.push({ placeId, next: null, paths: previous.paths.filter((path) => PLACE_PATH_PATTERN.test(path)) })
    }
  }
  return { changes, unchanged }
}

export type VerifiedAddressCacheOutcome = { readonly refreshed: number; readonly failed: number }

// 저장소 경계 — 실제 구현은 Supabase, 테스트는 대역을 넣는다.
export type VerifiedAddressCacheStore = {
  readonly readState: () => Promise<VerifiedAddressCacheState>
  readonly readPlaces: (placeIds: readonly string[]) => Promise<readonly VerifiedAddressPlaceSnapshot[]>
  readonly saveState: (state: VerifiedAddressCacheState) => Promise<void>
}

// revalidate는 경로 하나와 sitemap을 함께 갱신하고 성공 여부를 돌려준다 (publish-runner의 revalidatePublicPlacePaths).
export async function reconcileVerifiedAddressCacheWith(
  store: VerifiedAddressCacheStore,
  revalidate: (path: string) => boolean,
  entries: readonly VerifiedAddressEntry[],
): Promise<VerifiedAddressCacheOutcome> {
  const recorded = await store.readState()
  if (entries.length === 0 && Object.keys(recorded).length === 0) {
    return { refreshed: 0, failed: 0 }
  }
  const places = entries.length === 0 ? [] : await store.readPlaces(entries.map((entry) => entry.placeId))
  const plan = planVerifiedAddressCacheSync(entries, places, recorded)
  if (plan.changes.length === 0) {
    return { refreshed: 0, failed: 0 }
  }
  const next: Record<string, VerifiedAddressCacheRecord> = { ...plan.unchanged }
  let refreshed = 0
  let failed = 0
  for (const change of plan.changes) {
    // 경로를 하나도 건너뛰지 않고 모두 시도한다 — 앞 경로가 실패해도 뒤 경로의 캐시는 내린다.
    const results = change.paths.map((path) => revalidate(path))
    if (results.every(Boolean)) {
      if (change.next !== null) {
        next[change.placeId] = change.next
      }
      refreshed += 1
      continue
    }
    // 옛 기록을 그대로 둔다 (없었으면 없는 채로) — 다음 주기에 다시 다르다고 판정돼 전체 경로를 재시도한다.
    const previous = recorded[change.placeId]
    if (previous !== undefined) {
      next[change.placeId] = previous
    }
    failed += 1
  }
  // 저장이 실패하면 예외로 드러난다 — 기록이 옛 값으로 남아 다음 주기에 같은 경로를 다시 재검증한다 (해가 없다).
  await store.saveState(next)
  return { refreshed, failed }
}

export async function reconcileVerifiedAddressCache(revalidate: (path: string) => boolean, entries: readonly VerifiedAddressEntry[] = VERIFIED_ADDRESSES): Promise<VerifiedAddressCacheOutcome> {
  const { createSupabaseServiceRoleClient } = await import("@/lib/supabase/server")
  const client = createSupabaseServiceRoleClient()
  return reconcileVerifiedAddressCacheWith(
    {
      async readState() {
        const { data, error } = await client.from("settings").select("value").eq("key", VERIFIED_ADDRESS_CACHE_STATE_KEY).maybeSingle()
        if (error !== null) {
          throw new Error(`Failed to read verified address cache state: ${error.message}`)
        }
        return parseVerifiedAddressCacheState(data?.value)
      },
      async readPlaces(placeIds) {
        const { data, error } = await client.from("places").select("id,slug,name,address").in("id", [...placeIds])
        if (error !== null) {
          throw new Error(`Failed to read verified address places: ${error.message}`)
        }
        return data
      },
      async saveState(state) {
        const { error } = await client.from("settings").upsert({ key: VERIFIED_ADDRESS_CACHE_STATE_KEY, value: state as unknown as Json }, { onConflict: "key" })
        if (error !== null) {
          throw new Error(`Failed to save verified address cache state: ${error.message}`)
        }
      },
    },
    revalidate,
    entries,
  )
}

// 형식이 맞지 않는 기록은 버린다 — 그 장소는 "기록 없음"으로 보고 다시 재검증한다.
export function parseVerifiedAddressCacheState(value: unknown): VerifiedAddressCacheState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {}
  }
  const state: Record<string, VerifiedAddressCacheRecord> = {}
  for (const [placeId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      continue
    }
    const record = raw as Record<string, unknown>
    const signature = record["signature"]
    const paths = record["paths"]
    if (typeof signature === "string" && Array.isArray(paths) && paths.every((path): path is string => typeof path === "string")) {
      state[placeId] = { signature, paths }
    }
  }
  return state
}
