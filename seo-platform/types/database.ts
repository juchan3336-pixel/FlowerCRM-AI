import type {
  AiGenerationStatus,
  ChangeFrequency,
  PlaceStatus,
  SeoPageStatus,
  SeoPageType,
  SyncJobStatus,
  SyncRunStatus,
} from "@/lib/domain/constants"

export type Json = string | number | boolean | null | { readonly [key: string]: Json | undefined } | readonly Json[]

type RowWithTimestamps = {
  readonly created_at: string
  readonly updated_at: string
}

type TableDefinition<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  readonly Row: Row
  readonly Insert: Insert
  readonly Update: Update
  readonly Relationships: []
}

type ViewDefinition<Row> = {
  readonly Row: Row
  readonly Relationships: []
}

export type PlaceRow = RowWithTimestamps & {
  readonly id: string
  readonly source: "google_sheets"
  readonly source_sheet_name: string | null
  readonly source_row_number: number | null
  readonly source_key: string
  readonly name: string
  readonly normalized_name: string
  readonly category: string
  readonly detail_category: string | null
  readonly region: string | null
  readonly city: string | null
  readonly district: string | null
  readonly address: string | null
  readonly normalized_address: string | null
  readonly phone: string | null
  readonly normalized_phone: string | null
  readonly homepage: string | null
  readonly email: string | null
  readonly source_url: string | null
  readonly collected_at: string | null
  readonly grade: string | null
  readonly sales_status: string | null
  readonly memo: string | null
  readonly lat: number | null
  readonly lng: number | null
  readonly slug: string | null
  readonly status: PlaceStatus
  readonly order_url: string | null
  readonly description: string | null
  readonly meta_title: string | null
  readonly meta_description: string | null
  readonly faq: Json
  readonly keywords: Json
  readonly internal_links: Json
  readonly imported_payload: Json
  readonly synced_at: string | null
  // 공식 검증 상태 (migration 202607220002) — sync SOURCE_FIELD_KEYS 밖의 운영 전용 컬럼, 기존 행은 null.
  // migration 적용 전 코드 호환을 위해 optional로 선언한다 (조회는 select("*") + null 정규화).
  readonly official_verification_status?: PlaceVerificationStatus | null
  readonly verified_at?: string | null
  readonly verified_by?: string | null
  readonly verification_source_urls?: Json | null
  readonly exclusion_reason?: string | null
}

export type PlaceVerificationStatus = "verified" | "excluded"

export type BatchRunKind = "generate" | "publish"
export type BatchRunStatus = "running" | "completed" | "cancelled" | "failed"
export type BatchItemStatus =
  | "queued"
  | "processing"
  | "ready"
  | "warn_ready"
  | "needs_review"
  | "failed"
  | "skipped"
  | "interrupted"
  | "published"
  | "publish_failed"
export type BatchItemStep = "generating" | "checking" | "applying" | "publishing" | "verifying"

export type BatchRunRow = RowWithTimestamps & {
  readonly id: string
  readonly kind: BatchRunKind
  readonly status: BatchRunStatus
  readonly created_by: string | null
  readonly settings: Json
  readonly totals: Json
  readonly started_at: string
  readonly finished_at: string | null
}

export type BatchRunItemRow = RowWithTimestamps & {
  readonly id: string
  readonly batch_id: string
  readonly place_id: string
  readonly sequence: number
  readonly status: BatchItemStatus
  readonly current_step: BatchItemStep | null
  readonly input_snapshot: Json | null
  readonly idempotency_key: string
  readonly generation_id: string | null
  readonly retry_generation_id: string | null
  readonly quality_status: "pass" | "warn" | "fail" | null
  readonly quality_issues: Json | null
  readonly tokens_input: number | null
  readonly tokens_output: number | null
  readonly cost_usd: number | null
  readonly approval_snapshot: Json | null
  readonly publish_result: string | null
  readonly verification_status: SeoPageVerificationStatus | null
  readonly skip_reason: string | null
  readonly last_error_code: string | null
  readonly last_error_message: string | null
  readonly started_at: string | null
  readonly finished_at: string | null
}

export type BatchRunEventType =
  | "run_created"
  | "run_started"
  | "item_claimed"
  | "item_step_changed"
  | "item_result_recorded"
  | "items_skipped"
  | "item_interrupted_marked"
  | "run_cancel_requested"
  | "run_finished"
  | "verification_updated"

export type BatchRunEventRow = {
  readonly id: string
  readonly batch_id: string
  readonly item_id: string | null
  readonly event_type: BatchRunEventType
  readonly from_status: string | null
  readonly to_status: string | null
  readonly step: string | null
  readonly actor: string | null
  readonly detail: Json
  readonly idempotency_key: string
  readonly created_at: string
}

// 승인 Batch 자동 생성 v1 — 승인 상태 머신 (migration 202607240001)
export type BatchApprovalStatus = "approved" | "queued" | "running" | "completed" | "failed" | "expired" | "cancelled"

export type BatchApprovalRow = RowWithTimestamps & {
  readonly id: string
  readonly status: BatchApprovalStatus
  readonly approved_by: string
  readonly approved_at: string
  readonly approval_expires_at: string
  readonly approved_place_ids: readonly string[]
  readonly approved_max_cost_usd: number
  readonly approval_snapshot: Json
  // Activation token 원문은 저장하지 않는다 — SHA-256 해시만.
  readonly execution_token_hash: string
  readonly activation_consumed_at: string | null
  readonly execution_tick: number
  readonly batch_run_id: string | null
  readonly last_tick_at: string | null
  readonly last_error_code: string | null
  readonly last_error_message: string | null
  readonly preview_deployment_sha: string | null
}

