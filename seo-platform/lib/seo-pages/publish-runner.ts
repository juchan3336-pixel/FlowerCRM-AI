// 단일 장소 게시 코어 — 관리자 단건 액션과 Batch 오케스트레이션이 공유한다.
// publishPlacePageAction의 본문(RPC → revalidate → 비동기 검증 예약)을 동작 무변경으로 추출한 것 (PR-1 batch 준비).
// notice 매핑·redirect는 호출부(actions.ts) 책임. 게시 RPC의 DB 상태 변경 순서는 그대로 유지된다.
import { randomUUID } from "node:crypto"

import { revalidatePath } from "next/cache"

import type { ForbiddenVocabularyFinding } from "@/lib/ai/mode-vocabulary"
import type { GenerationAddressCheck } from "@/lib/domain/verified-address"

export type PublishRunResult =
  | { readonly kind: "published" | "already-published"; readonly path: string | null; readonly revalidated: boolean }
  | { readonly kind: "blocked" }
  // 업종에 맞지 않는 표현이 남아 있어 게시를 거부했다 — DB는 건드리지 않는다.
  | { readonly kind: "vocabulary-blocked"; readonly findings: readonly ForbiddenVocabularyFinding[] }
  // 업종을 콘텐츠 모드로 판정할 수 없어 어휘 검사 자체가 불가능하다 — 검사를 건너뛰는 대신 게시를 거부한다.
  | { readonly kind: "category-blocked"; readonly category: string | null }
  // 검수 주소 등록 장소인데 등록 값·생성 당시 주소 기록이 지금과 다르다 — DB는 건드리지 않는다.
  | { readonly kind: "address-blocked"; readonly reason: "conflict" | "record-missing" | "record-stale"; readonly detail: string }
  | { readonly kind: "unexpected" }

export type PublishRunDependencies = {
  // next/server의 after — 응답 이후 실행할 비동기 공개 검증 콜백 등록 (redirect throw 이전에 등록 완료)
  readonly registerAfter: (callback: () => Promise<void>) => void
}

export async function runPlacePublish(placeId: string, dependencies: PublishRunDependencies): Promise<PublishRunResult> {
  // 콘텐츠 보정과의 상호 배제 — 단건·배치·자동 게시가 모두 이 진입점을 지난다.
  // 게시 lock을 실제로 얻은 뒤에만 진행하고, RPC가 끝날 때까지 쥔다. "표식을 한 번 읽고 진행"으로는
  // 읽은 뒤 RPC까지의 지연 동안 보정이 끼어드는 것을 막지 못한다.
  // lock을 얻은 다음 게시 금지(freeze)를 본다 — 순서 규칙은 publish-hold.ts 머리말 참고.
  const { acquirePublishLock, isPublishFrozen, releasePublishLock } = await import("./publish-hold")
  const lockOwner = `publish:${placeId}:${randomUUID()}`
  let locked = false
  try {
    locked = await acquirePublishLock({ by: lockOwner, ttlMs: PUBLISH_LOCK_TTL_MS, nowIso: new Date().toISOString() })
  } catch {
    locked = false
  }
  if (!locked) {
    return { kind: "blocked" }
  }
  try {
    if (await isPublishFrozen()) {
      return { kind: "blocked" }
    }
    return await runPlacePublishLocked(placeId, dependencies)
  } finally {
    try {
      await releasePublishLock(lockOwner)
    } catch {
      // 놓지 못해도 만료 시각에 무효가 된다.
    }
  }
}

// 게시 한 건의 lock 수명 — 어휘 검사·RPC·캐시 갱신보다 넉넉하게. 정상 종료하면 즉시 놓는다.
const PUBLISH_LOCK_TTL_MS = 2 * 60_000

