"use server"

import { createServerClient } from "@supabase/ssr"
import { after } from "next/server"

import { resolveManualGenerationEnvironment, resolvePublishEnvironment } from "@/lib/admin/publish-environment"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { applyAiGeneration } from "@/lib/ai/service"
import { evaluateGenerationQuality, runPlaceAiGeneration, type GenerationRunResult } from "@/lib/ai/generation-runner"
import { revalidatePublicPlacePaths, runPlacePublish } from "@/lib/seo-pages/publish-runner"
import { isAllowedAdminEmail } from "@/lib/auth/admin-middleware"
import { ADMIN_PLACES_AI_CODES, buildAdminPlacesHref, resolveAdminPlacesWorkspaceParams, type AdminPlacesAiCode, type AdminPlacesNotice } from "@/lib/admin/places-url"
import type { Database } from "@/types/database"

export async function generatePlaceAiPreviewAction(formData: FormData): Promise<never> {
  const placeId = readPlaceId(formData)
  const backParams = readBackParams(formData)
  if (placeId === null) {
    redirect(buildNoticeHref(backParams, null, "ai-error"))
  }
  if (!hasPlaceActionEnvironment()) {
    redirect(buildNoticeHref(backParams, placeId, "missing-env"))
  }
  ensureManualGenerationEnvironmentAllowed(backParams, placeId)
  await ensureAdminActionAllowed()

  // 생성 코어는 lib/ai/generation-runner.ts로 추출됨 (단건 액션·Batch 공용) — 여기서는 결과를 notice로만 매핑한다.
  const result = await runPlaceAiGeneration({ placeId })
  redirectForGenerationResult(result, backParams, placeId)
}

// 품질 FAIL 복구 재시도 — FAIL preview 원본당 최대 1회, 실패한 FAQ pair 재사용 금지, 원본 id·사유를 감사 기록한다.
// 일반 AI 생성 재클릭과 달리 원본 generation을 명시 참조하며, 원본 레코드는 수정하지 않는다.
export async function retryPlaceAiGenerationAction(formData: FormData): Promise<never> {
  const placeId = readPlaceId(formData)
  const generationId = readGenerationId(formData)
  const backParams = readBackParams(formData)
  if (placeId === null || generationId === null) {
    redirect(buildNoticeHref(backParams, placeId, "ai-error"))
  }
  if (!hasPlaceActionEnvironment()) {
    redirect(buildNoticeHref(backParams, placeId, "missing-env"))
  }
  ensureManualGenerationEnvironmentAllowed(backParams, placeId)
  await ensureAdminActionAllowed()

  const [{ getAiGenerationRetryLookup, countConsumedQualityFailRetriesOf }, { decideQualityFailRetry, faqPairOfFailedGeneration }] = await Promise.all([
    import("@/lib/ai/supabase-repository"),
    import("@/lib/ai/retry-policy"),
  ])

  const lookup = await getAiGenerationRetryLookup(generationId)
  if (lookup?.placeId !== placeId) {
    redirect(buildNoticeHref(backParams, placeId, "ai-error"))
  }
  // UI 버튼 노출 여부와 동일한 판정 — 소진 횟수는 generation 이력과 Batch item 흔적을 함께 본다(시간 경과 무관).
  const decision = decideQualityFailRetry({
    quality: lookup.quality,
    consumedRetryCount: await countConsumedQualityFailRetriesOf(generationId),
    isRetryGeneration: lookup.isRetryGeneration,
  })
  if (!decision.allowed) {
    redirect(buildAdminPlacesHref({ ...backParams, selected: placeId, notice: "ai-failed", aiCode: "retry_blocked" }))
  }

  const bannedPair = faqPairOfFailedGeneration({ contentPlanFaqKeys: lookup.contentPlanFaqKeys, faqQuestions: lookup.faqQuestions, mode: lookup.mode })
  const result = await runPlaceAiGeneration({
    placeId,
    retry: { of: generationId, reason: decision.reason, bannedFaqPairs: bannedPair === null ? [] : [bannedPair] },
  })
  redirectForGenerationResult(result, backParams, placeId)
}

