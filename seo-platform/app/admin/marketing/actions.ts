"use server"

import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { isAllowedAdminEmail } from "@/lib/auth/admin-middleware"
import { contentModeForCategory, type ContentMode } from "@/lib/ai/content-mode"
import type { MarketingService, ServiceResult } from "@/lib/marketing/marketing-service"
import type { MetricObservation } from "@/lib/marketing/repository"
import type { MarketingMetricSource, OrderDestinationCode } from "@/lib/marketing/types"
import type { Database } from "@/types/database"

// 광고 배포 관리자 액션 — 버튼 하나가 marketing-service 함수 하나를 부른다.
// 여기서는 입력을 읽고, 관리자 확인을 하고, 결과를 안내 문구 코드로 바꿔 화면으로 돌려보낸다.
// 외부 채널에 직접 게시하는 동작은 없다. 사람이 글을 올리고 그 주소를 기록하는 흐름이다.

const UUID = /^[0-9a-fA-F-]{36}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const MODES: readonly ContentMode[] = ["condolence", "celebration", "corporate-celebration"]
const METRIC_SOURCES: readonly MarketingMetricSource[] = ["smartstore_report", "imweb_report", "naver_ads_report", "google_ads_report", "manual"]

function text(formData: FormData, key: string): string {
  const value = formData.get(key)
  return typeof value === "string" ? value.trim() : ""
}

function destinationOf(value: string): OrderDestinationCode | undefined {
  return value === "imweb" || value === "smartstore" ? value : undefined
}

function modeOf(value: string): ContentMode | null {
  return MODES.find((mode) => mode === value) ?? contentModeForCategory(value)
}

// 빈 칸은 "수집하지 못함"(null). 0으로 바꾸지 않는다.
function optionalCount(formData: FormData, key: string): number | null | "invalid" {
  const raw = text(formData, key).replaceAll(",", "")
  if (raw.length === 0) {
    return null
  }
  return /^\d{1,12}$/.test(raw) ? Number(raw) : "invalid"
}

function campaignPath(campaignId: string): string {
  return UUID.test(campaignId) ? `/admin/marketing/${campaignId}` : "/admin/marketing"
}

function withQuery(path: string, key: "notice" | "error", code: string, anchor?: string): string {
  return `${path}?${key}=${encodeURIComponent(code)}${anchor === undefined ? "" : `#${anchor}`}`
}

async function service(): Promise<MarketingService> {
  const [{ createMarketingService }, { createSupabaseMarketingRepository }] = await Promise.all([import("@/lib/marketing/marketing-service"), import("@/lib/marketing/supabase-repository")])
  return createMarketingService(createSupabaseMarketingRepository())
}

// 서비스 호출 중 예외(테이블 미생성·DB 오류)를 그대로 던지면 화면에는 전송 실패로만 보인다.
// 서버에서 잡아 사유 코드로 돌려보낸다.
async function attempt<T>(path: string, label: string, run: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
  try {
    return await run()
  } catch (error) {
    console.error(`[marketing] ${label} failed`, { message: error instanceof Error ? error.message : String(error) })
    redirect(withQuery(path, "error", "server"))
  }
}

export async function createCampaignAction(formData: FormData): Promise<never> {
  const actor = await ensureMarketingActionAllowed("/admin/marketing")
  const mode = modeOf(text(formData, "mode"))
  if (mode === null || text(formData, "name").length === 0) {
    redirect(withQuery("/admin/marketing", "error", "campaign-input"))
  }
  const productUrls: Partial<Record<OrderDestinationCode, string>> = {}
  for (const destination of ["imweb", "smartstore"] as const) {
    const url = text(formData, `productUrl_${destination}`)
    if (url.length > 0) {
      productUrls[destination] = url
    }
  }
  const marketing = await service()
  const result = await attempt("/admin/marketing", "create campaign", () =>
    marketing.createCampaign({ code: text(formData, "code"), name: text(formData, "name"), mode, region: text(formData, "region") || null, productUrls, actor }),
  )
  if (!result.ok) {
    redirect(withQuery("/admin/marketing", "error", result.reason))
  }
  redirect(withQuery(`/admin/marketing/${result.campaign.id}`, "notice", "campaign-created"))
}

export async function updateProductUrlsAction(formData: FormData): Promise<never> {
  const campaignId = text(formData, "campaignId")
  const path = campaignPath(campaignId)
  const actor = await ensureMarketingActionAllowed(path)
  const productUrls: Partial<Record<OrderDestinationCode, string>> = {}
  for (const destination of ["imweb", "smartstore"] as const) {
    const url = text(formData, `productUrl_${destination}`)
    if (url.length > 0) {
      productUrls[destination] = url
    }
  }
  const marketing = await service()
  const result = await attempt(path, "update product urls", () => marketing.updateCampaignProductUrls({ campaignId, productUrls, actor }))
  if (!result.ok) {
    redirect(withQuery(path, "error", result.reason, "product-urls"))
  }
  redirect(`${path}?notice=product-urls-saved&relinked=${String(result.relinked)}&kept=${String(result.keptPosted)}&pending=${String(result.pending)}#product-urls`)
}