async function runPlacePublishLocked(placeId: string, dependencies: PublishRunDependencies): Promise<PublishRunResult> {

  // 게시 직전 최종 방어 — 생성·검토 단계를 어떻게 통과했든, 공개되는 문구가 업종과 맞는지 여기서 다시 본다.
  // 차단되면 RPC를 호출하지 않으므로 published_at·seo_pages.status는 그대로다.
  const guard = await checkPublishVocabulary(placeId)
  if (guard.kind === "unsupported-category") {
    return { kind: "category-blocked", category: guard.category }
  }
  if (guard.kind === "forbidden") {
    return { kind: "vocabulary-blocked", findings: guard.findings }
  }
  // 주소 전제 재확인 — 생성 뒤에 검수 주소 맵이나 DB 원문이 바뀌었으면 그 글은 지금의 주소로 검수된 글이 아니다.
  const addressGuard = await checkPublishAddress(placeId)
  if (!addressGuard.ok) {
    return { kind: "address-blocked", reason: addressGuard.reason, detail: addressGuard.detail }
  }

  const [{ createSupabasePlacePublishRepository }, { publishPlacePage }] = await Promise.all([import("./supabase-place-publish"), import("./place-publish")])

  const result = await publishPlacePage(createSupabasePlacePublishRepository(), placeId)
  if (result.kind !== "published" && result.kind !== "already-published") {
    return result.kind === "unexpected" ? { kind: "unexpected" } : { kind: "blocked" }
  }

  // DB 게시 성공 → 캐시 갱신. 성공하면 즉시 성공으로 보고하고 공개 확인은 after()에서 비동기 실행 (PR #25 구조).
  const revalidated = revalidatePublicPlacePaths(result.path)
  if (revalidated) {
    await schedulePublishVerificationSafely(result.path, dependencies.registerAfter)
  }
  return { kind: result.kind, path: result.path, revalidated }
}

export type PublishVocabularyCheck =
  | { readonly kind: "ok" }
  | { readonly kind: "forbidden"; readonly findings: readonly ForbiddenVocabularyFinding[] }
  | { readonly kind: "unsupported-category"; readonly category: string | null }

// 게시 대상 장소의 '실제 공개될 문구'를 업종 어휘 규칙으로 재검사한다.
// 모드는 장소 category에서 다시 구한다 — 저장된 generation의 content_mode와 place category가 어긋난 경우
// (업종이 바뀌었거나 다른 모드로 생성된 경우) 더 보수적인 쪽인 현재 업종 기준으로 막기 위해서다.
//
// 모드를 정할 수 없으면 '검사 통과'가 아니라 '검사 불가'다. 어떤 어휘표를 적용해야 할지 모르는 콘텐츠를
// 그대로 공개하면 이 게이트가 존재하는 이유가 사라지므로, 검사를 건너뛰지 않고 게시를 거부한다.
export async function checkPublishVocabulary(placeId: string): Promise<PublishVocabularyCheck> {
  const [{ createSupabaseServiceRoleClient }, { contentModeForCategory }, { findForbiddenModeVocabulary }] = await Promise.all([
    import("@/lib/supabase/server"),
    import("@/lib/ai/content-mode"),
    import("@/lib/ai/mode-vocabulary"),
  ])
  const client = createSupabaseServiceRoleClient()
  const { data: place } = await client.from("places").select("*").eq("id", placeId).maybeSingle()
  if (place === null) {
    // 장소가 없으면 게시 RPC가 자체적으로 거부한다 — 여기서 판정할 대상이 없다.
    return { kind: "ok" }
  }
  const mode = contentModeForCategory(place.category)
  if (mode === null) {
    return { kind: "unsupported-category", category: typeof place.category === "string" ? place.category : null }
  }
  const faq = Array.isArray(place.faq) ? place.faq : []
  const keywords = Array.isArray(place.keywords) ? place.keywords : []
  const findings = findForbiddenModeVocabulary({
    content: {
      description: textOf(place.description),
      meta_title: textOf(place.meta_title),
      meta_description: textOf(place.meta_description),
      faq: faq.map((entry) => ({ question: textOf(asRecord(entry)?.["question"]), answer: textOf(asRecord(entry)?.["answer"]) })),
      keywords: keywords.filter((keyword): keyword is string => typeof keyword === "string"),
      internal_links: [],
    },
    mode,
    placeName: place.name,
    regionTokens: [place.city, place.district],
  })
  return findings.length > 0 ? { kind: "forbidden", findings } : { kind: "ok" }
}

