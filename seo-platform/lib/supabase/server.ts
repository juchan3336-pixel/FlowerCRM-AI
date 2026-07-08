import "server-only"

import { createClient } from "@supabase/supabase-js"
import type { Database } from "@/types/database"

type SupabaseEnvKey =
  | "NEXT_PUBLIC_SUPABASE_URL"
  | "NEXT_PUBLIC_SUPABASE_ANON_KEY"
  | "SUPABASE_SERVICE_ROLE_KEY"

type SupabaseEnvStatus = {
  readonly key: SupabaseEnvKey
  readonly status: "OK" | "MISSING"
}

export function createSupabaseServiceRoleClient() {
  const envStatuses = readSupabaseEnvStatuses()
  const rawSupabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"]
  const serviceRoleKey = process.env["SUPABASE_SERVICE_ROLE_KEY"]

  if (rawSupabaseUrl === undefined || serviceRoleKey === undefined) {
    throw new MissingServerSupabaseEnvError(envStatuses)
  }

  const supabaseUrl = normalizeSupabaseProjectUrl(rawSupabaseUrl)

  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export class MissingServerSupabaseEnvError extends Error {
  readonly name = "MissingServerSupabaseEnvError"

  readonly missingKeys: readonly SupabaseEnvKey[]

  constructor(envStatuses: readonly SupabaseEnvStatus[]) {
    const missingKeys = envStatuses.filter((status) => status.status === "MISSING").map((status) => status.key)
    super(formatMissingServerSupabaseEnvMessage(envStatuses))
    this.missingKeys = missingKeys
  }
}

function readSupabaseEnvStatuses(): readonly SupabaseEnvStatus[] {
  return [
    readSupabaseEnvStatus("NEXT_PUBLIC_SUPABASE_URL"),
    readSupabaseEnvStatus("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    readSupabaseEnvStatus("SUPABASE_SERVICE_ROLE_KEY"),
  ]
}

function readSupabaseEnvStatus(key: SupabaseEnvKey): SupabaseEnvStatus {
  const value = process.env[key]
  return {
    key,
    status: value === undefined || value.trim().length === 0 ? "MISSING" : "OK",
  }
}

function formatMissingServerSupabaseEnvMessage(envStatuses: readonly SupabaseEnvStatus[]): string {
  const lines = envStatuses.map((status) => `${status.key} = ${status.status}`)
  return [`Server Supabase environment variables are required`, ...lines].join("\n")
}

function normalizeSupabaseProjectUrl(value: string | undefined): string {
  if (value === undefined) {
    return ""
  }

  const trimmed = value.trim()
  try {
    return new URL(trimmed).origin
  } catch {
    return trimmed
  }
}