// 게시 차단 종류별 notice — 어휘 위반과 업종 판정 실패는 원인이 달라 문구를 나눈다.
function resolvePublishBlockNotice(kind: "blocked" | "vocabulary-blocked" | "category-blocked" | "unexpected"): AdminPlacesNotice {
  if (kind === "unexpected") return "publish-failed"
  if (kind === "vocabulary-blocked") return "vocabulary-blocked"
  if (kind === "category-blocked") return "category-blocked"
  return "publish-blocked"
}

// 생성 코어 결과 → 기존 notice 매핑 (동작 무변경).
function redirectForGenerationResult(result: GenerationRunResult, backParams: BackParams, placeId: string): never {
  switch (result.kind) {
    case "generated":
      redirect(buildNoticeHref(backParams, placeId, "ai-generated", true))
      break
    case "recent-preview":
      redirect(buildNoticeHref(backParams, placeId, "ai-recent"))
      break
    case "busy":
      redirect(buildNoticeHref(backParams, placeId, "ai-busy"))
      break
    case "repeat-blocked": {
      // 같은 오류로 연속 실패해 일시 잠금 — 마지막 실패의 코드를 함께 보여 진단을 돕는다.
      const aiCode = (ADMIN_PLACES_AI_CODES as readonly string[]).includes(result.errorCode) ? (result.errorCode as AdminPlacesAiCode) : null
      redirect(buildAdminPlacesHref({ ...backParams, selected: placeId, notice: "ai-repeat-blocked", ...(aiCode === null ? {} : { aiCode }) }))
      break
    }
    case "misconfigured":
    case "failed":
      redirect(buildAdminPlacesHref({ ...backParams, selected: placeId, notice: "ai-failed", aiCode: result.errorCode }))
      break
  }
  throw new Error("unreachable")
}

// 품질 재평가·오류 분류·실패 기록 헬퍼는 lib/ai/generation-runner.ts로 이동했다 (코어 추출).

export async function preparePlacePublishAction(formData: FormData): Promise<never> {
  const placeId = readPlaceId(formData)
  const backParams = readBackParams(formData)
  if (placeId === null) {
    redirect(buildNoticeHref(backParams, null, "ai-error"))
  }
  if (!hasPlaceActionEnvironment()) {
    redirect(buildNoticeHref(backParams, placeId, "missing-env"))
  }
  await ensureAdminActionAllowed()

  const [{ createSupabaseAiRepository, findLatestPreviewAiGenerationId }, { createSupabasePlaceSeoGenerationRepository }, { generateSinglePlaceSeoPage }] = await Promise.all([
    import("@/lib/ai/supabase-repository"),
    import("@/lib/seo-pages/supabase-place-generation"),
    import("@/lib/seo-pages/single-place-generation"),
  ])

  const generationId = await findLatestPreviewAiGenerationId(placeId)
  if (generationId === null) {
    redirect(buildNoticeHref(backParams, placeId, "no-preview"))
  }

  // 품질 게이트: 최신 콘텐츠(수동 보정 반영)를 재평가해 FAIL이면 apply·게시 준비를 차단한다.
  const gateQuality = await evaluateGenerationQuality(generationId)
  if (gateQuality !== null && gateQuality.status === "fail") {
    redirect(buildNoticeHref(backParams, placeId, "quality-blocked"))
  }

  try {
    await applyAiGeneration({ generationId, repository: createSupabaseAiRepository() })
    const seoResult = await generateSinglePlaceSeoPage({ repository: createSupabasePlaceSeoGenerationRepository(), placeId })
    if (seoResult.kind === "blocked" || seoResult.kind === "missing-place") {
      redirect(buildNoticeHref(backParams, placeId, "prepare-blocked"))
    }
    redirect(buildNoticeHref(backParams, placeId, seoResult.kind === "already-exists" ? "prepared-existing" : "prepared"))
  } catch (error) {
    if (isRedirectError(error)) {
      throw error
    }
    redirect(buildNoticeHref(backParams, placeId, "prepare-blocked"))
  }
}

