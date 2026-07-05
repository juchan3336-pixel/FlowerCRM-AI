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
    if (error instanceof Error && error.name === "InvalidGoogleServiceAccountError") {
      redirect("/admin/sync?sync=invalid-google-config")
    }
    redirect("/admin/sync?sync=failed")
  }
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