// AI로 초안 만들기 — 광고 전용 AI 설정(MARKETING_AI_PROVIDER)이 켜져 있을 때만 호출한다.
export async function generateDraftAction(formData: FormData): Promise<never> {
  const campaignId = text(formData, "campaignId")
  const path = campaignPath(campaignId)
  const actor = await ensureMarketingActionAllowed(path)
  const [{ resolveMarketingAiSelection, createOpenAiMarketingProvider }, { createDraftGenerator }, { createMarketingService }, { createSupabaseMarketingRepository }] = await Promise.all([
    import("@/lib/marketing/ai/provider"),
    import("@/lib/marketing/ai/draft-service"),
    import("@/lib/marketing/marketing-service"),
    import("@/lib/marketing/supabase-repository"),
  ])
  const selection = resolveMarketingAiSelection({
    MARKETING_AI_PROVIDER: process.env["MARKETING_AI_PROVIDER"],
    OPENAI_API_KEY: process.env["OPENAI_API_KEY"],
    OPENAI_MODEL: process.env["OPENAI_MODEL"],
  })
  if (selection.kind !== "openai") {
    redirect(withQuery(path, "error", "ai-disabled", "ai-draft"))
  }
  const repo = createSupabaseMarketingRepository()
  const generator = createDraftGenerator({ repo, marketing: createMarketingService(repo), provider: createOpenAiMarketingProvider({ apiKey: selection.apiKey, model: selection.model }) })
  let result: Awaited<ReturnType<typeof generator.generateDraft>>
  try {
    result = await generator.generateDraft({ campaignId, channel: text(formData, "channel"), requestKey: text(formData, "requestKey"), actor })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[marketing] generate draft failed", { message })
    // 생성 기록 테이블이 아직 없으면 그 사실을 알려 준다
    redirect(withQuery(path, "error", message.includes("marketing_generations") || message.includes("reserve_marketing_generation") ? "generations-missing" : "server", "ai-draft"))
  }
  if (!result.ok) {
    redirect(withQuery(path, "error", result.reason, "ai-draft"))
  }
  redirect(withQuery(path, "notice", result.qualityStatus === "fail" ? "draft-generated-fail" : "draft-generated", `variant-${result.variant.id}`))
}

export async function createVariantAction(formData: FormData): Promise<never> {
  const campaignId = text(formData, "campaignId")
  const path = campaignPath(campaignId)
  const actor = await ensureMarketingActionAllowed(path)
  const destination = destinationOf(text(formData, "destination"))
  const marketing = await service()
  const result = await attempt(path, "create variant", () =>
    marketing.createVariant({
      campaignId,
      code: text(formData, "code"),
      channel: text(formData, "channel"),
      copy: { title: text(formData, "title"), body: text(formData, "body"), caption: text(formData, "caption") },
      actor,
      ...(destination === undefined ? {} : { destination }),
    }),
  )
  if (!result.ok) {
    redirect(withQuery(path, "error", result.reason, "new-variant"))
  }
  redirect(withQuery(path, "notice", "variant-created", `variant-${result.variant.id}`))
}

export async function reviseVariantAction(formData: FormData): Promise<never> {
  const path = campaignPath(text(formData, "campaignId"))
  const actor = await ensureMarketingActionAllowed(path)
  const variantId = text(formData, "variantId")
  const destination = destinationOf(text(formData, "destination"))
  const marketing = await service()
  const result = await attempt(path, "revise variant", () =>
    marketing.reviseVariant({
      campaignId: text(formData, "campaignId"),
      variantId,
      expectedRevision: Number(text(formData, "revision")),
      copy: { title: text(formData, "title"), body: text(formData, "body"), caption: text(formData, "caption") },
      actor,
      ...(destination === undefined ? {} : { destination }),
    }),
  )
  redirect(withQuery(path, result.ok ? "notice" : "error", result.ok ? "variant-revised" : result.reason, `variant-${variantId}`))
}

export async function requestReviewAction(formData: FormData): Promise<never> {
  const path = campaignPath(text(formData, "campaignId"))
  const actor = await ensureMarketingActionAllowed(path)
  const variantId = text(formData, "variantId")
  const marketing = await service()
  const result = await attempt(path, "request review", () => marketing.requestReview({ campaignId: text(formData, "campaignId"), variantId, expectedRevision: Number(text(formData, "revision")), actor }))
  redirect(withQuery(path, result.ok ? "notice" : "error", result.ok ? "review-passed" : result.reason, `variant-${variantId}`))
}

export async function approveVariantAction(formData: FormData): Promise<never> {
  const path = campaignPath(text(formData, "campaignId"))
  const actor = await ensureMarketingActionAllowed(path)
  const variantId = text(formData, "variantId")
  // 사람이 내용을 읽고 확인했다는 체크가 있어야 승인한다
  if (formData.get("reviewed") !== "on") {
    redirect(withQuery(path, "error", "not-reviewed", `variant-${variantId}`))
  }
  const marketing = await service()
  const result = await attempt(path, "approve", () => marketing.approve({ campaignId: text(formData, "campaignId"), variantId, expectedRevision: Number(text(formData, "revision")), actor }))
  redirect(withQuery(path, result.ok ? "notice" : "error", result.ok ? "approved" : result.reason, `variant-${variantId}`))
}