export async function publishPlacePageAction(formData: FormData): Promise<never> {
  const placeId = readPlaceId(formData)
  const backParams = readBackParams(formData)
  if (placeId === null) {
    redirect(buildNoticeHref(backParams, null, "publish-failed"))
  }
  if (!hasPlaceActionEnvironment()) {
    redirect(buildNoticeHref(backParams, placeId, "missing-env"))
  }
  if (stringField(formData, "approve") !== "on") {
    redirect(buildAdminPlacesHref({ ...backParams, selected: placeId, confirm: "publish", notice: "approval-required" }))
  }
  ensurePublishEnvironmentAllowed(backParams, placeId)
  await ensureAdminActionAllowed()

  // 게시 코어(RPC → revalidate → after() 비동기 검증 예약)는 lib/seo-pages/publish-runner.ts로 추출됨 (단건 액션·Batch 공용).
  // DB 게시 + revalidate 성공이면 즉시 성공으로 알린다 — cache-refresh-failed는 revalidate 자체 실패 전용 (PR #25 구조 유지).
  let notice: AdminPlacesNotice = "publish-failed"
  try {
    const result = await runPlacePublish(placeId, { registerAfter: after })
    if (result.kind === "published" || result.kind === "already-published") {
      notice = result.revalidated ? result.kind : "cache-refresh-failed"
    } else {
      notice = resolvePublishBlockNotice(result.kind)
    }
  } catch {
    notice = "publish-failed"
  }

  // after() 등록은 runPlacePublish 내부에서 이미 끝났으므로 redirect(NEXT_REDIRECT throw)가 안전하다.
  redirect(buildNoticeHref(backParams, placeId, notice))
}

export async function archivePlacePageAction(formData: FormData): Promise<never> {
  const placeId = readPlaceId(formData)
  const backParams = readBackParams(formData)
  if (placeId === null) {
    redirect(buildNoticeHref(backParams, null, "archive-failed"))
  }
  if (!hasPlaceActionEnvironment()) {
    redirect(buildNoticeHref(backParams, placeId, "missing-env"))
  }
  ensurePublishEnvironmentAllowed(backParams, placeId)
  await ensureAdminActionAllowed()

  const [{ createSupabasePlacePublishRepository }, { archivePlacePage }] = await Promise.all([
    import("@/lib/seo-pages/supabase-place-publish"),
    import("@/lib/seo-pages/place-publish"),
  ])

  let notice: AdminPlacesNotice = "archive-failed"
  try {
    const result = await archivePlacePage(createSupabasePlacePublishRepository(), placeId)
    if (result.kind === "archived") {
      const revalidated = revalidatePublicPlacePaths(result.path)
      notice = revalidated ? "archived" : "cache-refresh-failed"
    } else {
      notice = result.kind === "unexpected" ? "archive-failed" : "archive-blocked"
    }
  } catch {
    notice = "archive-failed"
  }

  redirect(buildNoticeHref(backParams, placeId, notice))
}

