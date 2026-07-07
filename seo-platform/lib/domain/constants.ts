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
