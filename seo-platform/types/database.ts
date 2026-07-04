import type {
  AiGenerationStatus,
  ChangeFrequency,
  PlaceStatus,
  SeoPageStatus,
  SeoPageType,
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
}

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
      readonly ai_generations: TableDefinition<{ readonly status: AiGenerationStatus }, Record<string, Json | undefined>, Record<string, Json | undefined>>
      readonly sync_runs: TableDefinition<SyncRunTableRow, Record<string, Json | undefined>, Record<string, Json | undefined>>
      readonly sync_errors: TableDefinition<SyncErrorTableRow, Record<string, Json | undefined>, Record<string, Json | undefined>>
      readonly settings: TableDefinition<SettingTableRow, Record<string, Json | undefined>, Record<string, Json | undefined>>
    }
    readonly Views: {
      readonly published_place_pages: ViewDefinition<PublicPlacePageRow>
    }
    readonly Functions: Record<string, never>
    readonly Enums: Record<string, never>
    readonly CompositeTypes: Record<string, never>
  }
}
