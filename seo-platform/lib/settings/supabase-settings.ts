import "server-only"

import type { AdminSettingsRepository, SettingRow } from "./types"
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"

export function hasSupabaseSettingsEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["NEXT_PUBLIC_SUPABASE_URL"] !== undefined && env["SUPABASE_SERVICE_ROLE_KEY"] !== undefined
}

export function createSupabaseSettingsRepository(): AdminSettingsRepository {
  const client = createSupabaseServiceRoleClient()

  return {
    async listSettings(): Promise<readonly SettingRow[]> {
      const { data, error } = await client.from("settings").select("*").order("key", { ascending: true })

      if (error !== null) {
        throw new SupabaseSettingsReadError(error.message)
      }

      return data.map((row) => ({ key: row.key, value: row.value, updatedAt: row.updated_at }))
    },
  }
}

export class SupabaseSettingsReadError extends Error {
  readonly name = "SupabaseSettingsReadError"

  constructor(readonly detail: string) {
    super(`Failed to read settings: ${detail}`)
  }
}
