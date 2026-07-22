// 단일 장소 게시 코어 — 관리자 단건 액션과 Batch 오케스트레이션이 공유한다.
// publishPlacePageAction의 본문(RPC → revalidate → 비동기 검증 예약)을 동작 무변경으로 추출한 것 (PR-1 batch 준비).
// notice 매핑·redirect는 호출부(actions.ts) 책임. 게시 RPC의 DB 상태 변경 순서는 그대로 유지된다.
import { revalidatePath } from "next/cache"

export type PublishRunResult =
  | { readonly kind: "published" | "already-published"; readonly path: string | null; readonly revalidated: boolean }
  | { readonly kind: "blocked" }
  | { readonly kind: "unexpected" }

export type PublishRunDependencies = {
  // next/server의 after — 응답 이후 실행할 비동기 공개 검증 콜백 등록 (redirect throw 이전에 등록 완료)
  readonly registerAfter: (callback: () => Promise<void>) => void
}

export async function runPlacePublish(placeId: string, dependencies: PublishRunDependencies): Promise<PublishRunResult> {
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
