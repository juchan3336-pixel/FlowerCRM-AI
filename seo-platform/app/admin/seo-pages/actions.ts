"use server"

import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { generateSelectedSampleSeoPages, publishSelectedReadySeoPages } from "@/lib/admin/seo-page-actions"
import { isAllowedAdminEmail } from "@/lib/auth/admin-middleware"
import type { Database } from "@/types/database"

export async function generateSelectedSampleSeoPagesAction(formData: FormData): Promise<never> {
  if (!hasSeoPageActionEnvironment()) {
    redirect("/admin/seo-pages?generate=missing-env")
  }

  const { createSupabaseAdminSeoPagesRepository } = await import("@/lib/admin/supabase-seo-pages")
  const repository = createSupabaseAdminSeoPagesRepository()
  const result = await generateSelectedSampleSeoPages({ repository, placeIds: selectedValues(formData, "placeId"), assertAllowed: ensureAdminActionAllowed })
  if (result.kind === "rejected") {
    redirect(`/admin/seo-pages?generate=rejected&reason=${result.reason}&selected=${String(result.selected)}`)
  }

  redirect(`/admin/seo-pages?generate=created&selected=${String(result.selected)}&created=${String(result.created)}&blocked=${String(result.blocked)}&warnings=${String(result.warnings)}`)
}

export async function publishSelectedReadySeoPagesAction(formData: FormData): Promise<never> {
  if (!hasSeoPageActionEnvironment()) {
    redirect("/admin/seo-pages?publish=missing-env")
  }

  const { createSupabaseAdminSeoPagesRepository } = await import("@/lib/admin/supabase-seo-pages")
  const repository = createSupabaseAdminSeoPagesRepository()
  const result = await publishSelectedReadySeoPages({ repository, seoPageIds: selectedValues(formData, "seoPageId"), assertAllowed: ensureAdminActionAllowed })
  if (result.kind === "rejected") {
    redirect(`/admin/seo-pages?publish=rejected&reason=${result.reason}&selected=${String(result.selected)}`)
  }

  redirect(`/admin/seo-pages?publish=completed&selected=${String(result.selected)}&published=${String(result.published)}`)
}

function selectedValues(formData: FormData, fieldName: string): readonly string[] {
  return formData.getAll(fieldName).flatMap((value) => (typeof value === "string" && value.trim().length > 0 ? [value] : []))
}

function hasSeoPageActionEnvironment(): boolean {
  return (
    process.env["NEXT_PUBLIC_SUPABASE_URL"] !== undefined &&
    process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] !== undefined &&
    process.env["SUPABASE_SERVICE_ROLE_KEY"] !== undefined
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
    redirect("/login?next=/admin/seo-pages")
  }
}
