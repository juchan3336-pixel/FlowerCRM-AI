import type { Json } from "@/types/database"

export const ADMIN_SETTING_KEYS = [
  "site_url",
  "brand_name",
  "default_order_url",
  "default_og_image",
  "google_site_verification",
  "naver_site_verification",
  "ai_provider_label",
  "ai_model_label",
  "public_address_policy",
  "public_phone_policy",
  "auto_publish",
] as const

export type AdminSettingKey = (typeof ADMIN_SETTING_KEYS)[number]

export type AdminSettingsSource = "fixture" | "supabase"

export type SettingRow = {
  readonly key: string
  readonly value: Json
  readonly updatedAt: string
}

export interface AdminSettingsRepository {
  listSettings(): Promise<readonly SettingRow[]>
}

export type SettingsField = {
  readonly key: AdminSettingKey
  readonly label: string
  readonly value: string
  readonly help: string
}

export type SettingsSection = {
  readonly title: string
  readonly description: string
  readonly fields: readonly SettingsField[]
}

export type AdminSettingsLoadResult = {
  readonly source: AdminSettingsSource
  readonly sections: readonly SettingsSection[]
}