export async function restorePlacePageAction(formData: FormData): Promise<never> {
  const placeId = readPlaceId(formData)
  const backParams = readBackParams(formData)
  if (placeId === null) {
    redirect(buildNoticeHref(backParams, null, "restore-failed"))
  }
  if (!hasPlaceActionEnvironment()) {
    redirect(buildNoticeHref(backParams, placeId, "missing-env"))
  }
  ensurePublishEnvironmentAllowed(backParams, placeId)
  await ensureAdminActionAllowed()

  const [{ createSupabasePlacePublishRepository }, { restorePlacePage }] = await Promise.all([
    import("@/lib/seo-pages/supabase-place-publish"),
    import("@/lib/seo-pages/place-publish"),
  ])

  let notice: AdminPlacesNotice = "restore-failed"
  try {
    const result = await restorePlacePage(createSupabasePlacePublishRepository(), placeId)
    if (result.kind === "restored") {
      const revalidated = revalidatePublicPlacePaths(result.path)
      notice = revalidated ? "restored" : "cache-refresh-failed"
    } else {
      notice = result.kind === "unexpected" ? "restore-failed" : "restore-blocked"
    }
  } catch {
    notice = "restore-failed"
  }

  redirect(buildNoticeHref(backParams, placeId, notice))
}

// 캐시 갱신(revalidatePublicPlacePaths)은 lib/seo-pages/publish-runner.ts로 이동했다 (코어 추출).

// 운영 게시·보관·복원은 Production 배포에서만 허용한다 (Preview에서 실행 시 운영 캐시가 갱신되지 않음).
function ensurePublishEnvironmentAllowed(backParams: BackParams, placeId: string): void {
  const decision = resolvePublishEnvironment(process.env["VERCEL_ENV"])
  if (!decision.allowed) {
    console.error("[publish-cache] blocked publish action on non-production deployment", { environment: decision.environment, placeId })
    redirect(buildNoticeHref(backParams, placeId, "env-blocked"))
  }
}

// 수동 AI 생성·복구 재시도의 Production 하드 차단 — UI 버튼과 별개로, 직접 POST·딥링크 우회도 여기서 막힌다.
// (server action이 유일한 진입점이므로 form 우회 호출도 이 게이트를 지난다.)
function ensureManualGenerationEnvironmentAllowed(backParams: BackParams, placeId: string): void {
  const decision = resolveManualGenerationEnvironment(process.env["VERCEL_ENV"])
  if (!decision.allowed) {
    console.error("[ai-generation] blocked manual generation on production deployment", { environment: decision.environment, placeId })
    redirect(buildNoticeHref(backParams, placeId, "ai-env-blocked"))
  }
}

type BackParams = Readonly<{ q: string | null; task: ReturnType<typeof resolveAdminPlacesWorkspaceParams>["task"]; page: number; pageSize: number }>

function readBackParams(formData: FormData): BackParams {
  const params = resolveAdminPlacesWorkspaceParams({
    q: stringField(formData, "q") ?? undefined,
    task: stringField(formData, "task") ?? undefined,
    page: stringField(formData, "page") ?? undefined,
    pageSize: stringField(formData, "pageSize") ?? undefined,
  })
  return { q: params.q, task: params.task, page: params.page, pageSize: params.pageSize }
}

function buildNoticeHref(backParams: BackParams, placeId: string | null, notice: AdminPlacesNotice, preview = false): string {
  return buildAdminPlacesHref({ ...backParams, selected: placeId, notice, preview })
}

function readPlaceId(formData: FormData): string | null {
  const value = stringField(formData, "placeId")
  return value !== null && /^[0-9a-zA-Z_-]{1,64}$/.test(value) ? value : null
}

function readGenerationId(formData: FormData): string | null {
  const value = stringField(formData, "generationId")
  return value !== null && /^[0-9a-zA-Z_-]{1,64}$/.test(value) ? value : null
}

function stringField(formData: FormData, name: string): string | null {
  const value = formData.get(name)
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function hasPlaceActionEnvironment(): boolean {
  return (
    process.env["NEXT_PUBLIC_SUPABASE_URL"] !== undefined &&
    process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] !== undefined &&
    process.env["SUPABASE_SERVICE_ROLE_KEY"] !== undefined
  )
}

function isRedirectError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "digest" in error && String(error.digest).startsWith("NEXT_REDIRECT")
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
    redirect("/login?next=/admin/places")
  }
}
