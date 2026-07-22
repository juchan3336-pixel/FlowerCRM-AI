"use server"

import { createServerClient } from "@supabase/ssr"
import { revalidatePath } from "next/cache"
import { after } from "next/server"

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
import type { QualityReport } from "@/lib/ai/content-quality"
import type { AiGeneratedSeoContent, AiGenerationInput, AiGenerationMetadata, AiProvider } from "@/lib/ai/types"
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

  const { createSupabaseAiRepository, hasRecentPreviewAiGeneration, recordFailedAiGeneration, listRecentPublishedContentSnapshots } = await import("@/lib/ai/supabase-repository")

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

  // 제목 패턴·키워드 중복 회피용 최근 공개 스냅샷 — 조회 실패 시 해시 기본 선택으로 진행한다.
  const recentContent = await listRecentPublishedContentSnapshots().catch(() => [])

  try {
    const record = await generateAiPreview({
      placeId,
      provider,
      recentContent,
      repository: withAiGenerationMetadata(createSupabaseAiRepository(), buildMetadata),
    })
    // 생성 직후 품질 성적표를 계산해 저장한다 (관리자 미리보기 표시용 — 실패해도 생성 흐름은 유지).
    await evaluateAndAttachQualitySafely(record.id)
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
  await ensureAdminActionAllowed()

  const [
    { createSupabaseAiRepository, hasRecentPreviewAiGeneration, recordFailedAiGeneration, listRecentPublishedContentSnapshots, getAiGenerationRetryLookup, countRetryGenerationsOf },
    { decideQualityFailRetry, faqPairOfFailedGeneration },
  ] = await Promise.all([import("@/lib/ai/supabase-repository"), import("@/lib/ai/retry-policy")])

  const lookup = await getAiGenerationRetryLookup(generationId)
  if (lookup?.placeId !== placeId) {
    redirect(buildNoticeHref(backParams, placeId, "ai-error"))
  }
  const decision = decideQualityFailRetry({
    quality: lookup.quality,
    existingRetryCount: await countRetryGenerationsOf(generationId),
    isRetryGeneration: lookup.isRetryGeneration,
  })
  if (!decision.allowed) {
    redirect(buildAdminPlacesHref({ ...backParams, selected: placeId, notice: "ai-failed", aiCode: "retry_blocked" }))
  }

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

  const recentContent = await listRecentPublishedContentSnapshots().catch(() => [])
  const bannedPair = faqPairOfFailedGeneration({ contentPlanFaqKeys: lookup.contentPlanFaqKeys, faqQuestions: lookup.faqQuestions })

  try {
    const record = await generateAiPreview({
      placeId,
      provider,
      recentContent,
      repository: withAiGenerationMetadata(createSupabaseAiRepository(), buildMetadata),
      retry: { of: generationId, reason: decision.reason, bannedFaqPairs: bannedPair === null ? [] : [bannedPair] },
    })
    await evaluateAndAttachQualitySafely(record.id)
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

// 생성 콘텐츠를 최근 공개 페이지와 비교 평가하고 성적표를 레코드에 저장한다. 반환값은 게이트 판정용.
async function evaluateGenerationQuality(generationId: string): Promise<QualityReport | null> {
  try {
    const [{ createSupabaseAiRepository, listRecentPublishedContentSnapshots, listVerifiedInternalPaths, attachGenerationQuality }, { evaluateGeneratedContent }] = await Promise.all([
      import("@/lib/ai/supabase-repository"),
      import("@/lib/ai/content-quality"),
    ])
    const repository = createSupabaseAiRepository()
    const generation = await repository.findAiGenerationById(generationId)
    if (generation === undefined) {
      return null
    }
    // 저장 계약상 output/input은 실패 레코드에서 null일 수 있다 — 타입을 nullable로 넓혀 검사한다.
    const output = generation.output as AiGeneratedSeoContent | null
    if (output === null) {
      return null
    }
    const place = (generation.input as AiGenerationInput | null)?.place ?? null
    const fallbackPlace = place === null ? await repository.findPlaceById(generation.place_id) : null
    const placeName = place?.name ?? fallbackPlace?.name ?? ""
    const regionTokens = place !== null ? [place.city, place.district] : [fallbackPlace?.city ?? null, fallbackPlace?.district ?? null]
    const [recentPages, verifiedInternalPaths] = await Promise.all([listRecentPublishedContentSnapshots(), listVerifiedInternalPaths()])
    const quality = evaluateGeneratedContent({
      content: output,
      placeName,
      regionTokens,
      verifiedInternalPaths,
      // 자기 자신(같은 장소)의 기존 공개본은 반복도 비교에서 제외한다.
      recentPages: recentPages.filter((page) => page.placeName !== placeName),
      faqSelection: (generation.input as AiGenerationInput | null)?.content_plan?.faq_selection ?? null,
    })
    await attachGenerationQuality(generationId, quality)
    return quality
  } catch (error) {
    console.error("[content-quality] evaluation failed", { generationId, error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

async function evaluateAndAttachQualitySafely(generationId: string): Promise<void> {
  await evaluateGenerationQuality(generationId)
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

  const [{ createSupabasePlacePublishRepository }, { publishPlacePage }] = await Promise.all([
    import("@/lib/seo-pages/supabase-place-publish"),
    import("@/lib/seo-pages/place-publish"),
  ])

  let notice: AdminPlacesNotice = "publish-failed"
  try {
    const result = await publishPlacePage(createSupabasePlacePublishRepository(), placeId)
    if (result.kind === "published" || result.kind === "already-published") {
      // DB 게시 + revalidate 성공이면 즉시 성공으로 알린다. 공개 URL 확인은 응답 이후 after()에서 비동기 실행되어
      // seo_pages.verification_*에만 기록된다 (13·14호점 확인 지연 오탐의 구조적 해결). cache-refresh-failed는 revalidate 자체 실패 전용.
      const revalidated = revalidatePublicPlacePaths(result.path)
      if (revalidated) {
        await schedulePublishVerificationSafely(result.path)
        notice = result.kind === "published" ? "published" : "already-published"
      } else {
        notice = "cache-refresh-failed"
      }
    } else {
      notice = result.kind === "unexpected" ? "publish-failed" : "publish-blocked"
    }
  } catch {
    notice = "publish-failed"
  }

  // after() 등록은 위에서 이미 끝났으므로 redirect(NEXT_REDIRECT throw)가 안전하다.
  redirect(buildNoticeHref(backParams, placeId, notice))
}

// 공개 URL 비동기 검증 예약 — 검증 예약이 실패해도 게시 성공 알림은 유지한다 (migration 미적용 등).
async function schedulePublishVerificationSafely(path: string | null): Promise<void> {
  if (path?.startsWith("/places/") !== true) {
    return
  }
  try {
    const [{ schedulePostPublishVerification }, { createSupabaseVerificationRepository }, { getSiteUrl }] = await Promise.all([
      import("@/lib/seo-pages/publish-verification"),
      import("@/lib/seo-pages/supabase-verification"),
      import("@/lib/site-url"),
    ])
    await schedulePostPublishVerification({
      path,
      url: `${getSiteUrl()}${path}`,
      repository: createSupabaseVerificationRepository(),
      registerAfter: after,
    })
  } catch (error) {
    console.error("[publish-verification] failed to schedule verification", { path, error: error instanceof Error ? error.message : String(error) })
  }
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
