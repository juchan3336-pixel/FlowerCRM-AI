// Batch 생성 대상 하드 조건 판정 — 시스템이 기계 판정 가능한 조건만 다룬다.
// 공식 검증(명칭·주소·전화·화환 정책)은 운영 절차의 결과를 places.official_verification_status로 기록하고,
// 배치는 'verified'만 허용한다 (109 fixture·후보 제외 장소는 verified가 아니므로 자연 차단 + excluded 명시 차단).
//
// 업종 판정(PR C): 고정 allowlist(BATCH_SUPPORTED_CATEGORIES)를 제거하고 중앙 resolver
// contentModeForCategory 하나만 쓴다. 생성 계층(PR #59)·품질 계층(PR #60)·게시 방어(PR #60)·
// 관리자 readiness(PR #64)가 모두 같은 매핑을 보므로, 후보 판정만 다른 목록을 들고 있으면
// "후보는 됐는데 생성이 거부되는" 어긋남이 생긴다. 비장례 4곳(라마다·아이스퀘어·KCC·LS)
// celebration/corporate-celebration 실측 PASS(2026-08-04)가 이 확장의 전제다.
//
// 'hospital'은 여전히 매핑에 없다 — 병원 본체와 병원 장례식장은 다른 장소다. 시트가 이미 구분하고
// 있어서 병원 장례식장은 전부 funeral로 들어오고, hospital을 열면 병원 본체가 통째로 후보가 된다.
import { contentModeForCategory, type ContentMode } from "@/lib/ai/content-mode"
import { isLodgingFacilityName, isMemorialFacilityName } from "@/lib/domain/facility-type"
import type { Json, PlaceRow } from "@/types/database"

export type BatchCandidateInput = {
  // name은 시설 유형(빈소 운영 여부) 판정용 — 과거 호출부 호환을 위해 optional이며, 조회 계층은 항상 채운다.
  readonly place: Pick<PlaceRow, "id" | "status" | "slug" | "official_verification_status" | "exclusion_reason" | "category"> & Partial<Pick<PlaceRow, "name">>
  readonly generationCount: number
  readonly seoPagePathExists: boolean
  readonly slugDuplicateCount: number
  // 공식 검증 출처 URL (places.verification_source_urls) — 제공 시 빈 값은 후보에서 제외한다.
  // 과거 호출부·테스트 호환을 위해 optional이며, 실제 조회 계층은 항상 채운다.
  readonly verificationSourceUrls?: Json | null
  // 진행 중(queued/processing/interrupted) Batch item 수 — 같은 장소 이중 처리 차단.
  readonly activeBatchItemCount?: number
  // 진행 중(approved/queued/running) 승인에 포함된 횟수 — 승인 대기 중 재후보 차단.
  readonly activeApprovalCount?: number
}

export type BatchCandidateDecision =
  | { readonly eligible: true; readonly mode: ContentMode }
  | { readonly eligible: false; readonly reason: BatchIneligibleReason; readonly mode: ContentMode | null }

export type BatchIneligibleReason =
  | "not-draft"
  | "has-generation"
  | "active-batch"
  | "active-approval"
  | "not-verified"
  | "verification-source-missing"
  | "excluded"
  | "memorial-facility"
  | "lodging-facility"
  | "category-unsupported"
  | "missing-slug"
  | "slug-conflict"
  | "seo-page-exists"

// 진행 중으로 보는 상태 — 종료 상태(ready/failed/published 등)는 has-generation·seo-page 조건이 대신 잡는다.
export const ACTIVE_BATCH_ITEM_STATUSES: readonly string[] = ["queued", "processing", "interrupted"]
export const ACTIVE_APPROVAL_STATUSES: readonly string[] = ["approved", "queued", "running"]

