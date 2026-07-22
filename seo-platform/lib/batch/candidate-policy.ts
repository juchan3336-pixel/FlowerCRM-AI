// Batch 생성 대상 하드 조건 판정 — 시스템이 기계 판정 가능한 조건만 다룬다.
// 공식 검증(명칭·주소·전화·화환 정책)은 운영 절차의 결과를 places.official_verification_status로 기록하고,
// 배치는 'verified'만 허용한다 (109 fixture·후보 제외 장소는 verified가 아니므로 자연 차단 + excluded 명시 차단).
import type { PlaceRow } from "@/types/database"

export type BatchCandidateInput = {
  readonly place: Pick<PlaceRow, "id" | "status" | "slug" | "official_verification_status" | "exclusion_reason">
  readonly generationCount: number
  readonly seoPagePathExists: boolean
  readonly slugDuplicateCount: number
}

export type BatchCandidateDecision = { readonly eligible: true } | { readonly eligible: false; readonly reason: BatchIneligibleReason }

export type BatchIneligibleReason =
  | "not-draft"
  | "has-generation"
  | "not-verified"
  | "excluded"
  | "missing-slug"
  | "slug-conflict"
  | "seo-page-exists"

export function decideBatchCandidate(input: BatchCandidateInput): BatchCandidateDecision {
  if (input.place.official_verification_status === "excluded") {
    return { eligible: false, reason: "excluded" }
  }
  if (input.place.status !== "draft") {
    return { eligible: false, reason: "not-draft" }
  }
  if (input.generationCount > 0) {
    return { eligible: false, reason: "has-generation" }
  }
  if (input.place.official_verification_status !== "verified") {
    return { eligible: false, reason: "not-verified" }
  }
  const slug = input.place.slug
  if (slug === null || slug.trim().length === 0) {
    return { eligible: false, reason: "missing-slug" }
  }
  if (input.slugDuplicateCount > 0) {
    return { eligible: false, reason: "slug-conflict" }
  }
  if (input.seoPagePathExists) {
    return { eligible: false, reason: "seo-page-exists" }
  }
  return { eligible: true }
}

export const BATCH_INELIGIBLE_LABELS: Readonly<Record<BatchIneligibleReason, string>> = {
  "not-draft": "draft 상태가 아님 (published/archived 제외)",
  "has-generation": "기존 AI 생성 이력이 있음",
  "not-verified": "공식 검증 미완료 (official_verification_status=verified 필요)",
  excluded: "후보 제외 장소 (화환 제한 등)",
  "missing-slug": "slug 없음",
  "slug-conflict": "slug 중복",
  "seo-page-exists": "SEO 페이지가 이미 존재",
}
