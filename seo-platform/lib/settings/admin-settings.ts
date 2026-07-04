import type { AdminSettingKey, AdminSettingsLoadResult, AdminSettingsRepository, SettingRow, SettingsSection } from "./types"
import type { Json } from "@/types/database"

type SettingsFieldDefinition = {
  readonly key: AdminSettingKey
  readonly label: string
  readonly fallbackValue: string
  readonly help: string
}

type SettingsSectionDefinition = {
  readonly title: string
  readonly description: string
  readonly fields: readonly SettingsFieldDefinition[]
}

const SETTINGS_SECTION_DEFINITIONS = [
  {
    title: "Site identity",
    description: "Values are read from the Supabase settings table when server credentials are configured; otherwise local defaults render safely.",
    fields: [
      { key: "site_url", label: "Site URL", fallbackValue: "https://flowers.example.test", help: "Canonical origin used for sitemap and metadata previews." },
      { key: "brand_name", label: "Brand Name", fallbackValue: "전국팔도꽃배달", help: "Default brand text for title templates and OpenGraph fallback copy." },
      { key: "default_order_url", label: "Default Order URL", fallbackValue: "https://flowers.example.test/order", help: "Fallback CTA destination when a place row has no order URL." },
      { key: "default_og_image", label: "Default OG Image", fallbackValue: "/og/default-flower-crm.png", help: "Shared preview image path for pages without a generated image." },
    ],
  },
  {
    title: "Search verification",
    description: "Verification strings are public metadata values, not secrets.",
    fields: [
      { key: "google_site_verification", label: "Google verification code", fallbackValue: "google-site-verification=fixture-placeholder", help: "Rendered later as a Google site verification meta value." },
      { key: "naver_site_verification", label: "Naver verification code", fallbackValue: "naver-site-verification=fixture-placeholder", help: "Rendered later as a Naver site verification meta value." },
    ],
  },
  {
    title: "AI defaults",
    description: "Provider and model controls are visible for planning but do not call an AI service in this slice.",
    fields: [
      { key: "ai_provider_label", label: "AI Provider", fallbackValue: "OpenAI placeholder", help: "Displayed as a safe label only; no provider credential is stored here." },
      { key: "ai_model_label", label: "AI Model", fallbackValue: "gpt-4.1-mini placeholder", help: "Preview model label for future generation settings." },
    ],
  },
  {
    title: "Public data policy",
    description: "Policy values document what public SEO pages may render.",
    fields: [
      { key: "public_address_policy", label: "Public address policy", fallbackValue: "Show city and district only", help: "Keeps precise street addresses out of public placeholders." },
      { key: "public_phone_policy", label: "Public phone policy", fallbackValue: "Mask until explicit publish approval", help: "Prevents fixture phone values from becoming public contact data." },
    ],
  },
] as const satisfies readonly SettingsSectionDefinition[]

export async function loadAdminSettings(repository?: AdminSettingsRepository): Promise<AdminSettingsLoadResult> {
  if (repository === undefined) {
    return { source: "fixture", sections: buildSettingsSections([]) }
  }

  const rows = await repository.listSettings()
  return { source: "supabase", sections: buildSettingsSections(rows) }
}

export function buildSettingsSections(rows: readonly SettingRow[]): readonly SettingsSection[] {
  const valuesByKey = new Map(rows.map((row) => [row.key, row.value]))

  return SETTINGS_SECTION_DEFINITIONS.map((section) => ({
    title: section.title,
    description: section.description,
    fields: section.fields.map((field) => ({
      key: field.key,
      label: field.label,
      value: settingValueToDisplay(valuesByKey.get(field.key), field.fallbackValue),
      help: field.help,
    })),
  }))
}

function settingValueToDisplay(value: Json | undefined, fallbackValue: string): string {
  if (value === undefined || value === null) {
    return fallbackValue
  }

  if (typeof value === "string") {
    return value
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }

  return JSON.stringify(value)
}