// 판정 순서는 기존 funeral 순서를 그대로 유지하고(회귀 금지), 새 조건은 의미가 가장 가까운 자리에
// 끼워 넣는다: 처리 중 신호(active-*)는 has-generation 뒤, 출처 URL은 not-verified 뒤.
export function decideBatchCandidate(input: BatchCandidateInput): BatchCandidateDecision {
  const mode = contentModeForCategory(input.place.category)
  if (input.place.official_verification_status === "excluded") {
    return { eligible: false, reason: "excluded", mode }
  }
  // 빈소 없는 안치·봉안 시설은 근조 콘텐츠 대상이 아니다 — DB의 excluded 표시와 별개로 명칭으로도 막는다
  // (2026-08-06: 필터 배포 전에 verified된 추모시설 7곳이 장례식장 문맥으로 공개된 사고).
  if (mode === "condolence" && typeof input.place.name === "string" && isMemorialFacilityName(input.place.name)) {
    return { eligible: false, reason: "memorial-facility", mode }
  }
  // 순수 숙박 시설(펜션·모텔 등)은 축하화환 문맥이 성립하지 않는다 — 추모시설과 같은 명칭 기준 이중 방어
  // (2026-08-07: 시트 category "숙박/행사" 통짜 매핑으로 펜션 749곳이 celebration 후보에 혼입).
  if (mode === "celebration" && typeof input.place.name === "string" && isLodgingFacilityName(input.place.name)) {
    return { eligible: false, reason: "lodging-facility", mode }
  }
  if (input.place.status !== "draft") {
    return { eligible: false, reason: "not-draft", mode }
  }
  if (input.generationCount > 0) {
    return { eligible: false, reason: "has-generation", mode }
  }
  if ((input.activeBatchItemCount ?? 0) > 0) {
    return { eligible: false, reason: "active-batch", mode }
  }
  if ((input.activeApprovalCount ?? 0) > 0) {
    return { eligible: false, reason: "active-approval", mode }
  }
  if (input.place.official_verification_status !== "verified") {
    return { eligible: false, reason: "not-verified", mode }
  }
  if (input.verificationSourceUrls !== undefined && !hasVerificationSourceUrl(input.verificationSourceUrls)) {
    return { eligible: false, reason: "verification-source-missing", mode }
  }
  if (mode === null) {
    return { eligible: false, reason: "category-unsupported", mode: null }
  }
  const slug = input.place.slug
  if (slug === null || slug.trim().length === 0) {
    return { eligible: false, reason: "missing-slug", mode }
  }
  if (input.slugDuplicateCount > 0) {
    return { eligible: false, reason: "slug-conflict", mode }
  }
  if (input.seoPagePathExists) {
    return { eligible: false, reason: "seo-page-exists", mode }
  }
  return { eligible: true, mode }
}

// verification_source_urls는 Json 컬럼 — 문자열 하나든 배열이든 비어 있지 않은 URL이 하나는 있어야 한다.
export function hasVerificationSourceUrl(value: Json | null): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0
  }
  if (!Array.isArray(value)) {
    return false
  }
  return value.some((entry) => typeof entry === "string" && entry.trim().length > 0)
}

export const BATCH_INELIGIBLE_LABELS: Readonly<Record<BatchIneligibleReason, string>> = {
  "not-draft": "draft 상태가 아님 (published/archived 제외)",
  "has-generation": "기존 AI 생성 이력이 있음",
  "active-batch": "진행 중인 Batch item에 이미 포함됨",
  "active-approval": "진행 중인 승인에 이미 포함됨",
  "not-verified": "공식 검증 미완료 (official_verification_status=verified 필요)",
  "verification-source-missing": "공식 검증 출처 URL 없음",
  excluded: "후보 제외 장소 (화환 제한 등)",
  "memorial-facility": "빈소 없는 추모·봉안 시설 (근조화환 대상 아님)",
  "lodging-facility": "행사장 아닌 순수 숙박 시설 (축하화환 대상 아님)",
  "category-unsupported": "콘텐츠 모드로 판정할 수 없는 업종 (장례식장·호텔/행사장·기업/사업장만 지원)",
  "missing-slug": "slug 없음",
  "slug-conflict": "slug 중복",
  "seo-page-exists": "SEO 페이지가 이미 존재",
}

// 화면 표시용 모드 라벨 — 후보 화면·필터가 함께 쓴다.
export const CONTENT_MODE_LABELS: Readonly<Record<ContentMode, string>> = {
  condolence: "근조 (장례식장)",
  celebration: "축하 (호텔·행사장)",
  "corporate-celebration": "기업 축하 (사업장)",
}
