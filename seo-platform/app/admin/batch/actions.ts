"use server"

import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { after } from "next/server"

import { resolvePublishEnvironment } from "@/lib/admin/publish-environment"
import { isAllowedAdminEmail } from "@/lib/auth/admin-middleware"
import type { Database } from "@/types/database"
import type { ProcessNextResult } from "@/lib/batch/generation-batch-service"
import type { ProcessNextPublishResult } from "@/lib/batch/publish-batch-service"

// Batch 생성은 OpenAI 환경(Preview)에서만 실질 동작한다 — Production은 AI_PROVIDER=fake라 시작을 차단하고 안내한다.
function isProductionDeployment(): boolean {
  return resolvePublishEnvironment(process.env["VERCEL_ENV"]).environment === "production"
}

export async function startBatchGenerationAction(formData: FormData): Promise<never> {
  await ensureBatchActionAllowed()
  if (isProductionDeployment()) {
    redirect("/admin/batch/new?error=production-blocked")
  }
  const placeIds = formData.getAll("placeIds").filter((value): value is string => typeof value === "string" && value.length > 0)
  const officialCheckApproved = formData.get("officialCheckApproved") === "on"

  const { startGenerationBatch } = await import("@/lib/batch/generation-batch-service")
  const email = await currentAdminEmail()
  const result = await startGenerationBatch({ placeIds, createdBy: email, officialCheckApproved })
  if (result.kind === "already-running") {
    redirect("/admin/batch/new?error=already-running")
  }
  if (result.kind === "invalid") {
    redirect(`/admin/batch/new?error=${encodeURIComponent(result.plan.reason)}`)
  }
  // 최초 시작은 모달에서 명시 승인됨 — start=1로 진행 화면이 순차 처리를 시작한다 (재진입 시에는 버튼 필요).
  redirect(`/admin/batch/${result.batchId}?start=1`)
}

// 다음 1건 처리 — 진행 화면 클라이언트가 완료 응답을 받을 때마다 재호출한다 (순차성 보장).
// trigger는 감사용(이벤트 detail) — 'resume'은 사용자가 '이어서 진행'으로 시작한 호출을 뜻한다.
export async function processNextBatchItemAction(batchId: string, trigger?: "auto" | "resume"): Promise<ProcessNextResult> {
  const { email } = await ensureBatchActionAllowed()
  if (!isValidId(batchId)) {
    return { runStatus: "failed", done: true, processed: null }
  }
  const { processNextGenerationItem } = await import("@/lib/batch/generation-batch-service")
  return processNextGenerationItem(batchId, { trigger: trigger === "resume" ? "resume" : "auto", actor: email })
}

export async function cancelBatchAction(formData: FormData): Promise<never> {
  const { email } = await ensureBatchActionAllowed()
  const batchId = formData.get("batchId")
  if (typeof batchId === "string" && isValidId(batchId)) {
    // kind별 취소 — 게시 배치는 남은 ready 건만 skipped 처리한다 (이미 게시된 건은 되돌리지 않음).
    const { createSupabaseBatchRepository } = await import("@/lib/batch/supabase-batch-repository")
    const run = await createSupabaseBatchRepository().getRun(batchId)
    if (run?.kind === "publish") {
      const { cancelPublishBatch } = await import("@/lib/batch/publish-batch-service")
      await cancelPublishBatch(batchId, email)
    } else {
      const { cancelGenerationBatch } = await import("@/lib/batch/generation-batch-service")
      await cancelGenerationBatch(batchId, email)
    }
    redirect(`/admin/batch/${batchId}`)
  }
  redirect("/admin/places")
}

// ── needs_review 해소 (검토·보정 후 게시 준비) ───────────────────────
// 관리자가 품질 사유를 확인하고 허용 필드만 보정한 뒤 정식 상태 전이로 ready까지 올리는 유일한 경로다.
// DB 직접 조작 도구는 제공하지 않는다 — 모든 전이는 조건부 UPDATE와 apply 코어를 재사용한다.
export async function resolveNeedsReviewItemAction(formData: FormData): Promise<never> {
  const { email } = await ensureBatchActionAllowed()
  const batchId = readField(formData, "batchId")
  const itemId = readField(formData, "itemId")
  const generationId = readField(formData, "generationId")
  if (batchId === null || itemId === null || generationId === null || !isValidId(batchId) || !isValidId(itemId) || !isValidId(generationId)) {
    redirect("/admin/batch")
  }

  const { RESOLVABLE_FIELDS } = await import("@/lib/batch/needs-review-resolution")
  // 명시적으로 선택(checkbox)된 필드만 보정 대상으로 넘긴다 — 나머지는 원문 그대로 유지된다.
  const edits: Record<string, string> = {}
  for (const field of RESOLVABLE_FIELDS) {
    if (formData.get(`edit.${field}`) !== "on") {
      continue
    }
    const value = formData.get(`value.${field}`)
    edits[field] = typeof value === "string" ? value : ""
  }

  const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")
  const result = await resolveNeedsReviewItem({
    itemId,
    generationId,
    edits,
    confirmed: formData.get("reviewConfirmed") === "on",
    actor: email,
  })

  const notice =
    result.kind === "resolved"
      ? "resolved"
      : result.kind === "quality-not-pass"
        ? `quality-${result.status}`
        : result.kind === "invalid-field"
          ? `invalid-${result.field}`
          : result.kind === "blocked"
            ? result.reason
            : result.reason
  redirect(`/admin/batch/${batchId}?review=${encodeURIComponent(notice)}#item-${itemId}`)
}

