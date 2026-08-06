"use server"

import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { isAllowedAdminEmail } from "@/lib/auth/admin-middleware"
import type { Database } from "@/types/database"

// 승인 자동 생성은 Production 관리자에서 실행한다 — 여기서는 승인 행 생성과 Preview kick만 하고,
// 실제 AI 생성은 고정 Preview execute endpoint가 수행한다 (Production AI_PROVIDER=fake 유지).
export async function approveAndGenerateAction(formData: FormData): Promise<never> {
  const { email } = await ensureApprovalActionAllowed()
  if (email === null) {
    redirect("/admin/batch/approve?error=no-admin")
  }
  const placeIds = formData.getAll("placeIds").filter((value): value is string => typeof value === "string" && value.length > 0)
  const approvalConfirmed = formData.get("approvalConfirmed") === "on"
  if (!approvalConfirmed) {
    redirect("/admin/batch/approve?error=not-confirmed")
  }

  const [{ createApprovalAndKick }, { approvalMaxCostUsd }] = await Promise.all([
    import("@/lib/batch/approval-request-service"),
    import("@/lib/batch/cost-policy"),
  ])
  // 승인 생성 중 예외(DB 제약 위반 등)를 그대로 던지면 클라이언트에는 전송 실패로만 보여
  // "네트워크 상태를 확인하세요"라는 엉뚱한 안내가 뜬다 (2026-08-06: DB CHECK가 5로 남아 있어
  // 20곳 승인이 거부됐는데 화면에는 네트워크 오류로 표시됐다). 서버에서 잡아 사유를 넘긴다.
  let result: Awaited<ReturnType<typeof createApprovalAndKick>>
  try {
    result = await createApprovalAndKick({
      placeIds,
      approvedBy: email,
      maxCostUsd: approvalMaxCostUsd(placeIds.length),
      env: { VERCEL_AUTOMATION_BYPASS_SECRET: process.env["VERCEL_AUTOMATION_BYPASS_SECRET"] },
      nowIso: new Date().toISOString(),
    })
  } catch (error) {
    if (isRedirectError(error)) {
      throw error
    }
    console.error("[approval] create failed", { placeCount: placeIds.length, message: error instanceof Error ? error.message : String(error) })
    redirect("/admin/batch/approve?error=create-failed")
  }

  if (result.kind === "blocked") {
    redirect(`/admin/batch/approve?error=${encodeURIComponent(result.reason)}`)
  }
  if (result.kind === "already-active") {
    redirect("/admin/batch/approve?error=already-active")
  }
  if (result.kind === "kick-failed") {
    // 실행 시작 증거가 전혀 없는 확정 실패 — 승인은 취소로 닫혔고 AI 생성은 시작되지 않았다.
    redirect(`/admin/batch/approve?error=kick-${encodeURIComponent(result.code)}`)
  }
  if (result.kind === "accepted-unconfirmed") {
    // 응답은 못 받았지만 실행은 이미 접수됐다 — 취소하지 않았고, 재실행하면 안 된다.
    redirect("/admin/batch/approve?notice=accepted-unconfirmed")
  }
  if (result.kind === "unknown") {
    // 접수 여부를 단정할 수 없다 — 재실행 금지 안내만 한다.
    redirect("/admin/batch/approve?notice=status-unknown")
  }
  redirect("/admin/batch/approve?notice=started")
}

// 승인 취소 — approved/queued/running에서만 동작한다 (종료 상태는 no-op).
export async function cancelApprovalAction(formData: FormData): Promise<never> {
  await ensureApprovalActionAllowed()
  const approvalId = formData.get("approvalId")
  if (typeof approvalId === "string" && /^[0-9a-fA-F-]{36}$/.test(approvalId)) {
    const { createSupabaseApprovalRepository } = await import("@/lib/batch/supabase-approval-repository")
    await createSupabaseApprovalRepository().cancelApproval(approvalId)
    redirect("/admin/batch/approve?notice=cancelled")
  }
  redirect("/admin/batch/approve")
}

// redirect()가 던지는 NEXT_REDIRECT를 일반 오류와 구분한다 (places/actions.ts와 동일 계약).
function isRedirectError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "digest" in error && String(error.digest).startsWith("NEXT_REDIRECT")
}

// 기존 batch/actions.ts와 동일한 보호 계약 — 환경 변수 + 관리자 이메일 허용목록.
// (use server 파일은 액션 외 export가 불가해 헬퍼를 공유하지 못하므로 동일 구현을 유지한다.)
async function ensureApprovalActionAllowed(): Promise<{ email: string | null }> {
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
    redirect("/login?next=/admin/batch/approve")
  }
  return { email: data.user.email ?? null }
}