export async function exportVariantAction(formData: FormData): Promise<never> {
  const path = campaignPath(text(formData, "campaignId"))
  const actor = await ensureMarketingActionAllowed(path)
  const variantId = text(formData, "variantId")
  const marketing = await service()
  const result = await attempt(path, "export", () => marketing.exportForPosting({ campaignId: text(formData, "campaignId"), variantId, expectedRevision: Number(text(formData, "revision")), actor }))
  redirect(withQuery(path, result.ok ? "notice" : "error", result.ok ? "exported" : result.reason, `variant-${variantId}`))
}

export async function confirmPostedAction(formData: FormData): Promise<never> {
  const path = campaignPath(text(formData, "campaignId"))
  const actor = await ensureMarketingActionAllowed(path)
  const variantId = text(formData, "variantId")
  const marketing = await service()
  const result = await attempt(path, "confirm posted", () => marketing.confirmPosted({ campaignId: text(formData, "campaignId"), variantId, jobId: text(formData, "jobId"), postedUrl: text(formData, "postedUrl"), actor }))
  redirect(withQuery(path, result.ok ? "notice" : "error", result.ok ? "confirmed" : result.reason, `variant-${variantId}`))
}

export async function saveChannelAction(formData: FormData): Promise<never> {
  await ensureMarketingActionAllowed("/admin/marketing")
  const publishMode = text(formData, "publishMode")
  const accountRef = text(formData, "accountRef")
  const marketing = await service()
  const result = await attempt("/admin/marketing", "save channel", () =>
    marketing.setChannel({
      channel: text(formData, "channel"),
      accountRef: accountRef.length === 0 ? null : accountRef,
      ...(publishMode === "manual" || publishMode === "disabled" ? { publishMode } : {}),
    }),
  )
  redirect(withQuery("/admin/marketing", result.ok ? "notice" : "error", result.ok ? "channel-saved" : result.reason, "channels"))
}

export async function recordMetricsAction(formData: FormData): Promise<never> {
  const path = "/admin/marketing/metrics"
  await ensureMarketingActionAllowed(path)
  const date = text(formData, "date")
  const source = METRIC_SOURCES.find((candidate) => candidate === text(formData, "source"))
  const counts = {
    visits: optionalCount(formData, "visits"),
    orders: optionalCount(formData, "orders"),
    revenueKrw: optionalCount(formData, "revenueKrw"),
    adCostKrw: optionalCount(formData, "adCostKrw"),
    workMinutes: optionalCount(formData, "workMinutes"),
  }
  const values = Object.values(counts)
  if (!DATE.test(date) || source === undefined || values.includes("invalid") || values.every((value) => value === null)) {
    redirect(withQuery(path, "error", "metrics-input"))
  }
  const number = (value: number | null | "invalid"): number | null => (value === "invalid" ? null : value)
  const variantId = text(formData, "variantId")
  const campaignId = text(formData, "campaignId")
  const channel = text(formData, "channel")
  const destination = destinationOf(text(formData, "destination"))
  const { isMarketingChannelCode } = await import("@/lib/marketing/channel-policy")
  const observation: MetricObservation = {
    date,
    source,
    channelCode: isMarketingChannelCode(channel) ? channel : null,
    campaignId: UUID.test(campaignId) ? campaignId : null,
    variantId: UUID.test(variantId) ? variantId : null,
    destinationCode: destination ?? null,
    visits: number(counts.visits),
    orders: number(counts.orders),
    revenueKrw: number(counts.revenueKrw),
    adCostKrw: number(counts.adCostKrw),
    workMinutes: number(counts.workMinutes),
    attributionNote: text(formData, "note") || null,
  }
  const marketing = await service()
  try {
    await marketing.recordMetrics([observation])
  } catch (error) {
    console.error("[marketing] record metrics failed", { message: error instanceof Error ? error.message : String(error) })
    redirect(withQuery(path, "error", "server"))
  }
  redirect(withQuery(path, "notice", "metrics-saved"))
}

// 기존 batch 액션과 동일한 보호 계약 — 환경 변수 + 로그인 세션 + 관리자 이메일 허용목록.
// (use server 파일은 액션 외 export가 불가해 헬퍼를 공유하지 못하므로 같은 구현을 둔다. 인증 모듈 자체는 수정하지 않는다.)
async function ensureMarketingActionAllowed(returnPath: string): Promise<string> {
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
  const email = data.user?.email ?? null
  if (error !== null || email === null || !isAllowedAdminEmail(email, process.env["ADMIN_EMAIL_ALLOWLIST"])) {
    redirect(`/login?next=${encodeURIComponent(returnPath)}`)
  }
  return email
}
