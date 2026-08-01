// Batch 생성 대상 하드 조건 판정 — 시스템이 기계 판정 가능한 조건만 다룬다.
// 공식 검증(명칭·주소·전화·화환 정책)은 운영 절차의 결과를 places.official_verification_status로 기록하고,
// 배치는 'verified'만 허용한다 (109 fixture·후보 제외 장소는 verified가 아니므로 자연 차단 + excluded 명시 차단).
import type { PlaceRow } from "@/types/database"

export type BatchCandidateInput = {
  readonly place: Pick<PlaceRow, "id" | "status" | "slug" | "official_verification_status" | "exclusion_reason" | "category">
  readonly generationCount: number
  readonly seoPagePathExists: boolean
  readonly slugDuplicateCount: number
}

// 생성 파이프라인(프롬프트·제목 패턴·FAQ 폴백)이 근조화환 전용이라, 장례 수요가 없는 업종에 돌리면
// 호텔·공장 페이지에 "빈소"·"장례식장" 문구가 박힌다 (2026-08-01 실측: 비장례 4곳 전부 오생성).
// 업종별 어휘 분기가 들어오기 전까지는 장례식장·병원만 허용한다.
export const BATCH_SUPPORTED_CATEGORIES: readonly string[] = ["funeral", "hospital"]

// category는 시트에서 온 값이라 비어 있을 수 있다 — 모르는 업종은 통과시키지 않는다.
function isSupportedCategory(category: string | null | undefined): boolean {
  return typeof category === "string" && BATCH_SUPPORTED_CATEGORIES.includes(category.trim().toLowerCase())
}

export type BatchCandidateDecision = { readonly eligible: true } | { readonly eligible: false; readonly reason: BatchIneligibleReason }

export type BatchIneligibleReason =
  | "not-draft"
  | "has-generation"
  | "not-verified"
  | "excluded"
  | "category-unsupported"
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
  if (!isSupportedCategory(input.place.category)) {
    return { eligible: false, reason: "category-unsupported" }
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
  "category-unsupported": "근조화환 안내 대상 업종이 아님 (장례식장·병원만 지원)",
  "missing-slug": "slug 없음",
  "slug-conflict": "slug 중복",
  "seo-page-exists": "SEO 페이지가 이미 존재",
}