// 일괄 검토 해소 — 클라이언트가 선택 항목을 1건씩 순차 호출한다 (BatchProgressRunner와 같은 패턴, 서버 타임아웃 회피).
// 보정 없이 원문 그대로 승인하는 경로다 — 필드 보정이 필요한 항목은 개별 폼(resolveNeedsReviewItemAction)을 쓴다.
export async function resolveNeedsReviewBulkStepAction(
  itemId: string,
  generationId: string,
): Promise<{ readonly kind: "resolved"; readonly itemStatus: "ready" | "warn_ready" } | { readonly kind: "kept"; readonly reason: string }> {
  const { email } = await ensureBatchActionAllowed()
  if (!isValidId(itemId) || !isValidId(generationId)) {
    return { kind: "kept", reason: "invalid-target" }
  }
  const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")
  const result = await resolveNeedsReviewItem({ itemId, generationId, edits: {}, confirmed: true, actor: email })
  if (result.kind === "resolved") {
    return { kind: "resolved", itemStatus: result.itemStatus }
  }
  const reason =
    result.kind === "quality-not-pass" ? `quality-${result.status}` : result.kind === "invalid-field" ? `invalid-${result.field}` : result.reason
  return { kind: "kept", reason }
}

function readField(formData: FormData, name: string): string | null {
  const value = formData.get(name)
  return typeof value === "string" && value.length > 0 ? value : null
}

// ── Batch 게시 (PR-3) ─────────────────────────────────────────────
// 게시는 Production 배포에서만 허용한다 (Preview에서 게시하면 운영 캐시가 갱신되지 않음 — PR #14 정책).
// 생성 배치와 정확히 반대 방향의 환경 게이트다.

export async function startBatchPublishAction(formData: FormData): Promise<never> {
  await ensureBatchActionAllowed()
  if (!resolvePublishEnvironment(process.env["VERCEL_ENV"]).allowed) {
    redirect("/admin/batch/publish/new?error=env-blocked")
  }
  const placeIds = formData.getAll("placeIds").filter((value): value is string => typeof value === "string" && value.length > 0)
  const publishApproved = formData.get("publishApproved") === "on"

  const { startPublishBatch } = await import("@/lib/batch/publish-batch-service")
  const email = await currentAdminEmail()
  const result = await startPublishBatch({ placeIds, createdBy: email, publishApproved })
  if (result.kind === "already-running") {
    redirect("/admin/batch/publish/new?error=already-running")
  }
  if (result.kind === "invalid") {
    redirect(`/admin/batch/publish/new?error=${encodeURIComponent(result.reason)}`)
  }
  redirect(`/admin/batch/${result.batchId}?start=1`)
}

// 다음 1건 게시 — 진행 화면 클라이언트가 완료 응답을 받을 때마다 재호출한다 (한 번에 한 장소).
// after()는 액션 계층에서만 접근 가능하므로 여기서 주입한다 (공개 검증은 응답 이후 비동기 실행).
export async function processNextBatchPublishItemAction(batchId: string, trigger?: "auto" | "resume"): Promise<ProcessNextPublishResult> {
  const { email } = await ensureBatchActionAllowed()
  if (!isValidId(batchId)) {
    return { runStatus: "failed", done: true, processed: null }
  }
  if (!resolvePublishEnvironment(process.env["VERCEL_ENV"]).allowed) {
    return { runStatus: "failed", done: true, processed: null }
  }
  const { processNextPublishItem } = await import("@/lib/batch/publish-batch-service")
  return processNextPublishItem(batchId, { registerAfter: after }, { trigger: trigger === "resume" ? "resume" : "auto", actor: email })
}

function isValidId(value: string): boolean {
  return /^[0-9a-fA-F-]{36}$/.test(value)
}

// 기존 places 액션의 ensureAdminActionAllowed와 동일한 보호 계약 — 환경 변수 + 관리자 이메일 검증.
// (use server 파일은 액션 외 export가 불가해 헬퍼를 공유하지 못하므로 동일 구현을 유지한다.)
async function ensureBatchActionAllowed(): Promise<{ email: string | null }> {
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
    redirect("/login?next=/admin/places")
  }
  return { email: data.user.email ?? null }
}

async function currentAdminEmail(): Promise<string | null> {
  const { email } = await ensureBatchActionAllowed()
  return email
}