// 게시 대상 장소의 현재 검수 주소 판정과, 적용된 최신 생성의 주소 기록을 대조한다.
// 단건·배치·자동 게시가 모두 runPlacePublishLocked를 지나므로 여기 한 곳에서 막는다.
// 한계: 이 조회와 게시 RPC 사이에 동기화가 원문 주소를 바꾸는 경합까지 잠그지는 않는다 (RPC는 주소를 보지 않는다).
// 그 경우는 공개 어댑터의 conflict 제외와 동기화의 재검증 요청이 받는다.
export async function checkPublishAddress(placeId: string): Promise<GenerationAddressCheck> {
  const [{ createSupabaseServiceRoleClient }, { checkGenerationAddressRecord, resolveVerifiedAddress }] = await Promise.all([import("@/lib/supabase/server"), import("@/lib/domain/verified-address")])
  const client = createSupabaseServiceRoleClient()
  const { data: place, error: placeError } = await client.from("places").select("id,slug,name,address").eq("id", placeId).maybeSingle()
  if (placeError !== null) {
    return { ok: false, reason: "conflict", detail: `장소 조회 실패: ${placeError.message}` }
  }
  if (place === null) {
    // 장소가 없으면 게시 RPC가 자체적으로 거부한다.
    return { ok: true }
  }
  const resolution = resolveVerifiedAddress({ placeId: place.id, slug: place.slug, name: place.name, rawAddress: place.address })
  if (resolution.kind === "not-registered") {
    // 미등록 장소는 기존 동작 그대로 — 생성 기록을 읽지 않는다.
    // (엔트리를 지우는 변경은 코드 리뷰를 거치며, 그 장소의 글을 다시 만드는 절차와 함께 해야 한다.)
    return { ok: true }
  }
  const { data: generations, error: generationError } = await client.from("ai_generations").select("input,applied_at").eq("place_id", placeId).eq("status", "applied").order("applied_at", { ascending: false }).limit(1)
  if (generationError !== null) {
    return { ok: false, reason: "conflict", detail: `생성 기록 조회 실패: ${generationError.message}` }
  }
  const input = generations[0]?.input
  const record = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>)["address_resolution"] : undefined
  return checkGenerationAddressRecord(resolution, record)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : ""
}

// 캐시 갱신은 DB 변경과 분리해 성공 여부를 반환한다. 실패는 서버 로그에 기록되고 UI에는 cache-refresh-failed로 표시된다.
export function revalidatePublicPlacePaths(path: string | null): boolean {
  try {
    if (path?.startsWith("/places/") === true) {
      revalidatePath(path)
    }
    revalidatePath("/sitemap.xml")
    return true
  } catch (error) {
    console.error("[publish-cache] revalidation failed", { path, error: error instanceof Error ? error.message : String(error) })
    return false
  }
}

// 공개 URL 비동기 검증 예약 — 검증 예약이 실패해도 게시 성공 알림은 유지한다 (migration 미적용 등).
export async function schedulePublishVerificationSafely(path: string | null, registerAfter: (callback: () => Promise<void>) => void): Promise<void> {
  if (path?.startsWith("/places/") !== true) {
    return
  }
  try {
    const [{ schedulePostPublishVerification }, { createSupabaseVerificationRepository }, { getPublicSiteUrl }] = await Promise.all([
      import("./publish-verification"),
      import("./supabase-verification"),
      import("@/lib/site-url"),
    ])
    await schedulePostPublishVerification({
      path,
      // 검증은 실제 공개되는 도메인을 확인해야 한다 — 공개 origin 기준.
      url: `${getPublicSiteUrl()}${path}`,
      repository: createSupabaseVerificationRepository(),
      registerAfter,
    })
  } catch (error) {
    console.error("[publish-verification] failed to schedule verification", { path, error: error instanceof Error ? error.message : String(error) })
  }
}
