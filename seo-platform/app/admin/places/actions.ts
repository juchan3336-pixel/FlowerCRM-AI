"use server"

import { createServerClient } from "@supabase/ssr"
import { revalidatePath } from "next/cache"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { generateAiPreview, applyAiGeneration } from "@/lib/ai/service"
import { FakeDeterministicAiProvider } from "@/lib/ai/fake-provider"
import { isAllowedAdminEmail } from "@/lib/auth/admin-middleware"
import { buildAdminPlacesHref, resolveAdminPlacesWorkspaceParams, type AdminPlacesNotice } from "@/lib/admin/places-url"
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
  await ensureAdminActionAllowed()

  const [{ createSupabaseAiRepository }] = await Promise.all([import("@/lib/ai/supabase-repository")])
  try {
    await generateAiPreview({
      placeId,
      provider: new FakeDeterministicAiProvider(),
      repository: createSupabaseAiRepository(),
    })
  } catch {
    redirect(buildNoticeHref(backParams, placeId, "ai-error"))
  }

  redirect(buildNoticeHref(backParams, placeId, "ai-generated", true))
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
  await ensureAdminActionAllowed()

  const [{ createSupabasePlacePublishRepository }, { publishPlacePage }] = await Promise.all([
    import("@/lib/seo-pages/supabase-place-publish"),
    import("@/lib/seo-pages/place-publish"),
  ])

  let notice: AdminPlacesNotice = "publish-failed"
  try {
    const result = await publishPlacePage(createSupabasePlacePublishRepository(), placeId)
    if (result.kind === "published" || result.kind === "already-published") {
      revalidatePublicPlacePaths(result.path)
    }
    notice =
      result.kind === "published" ? "published" : result.kind === "already-published" ? "already-published" : result.kind === "unexpected" ? "publish-failed" : "publish-blocked"
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
  await ensureAdminActionAllowed()

  const [{ createSupabasePlacePublishRepository }, { archivePlacePage }] = await Promise.all([
    import("@/lib/seo-pages/supabase-place-publish"),
    import("@/lib/seo-pages/place-publish"),
  ])

  let notice: AdminPlacesNotice = "archive-failed"
  try {
    const result = await archivePlacePage(createSupabasePlacePublishRepository(), placeId)
    if (result.kind === "archived") {
      revalidatePublicPlacePaths(result.path)
    }
    notice = result.kind === "archived" ? "archived" : result.kind === "unexpected" ? "archive-failed" : "archive-blocked"
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
  await ensureAdminActionAllowed()

  const [{ createSupabasePlacePublishRepository }, { restorePlacePage }] = await Promise.all([
    import("@/lib/seo-pages/supabase-place-publish"),
    import("@/lib/seo-pages/place-publish"),
  ])

  let notice: AdminPlacesNotice = "restore-failed"
  try {
    const result = await restorePlacePage(createSupabasePlacePublishRepository(), placeId)
    notice = result.kind === "restored" ? "restored" : result.kind === "unexpected" ? "restore-failed" : "restore-blocked"
  } catch {
    notice = "restore-failed"
  }

  redirect(buildNoticeHref(backParams, placeId, notice))
}

function revalidatePublicPlacePaths(path: string | null): void {
  if (path?.startsWith("/places/") === true) {
    revalidatePath(path)
  }
  revalidatePath("/sitemap.xml")
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
