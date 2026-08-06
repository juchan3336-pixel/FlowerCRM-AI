// Batch 게시 대상 하드 조건 판정 — seo_pages.status=ready인 draft 장소만 허용한다.
// 109 fixture처럼 generation 없이 ready인 페이지는 no-generation으로 자연 차단된다.
// 재게시·게시 취소·보관·복원은 이 배치의 범위가 아니다 (published/archived 장소는 후보에서 제외).
import { contentModeForCategory } from "@/lib/ai/content-mode"
import { isMemorialFacilityName } from "@/lib/domain/facility-type"
import type { PlaceRow, SeoPageRow } from "@/types/database"

export type PublishCandidateInput = {
  // name·category는 시설 유형 최종 방어용 — 게시 직전에도 빈소 없는 추모 시설을 막는다.
  readonly place: Pick<PlaceRow, "id" | "status" | "official_verification_status"> & Partial<Pick<PlaceRow, "name" | "category">>
  readonly seoPage: Pick<SeoPageRow, "id" | "status" | "path">
  // 적용된 최신 generation id — 승인 스냅샷의 고정 대상. 없으면 게시 부적격.
  readonly latestGenerationId: string | null
}

export type PublishCandidateDecision = { readonly eligible: true } | { readonly eligible: false; readonly reason: PublishIneligibleReason }

export type PublishIneligibleReason = "excluded" | "memorial-facility" | "not-draft" | "seo-not-ready" | "no-generation" | "missing-path"

export function decidePublishCandidate(input: PublishCandidateInput): PublishCandidateDecision {
  if (input.place.official_verification_status === "excluded") {
    return { eligible: false, reason: "excluded" }
  }
  // 자동 게시도 이 판정을 지난다 — 승인 단계를 어떻게 통과했든 빈소 없는 시설은 공개되지 않는다.
  if (
    typeof input.place.name === "string" &&
    contentModeForCategory(input.place.category ?? null) === "condolence" &&
    isMemorialFacilityName(input.place.name)
  ) {
    return { eligible: false, reason: "memorial-facility" }
  }
  if (input.place.status !== "draft") {
    return { eligible: false, reason: "not-draft" }
  }
  if (input.seoPage.status !== "ready") {
    return { eligible: false, reason: "seo-not-ready" }
  }
  if (input.latestGenerationId === null) {
    return { eligible: false, reason: "no-generation" }
  }
  if (!input.seoPage.path.startsWith("/places/")) {
    return { eligible: false, reason: "missing-path" }
  }
  return { eligible: true }
}

export const PUBLISH_INELIGIBLE_LABELS: Readonly<Record<PublishIneligibleReason, string>> = {
  excluded: "후보 제외 장소 (화환 제한 등)",
  "memorial-facility": "빈소 없는 추모·봉안 시설 (근조화환 대상 아님)",
  "not-draft": "draft 상태가 아님 (이미 게시·보관된 장소 제외)",
  "seo-not-ready": "SEO 페이지가 ready 상태가 아님",
  "no-generation": "적용된 AI 생성 이력이 없음 (fixture 등)",
  "missing-path": "공개 경로가 /places/ 형식이 아님",
}

export type PublishBatchPlan =
  | { readonly kind: "ok"; readonly placeIds: readonly string[] }
  | { readonly kind: "invalid"; readonly reason: "empty" | "too-many" | "duplicate" | "publish-approval-required" | "ineligible"; readonly detail?: string }

export function planPublishBatchStart(input: Readonly<{
  placeIds: readonly string[]
  decisions: ReadonlyMap<string, PublishCandidateDecision>
  publishApproved: boolean
  maxItems: number
}>): PublishBatchPlan {
  const unique = [...new Set(input.placeIds)]
  if (unique.length !== input.placeIds.length) {
    return { kind: "invalid", reason: "duplicate" }
  }
  if (unique.length === 0) {
    return { kind: "invalid", reason: "empty" }
  }
  if (unique.length > input.maxItems) {
    return { kind: "invalid", reason: "too-many" }
  }
  if (!input.publishApproved) {
    return { kind: "invalid", reason: "publish-approval-required" }
  }
  for (const placeId of unique) {
    const decision = input.decisions.get(placeId)
    if (!decision?.eligible) {
      return { kind: "invalid", reason: "ineligible", detail: decision === undefined ? placeId : `${placeId}:${decision.reason}` }
    }
  }
  return { kind: "ok", placeIds: unique }
}