export type SeoPageVerificationStatus = "pending" | "verified" | "delayed" | "failed"

export type SeoPageRow = RowWithTimestamps & {
  readonly id: string
  readonly place_id: string | null
  readonly page_type: SeoPageType
  readonly slug: string
  readonly path: string
  readonly title: string | null
  readonly description: string | null
  readonly canonical_url: string | null
  readonly status: SeoPageStatus
  readonly priority: number
  readonly change_frequency: ChangeFrequency
  readonly last_modified_at: string | null
  readonly published_at: string | null
  // 게시 후 공개 URL 비동기 검증 상태 — migration 202607220001, 기존 행은 null.
  readonly verification_status: SeoPageVerificationStatus | null
  readonly verification_checked_at: string | null
  readonly verification_attempts: number | null
  readonly last_http_status: number | null
}

export type PublicPlacePageRow = {
  readonly seo_page_id: string
  readonly page_type: SeoPageType
  readonly page_slug: string
  readonly path: string
  readonly title: string | null
  readonly page_description: string | null
  readonly canonical_url: string | null
  readonly priority: number
  readonly change_frequency: ChangeFrequency
  readonly last_modified_at: string | null
  readonly place_id: string | null
  readonly name: string | null
  readonly category: string | null
  readonly detail_category: string | null
  readonly region: string | null
  readonly city: string | null
  readonly district: string | null
  readonly address: string | null
  readonly homepage: string | null
  readonly place_slug: string | null
  readonly order_url: string | null
  readonly place_description: string | null
  readonly meta_title: string | null
  readonly meta_description: string | null
  readonly faq: Json | null
  readonly keywords: Json | null
  readonly internal_links: Json | null
}

export type AiGenerationTableRow = {
  readonly id: string
  readonly place_id: string
  readonly generation_type: string
  readonly prompt: string | null
  readonly input: Json | null
  readonly output: Json | null
  readonly model: string | null
  readonly status: AiGenerationStatus
  readonly applied_at: string | null
  readonly created_by: string | null
  readonly created_at: string
}

export type SettingTableRow = {
  readonly key: string
  readonly value: Json
  readonly updated_at: string
}

export type SyncRunTableRow = {
  readonly id: string
  readonly source: "google_sheets"
  readonly started_at: string
  readonly finished_at: string | null
  readonly status: SyncRunStatus
  readonly total_rows: number
  readonly inserted_count: number
  readonly updated_count: number
  readonly skipped_count: number
  readonly failed_count: number
  readonly message: string | null
  // 자동 연속 처리 job 연결 (수동 1회 실행·도입 이전 행은 null).
  readonly sync_job_id?: string | null
  readonly batch_index?: number | null
}

export type SyncJobTableRow = {
  readonly id: string
  readonly status: SyncJobStatus
  readonly source_sheet_name: string
  readonly created_by: string | null
  readonly batch_size: number
  readonly start_row: number
  readonly current_row: number
  readonly target_last_row: number
  readonly latest_sheet_row: number
  readonly batch_index: number
  readonly processed_count: number
  readonly inserted_count: number
  readonly updated_count: number
  readonly skipped_count: number
  readonly failed_count: number
  readonly remaining_count: number
  readonly next_tick_token_hash: string | null
  readonly started_at: string
  readonly last_tick_at: string | null
  readonly finished_at: string | null
  readonly last_error_code: string | null
  readonly last_error_message: string | null
  readonly created_at: string
  readonly updated_at: string
}

export type SyncErrorTableRow = {
  readonly id: string
  readonly sync_run_id: string | null
  readonly source_sheet_name: string | null
  readonly source_row_number: number | null
  readonly source_payload: Json | null
  readonly error_code: string | null
  readonly error_message: string | null
  readonly created_at: string
}

export type Database = {
  readonly public: {
    readonly Tables: {
      readonly places: TableDefinition<PlaceRow>
      readonly seo_pages: TableDefinition<SeoPageRow>
      readonly ai_generations: TableDefinition<AiGenerationTableRow, Record<string, Json | undefined>, Record<string, Json | undefined>>
      readonly sync_runs: TableDefinition<SyncRunTableRow, Record<string, Json | undefined>, Record<string, Json | undefined>>
      readonly sync_jobs: TableDefinition<SyncJobTableRow, Record<string, Json | undefined>, Record<string, Json | undefined>>
      readonly sync_errors: TableDefinition<SyncErrorTableRow, Record<string, Json | undefined>, Record<string, Json | undefined>>
      readonly settings: TableDefinition<SettingTableRow, Record<string, Json | undefined>, Record<string, Json | undefined>>
      readonly batch_runs: TableDefinition<BatchRunRow>
      readonly batch_run_items: TableDefinition<BatchRunItemRow>
      readonly batch_run_events: TableDefinition<BatchRunEventRow>
      readonly batch_approvals: TableDefinition<BatchApprovalRow>
    }
    readonly Views: {
      readonly published_place_pages: ViewDefinition<PublicPlacePageRow>
    }
    readonly Functions: {
      readonly publish_place_page: { readonly Args: { readonly target_place_id: string }; readonly Returns: Json }
      readonly archive_place_page: { readonly Args: { readonly target_place_id: string }; readonly Returns: Json }
      readonly restore_place_page: { readonly Args: { readonly target_place_id: string }; readonly Returns: Json }
    }
    readonly Enums: Record<string, never>
    readonly CompositeTypes: Record<string, never>
  }
}
