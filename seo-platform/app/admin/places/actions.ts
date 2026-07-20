"use server"

import { createServerClient } from "@supabase/ssr"
import { revalidatePath } from "next/cache"

import { resolvePublishEnvironment } from "@/lib/admin/publish-environment"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { generateAiPreview, applyAiGeneration } from "@/lib/ai/service"
import { FakeDeterministicAiProvider } from "@/lib/ai/fake-provider"
import { AiGuardrailViolationError } from "@/lib/ai/guardrails"
import { endAiGeneration, tryBeginAiGeneration } from "@/lib/ai/in-flight"
import { withAiGenerationMetadata } from "@/lib/ai/metadata"
import { AiProviderRequestError, OpenAiSeoContentProvider, type AiProviderErrorCode } from "@/lib/ai/openai-provider"
import { resolveAiProviderSelection } from "@/lib/ai/provider-selection"
import { estimateUsageCostUsd } from "@/lib/ai/usage-cost"
import type { AiGenerationMetadata, AiProvider } from "@/lib/ai/types"
import { isAllowedAdminEmail } from "@/lib/auth/admin-middleware"
import { buildAdminPlacesHref, resolveAdminPlacesWorkspaceParams, type AdminPlacesAiCode, type AdminPlacesNotice } from "@/lib/admin/places-url"
import type { Database } from "@/types/database"

const RECENT_PREVIEW_GUARD_SECONDS = 60

export async function generatePlaceAiPreviewAction(formData: FormData): Promise<never> {
  const placeId = readPlaceId(formData)
  const backParams = readBackParams(formData)
  if (placeId === null) {
    redirect(buildNoticeHref(backParams, null, "ai-error"))
  }
  if (!hasPlaceActionEnvironment()) {
    redirect(buildNoticeHref(backParams, placeId, "missing-env"))
  }
  await ensureAdminActionAllowed()

  const { createSupabaseAiRepository, hasRecentPreviewAiGeneration, recordFailedAiGeneration } = await import("@/lib/ai/supabase-repository")

  const selection = resolveAiProviderSelection({
    AI_PROVIDER: process.env["AI_PROVIDER"],
    OPENAI_API_KEY: process.env["OPENAI_API_KEY"],
    OPENAI_MODEL: process.env["OPENAI_MODEL"],
  })
  if (selection.kind === "misconfigured") {
    await recordFailedAiGenerationSafely(recordFailedAiGeneration, placeId, "openai", null, selection.errorCode)
    redirect(buildAdminPlacesHref({ ...backParams, selected: placeId, notice: "ai-failed", aiCode: selection.errorCode }))
  }

  if (await hasRecentPreviewAiGeneration(placeId, RECENT_PREVIEW_GUARD_SECONDS)) {
    redirect(buildNoticeHref(backParams, placeId, "ai-recent"))
  }
  if (!tryBeginAiGeneration(placeId)) {
    redirect(buildNoticeHref(backParams, placeId, "ai-busy"))
  }

  const providerName = selection.kind === "openai" ? "openai" : "fake"
  const modelName = selection.kind === "openai" ? selection.model : "FakeDeterministicAiProvider"
  const openAiProvider = selection.kind === "openai" ? new OpenAiSeoContentProvider({ apiKey: selection.apiKey, model: selection.model }) : null
  const provider: AiProvider = openAiProvider ?? new FakeDeterministicAiProvider()
  const buildMetadata = (): AiGenerationMetadata => {
    const usage = openAiProvider?.lastUsage ?? null
    return {
      provider: providerName,
      model: modelName,
      usage,
      estimated_cost: providerName === "openai" ? estimateUsageCostUsd(modelName, usage) : null,
    }
  }

  try {
    await generateAiPreview({
      placeId,
      provider,
      repository: withAiGenerationMetadata(createSupabaseAiRepository(), buildMetadata),
    })
  } catch (error) {
    if (isRedirectError(error)) {
      throw error
    }
    const errorCode = classifyAiGenerationError(error)
    await recordFailedAiGenerationSafely(recordFailedAiGeneration, placeId, providerName, modelName, errorCode)
    redirect(buildAdminPlacesHref({ ...backParams, selected: placeId, notice: "ai-failed", aiCode: errorCode }))
  } finally {
    endAiGeneration(placeId)
  }

  redirect(buildNoticeHref(backParams, placeId, "ai-generated", true))
}

