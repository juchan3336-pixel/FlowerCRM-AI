"use server"

import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { redirect, unstable_rethrow } from "next/navigation"

import { isAllowedAdminEmail } from "@/lib/auth/admin-middleware"
import type { Database } from "@/types/database"

export async function runManualSyncAction(formData?: FormData): Promise<never> {
  if (!hasManualSyncEnvironment()) {
    redirect("/admin/sync?sync=missing-env")
  }

  await ensureAdminActionAllowed()

  const { syncGoogleSheetsToSupabase } = await import("@/lib/sync/live-sync")
  const result = await syncSafely(syncGoogleSheetsToSupabase)
  if (result.kind === "row-number-drift") {
    redirect(driftRedirectPath("/admin/sync?sync=row-number-drift", result.drift))
  }
  redirect(syncCompletedRedirectPath(result.summary, isAutoSyncRequest(formData)))
}

// 행번호 축소 안내에 필요한 수치만 쿼리로 넘긴다 (행 번호뿐 — 시트 내용은 담지 않는다).
function driftRedirectPath(base: string, drift: Readonly<{ latestSheetRow: number; maxSourceRowNumber: number; difference: number }>): string {
  const separator = base.includes("?") ? "&" : "?"
  return `${base}${separator}sheetRow=${String(drift.latestSheetRow)}&maxRow=${String(drift.maxSourceRowNumber)}&diff=${String(drift.difference)}`
}

// ── 자동 연속 동기화 (self-chain) ─────────────────────────────────
// 버튼 1클릭 = job 1개. 이 액션은 job을 만들고 첫 tick만 발사한 뒤 즉시 redirect로 끝난다.
// 이후 50건 배치는 서버가 스스로 이어간다 — 브라우저를 닫아도 계속된다.
export async function startSyncJobAction(): Promise<never> {
  if (!hasManualSyncEnvironment()) {
    redirect("/admin/sync?job=missing-env")
  }
  const email = await ensureAdminActionAllowed()

  try {
    const { startSyncJob } = await import("@/lib/sync/job-service")
    const { createLiveSyncJobDependencies } = await import("@/lib/sync/job-dependencies")
    const { SYNC_CHAIN_BASE_URL } = await import("@/lib/sync/job-policy")
    const { scheduleNextTick } = await import("@/lib/sync/job-chain")

    const started = await startSyncJob(createLiveSyncJobDependencies(), { createdBy: email, nowIso: new Date().toISOString() })
    if (started.kind === "started") {
      await scheduleNextTick({ jobId: started.jobId, token: started.token }, SYNC_CHAIN_BASE_URL)
      redirect(`/admin/sync?job=started&remaining=${String(started.remaining)}`)
    }
    if (started.kind === "already-active") {
      redirect("/admin/sync?job=already-active")
    }
    if (started.kind === "nothing-to-sync") {
      redirect("/admin/sync?job=nothing-to-sync")
    }
    if (started.kind === "row-number-drift") {
      redirect(driftRedirectPath("/admin/sync?job=row-number-drift", started.drift))
    }
    redirect(`/admin/sync?job=failed&reason=${encodeURIComponent(started.reason)}`)
  } catch (error) {
    // 위 분기는 전부 redirect()로 끝난다 — 그 제어 신호를 여기서 실패로 바꾸면 성공한 시작이 실패로 보인다.
    unstable_rethrow(error)
    console.error("sync_job_start_failed", syncFailureDiagnostic(error))
    redirect("/admin/sync?job=failed&reason=unexpected")
  }
}

