export const PLACE_STATUSES = ["draft", "published", "noindex", "archived"] as const
export type PlaceStatus = (typeof PLACE_STATUSES)[number]

export const SEO_PAGE_TYPES = ["area", "funeral", "hospital", "product", "place"] as const
export type SeoPageType = (typeof SEO_PAGE_TYPES)[number]

export const SEO_PAGE_STATUSES = ["draft", "ready", "published", "archived"] as const
export type SeoPageStatus = (typeof SEO_PAGE_STATUSES)[number]

export const AI_GENERATION_STATUSES = ["preview", "applied", "rejected", "failed"] as const
export type AiGenerationStatus = (typeof AI_GENERATION_STATUSES)[number]

export const SYNC_RUN_STATUSES = ["running", "completed", "failed", "cancelled"] as const
export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number]

// 자동 연속 동기화 job — 버튼 1클릭 = job 1개, job 1개 = 50건 배치 N개.
// partial_completed는 상한 도달, interrupted는 chain 유실 — 둘 다 재개 가능한 정상 종료 상태다.
export const SYNC_JOB_STATUSES = ["queued", "running", "completed", "partial_completed", "failed", "cancelled", "interrupted"] as const
export type SyncJobStatus = (typeof SYNC_JOB_STATUSES)[number]

// 세션이 전역 상한·취소로 멈춘 사유. migration의 session_stop_reason CHECK와 문자열이 정확히 같아야 한다
// (양쪽을 따로 적으면 어긋난다 — 이 배열이 유일한 출처다).
export const SYNC_SESSION_STOP_REASONS = ["cancelled", "session-job-limit", "session-row-limit", "session-error-limit", "session-time-limit"] as const
export type SyncSessionStopReason = (typeof SYNC_SESSION_STOP_REASONS)[number]

export const CHANGE_FREQUENCIES = [
  "always",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "never",
] as const
export type ChangeFrequency = (typeof CHANGE_FREQUENCIES)[number]

export const SHEET_COLUMNS = [
  "회사명",
  "업종",
  "세부업종",
  "지역",
  "주소",
  "대표전화",
  "홈페이지",
  "이메일",
  "출처URL",
  "수집일",
  "등급",
  "영업상태",
  "메모",
] as const
export type SheetColumn = (typeof SHEET_COLUMNS)[number]

export const SOURCE_OWNED_PLACE_COLUMNS = [
  "source",
  "source_sheet_name",
  "source_row_number",
  "source_key",
  "name",
  "normalized_name",
  "category",
  "detail_category",
  "region",
  "city",
  "district",
  "address",
  "normalized_address",
  "phone",
  "normalized_phone",
  "homepage",
  "email",
  "source_url",
  "collected_at",
  "grade",
  "sales_status",
  "memo",
  "imported_payload",
  "synced_at",
] as const

export const SEO_DERIVED_PLACE_COLUMNS = [
  "slug",
  "status",
  "order_url",
  "description",
  "meta_title",
  "meta_description",
  "faq",
  "keywords",
  "internal_links",
] as const