function classifyAiGenerationError(error: unknown): AdminPlacesAiCode {
  if (error instanceof AiProviderRequestError) {
    return error.code satisfies AiProviderErrorCode
  }
  if (error instanceof AiGuardrailViolationError) {
    return "invalid_response"
  }
  return "provider_error"
}

async function recordFailedAiGenerationSafely(
  record: (input: Readonly<{ placeId: string; provider: string; model: string | null; errorCode: string }>) => Promise<void>,
  placeId: string,
  provider: string,
  model: string | null,
  errorCode: string,
): Promise<void> {
  try {
    await record({ placeId, provider, model, errorCode })
  } catch {
    // 실패 이력 기록이 실패해도 사용자 알림 흐름은 유지한다.
  }
}

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

  const [{ createSupabasePlacePublishRepository }, { publishPlacePage }] = await Promise.all([
    import("@/lib/seo-pages/supabase-place-publish"),
    import("@/lib/seo-pages/place-publish"),
  ])

  let notice: AdminPlacesNotice = "publish-failed"
  try {
    const result = await publishPlacePage(createSupabasePlacePublishRepository(), placeId)
    if (result.kind === "published" || result.kind === "already-published") {
      // DB 게시 성공과 캐시 갱신·공개 확인을 분리 — 캐시 단계가 실패하면 성공으로 표시하지 않는다.
      const revalidated = revalidatePublicPlacePaths(result.path)
      const live = revalidated ? await verifyPublicPageLive(result.path) : false
      notice = revalidated && live ? (result.kind === "published" ? "published" : "already-published") : "cache-refresh-failed"
    } else {
      notice = result.kind === "unexpected" ? "publish-failed" : "publish-blocked"
    }
  } catch {
    notice = "publish-failed"
  }

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

// 캐시 갱신은 DB 변경과 분리해 성공 여부를 반환한다. 실패는 서버 로그에 기록되고 UI에는 cache-refresh-failed로 표시된다.
function revalidatePublicPlacePaths(path: string | null): boolean {
  try {
    if (path?.startsWith("/places/") === true) {
      revalidatePath(path)
    }
    revalidatePath("/sitemap.xml")
    return true
  } catch (error) {
    console.error("[publish-cache] revalidation failed", { path, error: error instanceof Error ? error.message : String(error) })
    return false
  }
}

// 게시 직후 공개 URL이 실제로 200을 반환하는지 확인한다 (stale 404 negative cache 감지 + 캐시 워밍).
// 1회 시도·최대 3.5초 — 액션 전체가 함수 실행 제한을 넘지 않도록 예산을 고정한다 (2호점 게시 시 성공 Toast 유실 원인).
async function verifyPublicPageLive(path: string | null): Promise<boolean> {
  if (path?.startsWith("/places/") !== true) {
    return false
  }
  const { getSiteUrl } = await import("@/lib/site-url")
  const url = `${getSiteUrl()}${path}`
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, 3500)
    const response = await fetch(url, { cache: "no-store", signal: controller.signal })
    clearTimeout(timer)
    if (response.status === 200) {
      return true
    }
    console.error("[publish-cache] public page check returned non-200", { url, status: response.status })
  } catch (error) {
    console.error("[publish-cache] public page check failed", { url, error: error instanceof Error ? error.message : String(error) })
  }
  return false
}

// 운영 게시·보관·복원은 Production 배포에서만 허용한다 (Preview에서 실행 시 운영 캐시가 갱신되지 않음).
function ensurePublishEnvironmentAllowed(backParams: BackParams, placeId: string): void {
  const decision = resolvePublishEnvironment(process.env["VERCEL_ENV"])
  if (!decision.allowed) {
    console.error("[publish-cache] blocked publish action on non-production deployment", { environment: decision.environment, placeId })
    redirect(buildNoticeHref(backParams, placeId, "env-blocked"))
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
