// 단일 장소 게시 코어 — 관리자 단건 액션과 Batch 오케스트레이션이 공유한다.
// publishPlacePageAction의 본문(RPC → revalidate → 비동기 검증 예약)을 동작 무변경으로 추출한 것 (PR-1 batch 준비).
// notice 매핑·redirect는 호출부(actions.ts) 책임. 게시 RPC의 DB 상태 변경 순서는 그대로 유지된다.
import { revalidatePath } from "next/cache"

import type { ForbiddenVocabularyFinding } from "@/lib/ai/mode-vocabulary"

export type PublishRunResult =
  | { readonly kind: "published" | "already-published"; readonly path: string | null; readonly revalidated: boolean }
  | { readonly kind: "blocked" }
  // 업종에 맞지 않는 표현이 남아 있어 게시를 거부했다 — DB는 건드리지 않는다.
  | { readonly kind: "vocabulary-blocked"; readonly findings: readonly ForbiddenVocabularyFinding[] }
  // 업종을 콘텐츠 모드로 판정할 수 없어 어휘 검사 자체가 불가능하다 — 검사를 건너뛰는 대신 게시를 거부한다.
  | { readonly kind: "category-blocked"; readonly category: string | null }
  | { readonly kind: "unexpected" }

export type PublishRunDependencies = {
  // next/server의 after — 응답 이후 실행할 비동기 공개 검증 콜백 등록 (redirect throw 이전에 등록 완료)
  readonly registerAfter: (callback: () => Promise<void>) => void
}

export async function runPlacePublish(placeId: string, dependencies: PublishRunDependencies): Promise<PublishRunResult> {
  // 게시 직전 최종 방어 — 생성·검토 단계를 어떻게 통과했든, 공개되는 문구가 업종과 맞는지 여기서 다시 본다.
  // 차단되면 RPC를 호출하지 않으므로 published_at·seo_pages.status는 그대로다.
  const guard = await checkPublishVocabulary(placeId)
  if (guard.kind === "unsupported-category") {
    return { kind: "category-blocked", category: guard.category }
  }
  if (guard.kind === "forbidden") {
    return { kind: "vocabulary-blocked", findings: guard.findings }
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
    const [{ schedulePostPublishVerification }, { createSupabaseVerificationRepository }, { getSiteUrl }] = await Promise.all([
      import("./publish-verification"),
      import("./supabase-verification"),
      import("@/lib/site-url"),
    ])
    await schedulePostPublishVerification({
      path,
      url: `${getSiteUrl()}${path}`,
      repository: createSupabaseVerificationRepository(),
      registerAfter,
    })
  } catch (error) {
    console.error("[publish-verification] failed to schedule verification", { path, error: error instanceof Error ? error.message : String(error) })
  }
}
