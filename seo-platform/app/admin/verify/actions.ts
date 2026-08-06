"use server"

import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { isAllowedAdminEmail } from "@/lib/auth/admin-middleware"
import type { Database } from "@/types/database"

// 공식 검증 반영 — 작업자가 홈페이지에서 명칭·주소·전화를 확인했다고 체크한 장소만 verified로 만든다.
// 조건부 갱신이라 이미 verified/excluded인 행은 건드리지 않는다 (lib/admin/verification-queue 계약).
export async function markPlacesVerifiedAction(formData: FormData): Promise<never> {
  const { email } = await ensureVerifyActionAllowed()
  if (email === null) {
    redirect("/admin/verify?error=no-admin")
  }
  const placeIds = formData.getAll("placeIds").filter((value): value is string => typeof value === "string" && value.length > 0)
  if (placeIds.length === 0) {
    redirect("/admin/verify?error=no-places")
  }
  if (formData.get("verifyConfirmed") !== "on") {
    redirect("/admin/verify?error=not-confirmed")
  }

  const { markPlacesVerified, VERIFY_MAX_ITEMS } = await import("@/lib/admin/verification-queue")
  if (placeIds.length > VERIFY_MAX_ITEMS) {
    redirect("/admin/verify?error=too-many")
  }

  let updated = 0
  let skipped = 0
  try {
    const result = await markPlacesVerified({ placeIds, verifiedBy: email, nowIso: new Date().toISOString() })
    updated = result.updated
    skipped = result.skipped.length
  } catch {
    redirect("/admin/verify?error=update-failed")
  }
  redirect(`/admin/verify?notice=verified&updated=${String(updated)}&skipped=${String(skipped)}`)
}

// 승인·게시 액션과 동일한 보호 계약 — 환경 변수 + 관리자 이메일 허용목록.
// (use server 파일은 액션 외 export가 불가해 헬퍼를 공유하지 못하므로 동일 구현을 유지한다.)
async function ensureVerifyActionAllowed(): Promise<{ email: string | null }> {
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"]
  const anonKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
  if (supabaseUrl === undefined || anonKey === undefined || process.env["SUPABASE_SERVICE_ROLE_KEY"] === undefined) {
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
    redirect("/login?next=/admin/verify")
  }
  return { email: data.user.email ?? null }
}
