"use server"

import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { isAllowedAdminEmail } from "@/lib/auth/admin-middleware"
import type { Database } from "@/types/database"

export async function runManualSyncAction(): Promise<never> {
  if (!hasManualSyncEnvironment()) {
    redirect("/admin/sync?sync=missing-env")
  }

  await ensureAdminActionAllowed()

  const { syncGoogleSheetsToSupabase } = await import("@/lib/sync/live-sync")
  const summary = await syncSafely(syncGoogleSheetsToSupabase)
  redirect(`/admin/sync?sync=completed&inserted=${String(summary.inserted)}&updated=${String(summary.updated)}&failed=${String(summary.failed)}`)
}

async function syncSafely(sync: () => Promise<Readonly<{ inserted: number; updated: number; failed: number }>>) {
  try {
    return await sync()
  } catch (error) {
    console.error("manual_sync_failed", syncFailureDiagnostic(error))
    redirect(syncFailureRedirectPath(error))
  }
}

function syncFailureRedirectPath(error: unknown): string {
  if (!(error instanceof Error)) {
    return "/admin/sync?sync=failed&reason=unexpected"
  }

  switch (error.name) {
    case "InvalidGoogleServiceAccountError":
      return "/admin/sync?sync=invalid-google-config"
    case "MissingGoogleSheetsEnvError":
      return "/admin/sync?sync=missing-env"
    case "SupabaseSyncWriteError":
      return "/admin/sync?sync=failed&reason=supabase-write"
    case "GaxiosError":
      return "/admin/sync?sync=failed&reason=google-read"
    default:
      return "/admin/sync?sync=failed&reason=unexpected"
  }
}

function syncFailureDiagnostic(error: unknown): SyncFailureDiagnostic {
  if (!(error instanceof Error)) {
    return { name: "NonError", constructorName: "NonError", code: stringProperty(error, "code"), status: numberProperty(error, "status") }
  }

  return {
    name: error.name,
    constructorName: error.constructor.name,
    code: stringProperty(error, "code"),
    detail: stringProperty(error, "detail"),
    status: numberProperty(error, "status"),
  }
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!isUnknownRecord(value)) {
    return undefined
  }

  const property = value[key]
  return typeof property === "string" ? property : undefined
}

function numberProperty(value: unknown, key: string): number | undefined {
  if (!isUnknownRecord(value)) {
    return undefined
  }

  const property = value[key]
  return typeof property === "number" ? property : undefined
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object"
}

type SyncFailureDiagnostic = {
  readonly name: string
  readonly constructorName: string
  readonly code: string | undefined
  readonly detail?: string | undefined
  readonly status: number | undefined
}

function hasManualSyncEnvironment(): boolean {
  return (
    process.env["NEXT_PUBLIC_SUPABASE_URL"] !== undefined &&
    process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] !== undefined &&
    process.env["SUPABASE_SERVICE_ROLE_KEY"] !== undefined &&
    process.env["GOOGLE_SERVICE_ACCOUNT_JSON"] !== undefined &&
    process.env["GOOGLE_SPREADSHEET_ID"] !== undefined
  )
}

async function ensureAdminActionAllowed(): Promise<void> {
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"]
  const anonKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
  if (supabaseUrl === undefined || anonKey === undefined) {
    redirect("/login?setup=missing")
  }

  const cookieStore = await cookies()
  const supabase = createServerClient<Database>(supabaseUrl, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          cookieStore.set(name, value, options)
        }
      },
    },
  })
  const { data, error } = await supabase.auth.getUser()

  if (error !== null || !isAllowedAdminEmail(data.user.email ?? null, process.env["ADMIN_EMAIL_ALLOWLIST"])) {
    redirect("/login?next=/admin/sync")
  }
}