// 상한 도달·chain 유실로 멈춘 job을 같은 커서에서 이어서 진행한다 (새 job을 만들지 않는다).
export async function resumeSyncJobAction(formData: FormData): Promise<never> {
  if (!hasManualSyncEnvironment()) {
    redirect("/admin/sync?job=missing-env")
  }
  await ensureAdminActionAllowed()
  const jobId = formData.get("jobId")
  if (typeof jobId !== "string" || jobId.length === 0) {
    redirect("/admin/sync?job=failed&reason=unknown-job")
  }

  try {
    const { resumeSyncJob } = await import("@/lib/sync/job-service")
    const { createLiveSyncJobDependencies } = await import("@/lib/sync/job-dependencies")
    const { SYNC_CHAIN_BASE_URL } = await import("@/lib/sync/job-policy")
    const { scheduleNextTick } = await import("@/lib/sync/job-chain")

    const resumed = await resumeSyncJob(createLiveSyncJobDependencies(), { jobId, nowIso: new Date().toISOString() })
    if (resumed.kind === "started") {
      await scheduleNextTick({ jobId: resumed.jobId, token: resumed.token }, SYNC_CHAIN_BASE_URL)
      redirect(`/admin/sync?job=resumed&remaining=${String(resumed.remaining)}`)
    }
    if (resumed.kind === "already-active") {
      redirect("/admin/sync?job=already-active")
    }
    if (resumed.kind === "nothing-to-sync") {
      redirect("/admin/sync?job=nothing-to-sync")
    }
    if (resumed.kind === "row-number-drift") {
      redirect(driftRedirectPath("/admin/sync?job=row-number-drift", resumed.drift))
    }
    redirect(`/admin/sync?job=failed&reason=${encodeURIComponent(resumed.reason)}`)
  } catch (error) {
    unstable_rethrow(error)
    console.error("sync_job_resume_failed", syncFailureDiagnostic(error))
    redirect("/admin/sync?job=failed&reason=unexpected")
  }
}

// 사용자 중단 — 진행 중 배치는 끝까지 처리하고, 후속 job은 만들지 않는다 (처리분 손실 없음).
export async function cancelSyncJobAction(formData: FormData): Promise<never> {
  await ensureAdminActionAllowed()
  const jobId = formData.get("jobId")
  if (typeof jobId !== "string" || jobId.length === 0) {
    redirect("/admin/sync?job=failed&reason=unknown-job")
  }

  try {
    const { cancelSyncSession } = await import("@/lib/sync/job-service")
    const { createLiveSyncJobDependencies } = await import("@/lib/sync/job-dependencies")
    const cancelled = await cancelSyncSession(createLiveSyncJobDependencies(), { jobId })
    redirect(cancelled.kind === "cancelled" ? "/admin/sync?job=cancelled" : "/admin/sync?job=failed&reason=not-active")
  } catch (error) {
    unstable_rethrow(error)
    console.error("sync_job_cancel_failed", syncFailureDiagnostic(error))
    redirect("/admin/sync?job=failed&reason=unexpected")
  }
}

async function syncSafely<T>(sync: () => Promise<T>): Promise<T> {
  try {
    return await sync()
  } catch (error) {
    // sync()가 앞으로 redirect()·notFound()를 쓰게 되더라도 그 제어 신호를 "동기화 실패"로 바꾸지 않는다.
    // (현재 syncGoogleSheetsToSupabase는 redirect를 쓰지 않아 실사고는 없지만, broad catch의 잠재 위험을 여기서 닫는다.)
    unstable_rethrow(error)
    console.error("manual_sync_failed", syncFailureDiagnostic(error))
    redirect(syncFailureRedirectPath(error))
  }
}

function syncCompletedRedirectPath(summary: Readonly<{ failed: number; inserted: number; totalRows: number; updated: number }>, auto: boolean): string {
  const params = new URLSearchParams({
    failed: String(summary.failed),
    inserted: String(summary.inserted),
    rows: String(summary.totalRows),
    sync: "completed",
    updated: String(summary.updated),
  })
  if (auto) {
    params.set("auto", "1")
  }
  return `/admin/sync?${params.toString()}`
}

function isAutoSyncRequest(formData: FormData | undefined): boolean {
  return formData?.get("auto") === "1"
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

async function ensureAdminActionAllowed(): Promise<string | null> {
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
  return data.user.email ?? null
}
