import { readFileSync } from "node:fs"
import { join } from "node:path"

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { MarketingCampaignContent } from "@/app/admin/marketing/[campaignId]/page"
import type { ContentMode } from "@/lib/ai/content-mode"
import { evaluateAdCopy } from "@/lib/marketing/ad-quality"
import { failureMessage, loadCampaignDetail } from "@/lib/marketing/admin-view"
import { createDraftGenerator, GENERATION_CAPS, MAX_RESERVE_PER_DRAFT_USD } from "@/lib/marketing/ai/draft-service"
import {
  actualCostUsd,
  buildCopyMessages,
  createOpenAiMarketingProvider,
  MarketingAiError,
  MAX_OUTPUT_TOKENS,
  parseCopyContent,
  resolveMarketingAiSelection,
  worstCaseDraftCostUsd,
  type CopyRequest,
  type MarketingCopyProvider,
} from "@/lib/marketing/ai/provider"
import { listDraftTopics, pickDraftTopic } from "@/lib/marketing/ai/topics"
import { createInMemoryMarketingRepository } from "@/lib/marketing/in-memory-repository"
import { createMarketingService } from "@/lib/marketing/marketing-service"
import { kstPeriodStarts } from "@/lib/marketing/repository"

const ADMIN = "admin@example.com"
const MODEL = "gpt-4.1-mini"
const GOOD = {
  title: "근조화환 보내기 전에 확인할 세 가지",
  body: "갑작스러운 부고를 받으면 마음이 급해져 화환 주문에서 실수가 생기기 쉽습니다. 주문 전에 장례식장의 정식 명칭과 빈소 호실, 상주 성함을 확인해 두시면 됩니다.\n\n리본 문구는 조의 문구와 보내는 분의 소속과 성함을 적습니다. 도착 시점은 주문 과정에서 확인하실 수 있습니다.",
  caption: "근조화환 주문 준비 안내",
}
const BAD = { title: "근조화환 당일 배송 보장", body: "결혼을 축하합니다. 전국 최저가로 보내드립니다.", caption: "" }
const USAGE = { inputTokens: 600, outputTokens: 400 }

// 정해진 응답을 순서대로 돌려주는 가짜 생성기 — 실제 네트워크 호출이 없다
function scripted(responses: readonly (typeof GOOD | Error)[]): MarketingCopyProvider & { readonly requests: CopyRequest[] } {
  const requests: CopyRequest[] = []
  let index = 0
  return {
    model: MODEL,
    requests,
    generate(request) {
      requests.push(request)
      const next = responses[index]
      index += 1
      if (next === undefined) {
        return Promise.reject(new Error("no scripted response left"))
      }
      return next instanceof Error ? Promise.reject(next) : Promise.resolve({ copy: next, usage: USAGE })
    },
  }
}

async function setup(provider: MarketingCopyProvider | null, nowIso = "2026-11-10T03:00:00.000Z") {
  let tick = 0
  const now = () => new Date(new Date(nowIso).getTime() + 1000 * tick++).toISOString()
  const repo = createInMemoryMarketingRepository(now)
  const marketing = createMarketingService(repo, now)
  const campaign = await marketing.createCampaign({ code: "condolence-guide-01", name: "근조 주문 준비 안내", mode: "condolence", actor: ADMIN })
  if (!campaign.ok) {
    throw new Error("campaign expected")
  }
  const generator = createDraftGenerator({ repo, marketing, provider, now })
  const draft = (requestKey: string, channel = "naver_blog") => generator.generateDraft({ campaignId: campaign.campaign.id, channel, requestKey, actor: ADMIN })
  return { repo, marketing, id: campaign.campaign.id, draft }
}

describe("광고 전용 AI 설정", () => {
  it("MARKETING_AI_PROVIDER가 openai일 때만 켜지고, 장소 페이지용 AI_PROVIDER와는 무관하다", () => {
    expect(resolveMarketingAiSelection({})).toEqual({ kind: "disabled" })
    expect(resolveMarketingAiSelection({ MARKETING_AI_PROVIDER: "fake", OPENAI_API_KEY: "k", OPENAI_MODEL: MODEL })).toEqual({ kind: "disabled" })
    // AI_PROVIDER=openai만으로는 광고 생성이 켜지지 않는다
    expect(resolveMarketingAiSelection({ AI_PROVIDER: "openai", OPENAI_API_KEY: "k", OPENAI_MODEL: MODEL } as never)).toEqual({ kind: "disabled" })
    expect(resolveMarketingAiSelection({ MARKETING_AI_PROVIDER: " OpenAI ", OPENAI_API_KEY: "k", OPENAI_MODEL: MODEL })).toEqual({ kind: "openai", apiKey: "k", model: MODEL })
  })

  it("키·모델이 빠졌거나 단가를 모르는 모델이면 켜지지 않는다", () => {
    expect(resolveMarketingAiSelection({ MARKETING_AI_PROVIDER: "openai", OPENAI_MODEL: MODEL })).toEqual({ kind: "misconfigured", reason: "api-key-missing" })
    expect(resolveMarketingAiSelection({ MARKETING_AI_PROVIDER: "openai", OPENAI_API_KEY: "k" })).toEqual({ kind: "misconfigured", reason: "model-missing" })
    expect(resolveMarketingAiSelection({ MARKETING_AI_PROVIDER: "openai", OPENAI_API_KEY: "k", OPENAI_MODEL: "some-new-model" })).toEqual({ kind: "misconfigured", reason: "model-price-unknown" })
    expect(resolveMarketingAiSelection({ MARKETING_AI_PROVIDER: "openai", OPENAI_API_KEY: "k", OPENAI_MODEL: "toString" })).toEqual({ kind: "misconfigured", reason: "model-price-unknown" })
  })

  it("초안 한 편의 최악 비용은 허용 범위 안이고, 실제 비용은 사용량으로 계산한다", () => {
    const worst = worstCaseDraftCostUsd(MODEL)
    expect(worst).toBeGreaterThan(0)
    expect(worst).toBeLessThanOrEqual(MAX_RESERVE_PER_DRAFT_USD)
    expect(worstCaseDraftCostUsd("unknown-model")).toBeNull()
    expect(actualCostUsd(MODEL, { inputTokens: 1000, outputTokens: 1000 })).toBe(0.002)
    expect(actualCostUsd(MODEL, null)).toBeNull()
    // 최악 비용 = 2회 × (입력 2,500 + 출력 900 토큰)
    expect(worstCaseDraftCostUsd(MODEL)).toBe(0.00488)
  })
})

describe("프롬프트와 응답 해석", () => {
  it.each(["condolence", "celebration", "corporate-celebration"] as const)("%s 프롬프트에 금지 규칙과 모드 지침이 들어간다", (mode: ContentMode) => {
    const [system, user] = buildCopyMessages({ mode, channel: "naver_blog", topic: "주제", region: "경남", avoidTitles: ["이미 쓴 제목"] })
    expect(system?.content).toContain("가격")
    expect(system?.content).toContain("당일 배송")
    expect(system?.content).toContain(mode === "condolence" ? "축하·경사 표현" : "장례 관련 표현")
    expect(user?.content).toContain("지역: 경남")
    expect(user?.content).toContain("- 이미 쓴 제목")
  })

  it("보정 요청에는 걸린 사유와 이전 초안이 실린다", () => {
    const messages = buildCopyMessages({ mode: "condolence", channel: "naver_blog", topic: "주제", region: null, avoidTitles: [], fixIssues: ["가격·요금 표현 금지"], previous: BAD })
    expect(messages[1]?.content).toContain("반려 사유")
    expect(messages[1]?.content).toContain("가격·요금 표현 금지")
    expect(messages[1]?.content).toContain(BAD.title)
    expect(messages[1]?.content).not.toContain("지역:")
  })

  it("약속한 형식이 아니면 받아들이지 않는다", () => {
    expect(parseCopyContent(JSON.stringify(GOOD))).toEqual(GOOD)
    expect(parseCopyContent(JSON.stringify({ title: " 제목 ", body: " 본문 " }))).toEqual({ title: "제목", body: "본문", caption: "" })
    for (const bad of ["not json", "[]", JSON.stringify({ title: "제목" }), JSON.stringify({ title: "", body: "본문" }), JSON.stringify({ title: 1, body: "본문" })]) {
      expect(parseCopyContent(bad), bad).toBeNull()
    }
  })

  it("주제 프롬프트 자체가 그 모드의 금지 어휘를 담고 있지 않다", () => {
    for (const mode of ["condolence", "celebration", "corporate-celebration"] as const) {
      for (const topic of listDraftTopics(mode)) {
        const report = evaluateAdCopy({ mode, copy: { title: topic.prompt, body: topic.prompt } })
        expect(report.issues.filter((issue) => issue.code.startsWith("forbidden-mode-") || issue.code.startsWith("ad-mode-mix")), `${mode}/${topic.key}`).toEqual([])
        expect(topic.key).toMatch(/^[a-z0-9-]+$/)
      }
    }
  })

  it("덜 쓴 주제부터 고른다", () => {
    const topics = listDraftTopics("condolence")
    expect(pickDraftTopic("condolence", []).key).toBe(topics[0]?.key)
    expect(pickDraftTopic("condolence", [topics[0]?.key ?? ""]).key).toBe(topics[1]?.key)
    // 한 바퀴 돌면 처음으로
    expect(pickDraftTopic("condolence", topics.map((topic) => topic.key)).key).toBe(topics[0]?.key)
  })
})

describe("OpenAI 호출 (가짜 fetch)", () => {
  const request: CopyRequest = { mode: "condolence", channel: "naver_blog", topic: "주제", region: null, avoidTitles: [] }
  const okBody = { choices: [{ message: { content: JSON.stringify(GOOD) } }], usage: { prompt_tokens: 600, completion_tokens: 400 } }

  it("모델·출력 상한·JSON 형식을 지정해 호출하고 사용량을 돌려준다", async () => {
    const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = []
    const fetchImpl: typeof fetch = (url, init) => {
      const rawBody = init?.body
      calls.push({ url: typeof url === "string" ? url : "", body: JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as Record<string, unknown>, auth: new Headers(init?.headers).get("authorization") })
      return Promise.resolve(new Response(JSON.stringify(okBody), { status: 200 }))
    }
    const result = await createOpenAiMarketingProvider({ apiKey: "sk-test", model: MODEL, fetchImpl }).generate(request)
    expect(result).toEqual({ copy: GOOD, usage: USAGE })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ url: "https://api.openai.com/v1/chat/completions", auth: "Bearer sk-test", body: { model: MODEL, max_tokens: MAX_OUTPUT_TOKENS, response_format: { type: "json_object" } } })
  })

  it("오류 종류를 구분한다 — 거절(http), 형식 오류(parse), 응답 없음(timeout)", async () => {
    const provider = (fetchImpl: typeof fetch) => createOpenAiMarketingProvider({ apiKey: "k", model: MODEL, fetchImpl, timeoutMs: 20 })
    await expect(provider(() => Promise.resolve(new Response("{}", { status: 401 }))).generate(request)).rejects.toMatchObject({ code: "http" })
    await expect(provider(() => Promise.resolve(new Response("not json", { status: 200 }))).generate(request)).rejects.toMatchObject({ code: "parse" })
    await expect(
      provider(() => Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }), { status: 200 }))).generate(request),
    ).rejects.toMatchObject({ code: "parse", usage: { inputTokens: 5, outputTokens: 2 } })
    await expect(provider(() => Promise.reject(new Error("network down"))).generate(request)).rejects.toMatchObject({ code: "timeout" })
    // 응답이 끝내 오지 않으면 시간 초과로 끊는다
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"))
        })
      })
    await expect(provider(hanging).generate(request)).rejects.toMatchObject({ code: "timeout" })
  })

  it("오류 메시지에 키나 응답 본문을 싣지 않는다", async () => {
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({ error: { message: "Incorrect API key provided: sk-secret" } }), { status: 401 }))
    const error = await createOpenAiMarketingProvider({ apiKey: "sk-secret", model: MODEL, fetchImpl })
      .generate(request)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MarketingAiError)
    expect(String(error)).not.toContain("sk-secret")
  })
})

describe("AI로 초안 만들기", () => {
  it("버튼 한 번으로 글이 만들어져 검수 대기에 올라오고, 비용이 정산된다", async () => {
    const provider = scripted([GOOD])
    const { repo, id, draft } = await setup(provider)
    const result = await draft("11111111-aaaa-4bbb-8ccc-000000000001")
    if (!result.ok) {
      throw new Error(`draft expected: ${result.reason}`)
    }
    expect(result).toMatchObject({ qualityStatus: "pass", repaired: false })
    expect(result.variant).toMatchObject({ title: GOOD.title, review_status: "needs_review", channel_code: "naver_blog", destination_code: "smartstore", code: "ai-261110-111111" })
    expect(result.variant.order_url).toContain("nt_detail=condolence-guide-01.ai-261110-111111")
    // 승인은 사람이 한다 — 자동 승인·자동 내보내기 없음
    expect(await repo.listJobs(result.variant.id)).toEqual([])

    const [generation] = await repo.listGenerations(id, 10)
    expect(generation).toMatchObject({ status: "succeeded", call_count: 1, variant_id: result.variant.id, quality_status: "pass", input_tokens: 600, output_tokens: 400, actual_usd: 0.00088, model: MODEL })
    expect(provider.requests[0]).toMatchObject({ mode: "condolence", channel: "naver_blog", region: null })
  })

  it("품질 검사에 걸리면 사유를 넘겨 한 번만 다시 쓰게 한다", async () => {
    const provider = scripted([BAD, GOOD])
    const { repo, id, draft } = await setup(provider)
    const result = await draft("22222222-aaaa-4bbb-8ccc-000000000002")
    expect(result).toMatchObject({ ok: true, qualityStatus: "pass", repaired: true, variant: { title: GOOD.title, review_status: "needs_review" } })
    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[1]?.previous).toEqual(BAD)
    expect(provider.requests[1]?.fixIssues?.join(" ")).toContain("배송 확정·보장 표현 금지")
    expect((await repo.listGenerations(id, 10))[0]).toMatchObject({ status: "succeeded", call_count: 2, input_tokens: 1200, output_tokens: 800 })
  })

  it("보정 뒤에도 걸리면 작성 중으로 저장하고 더 부르지 않는다", async () => {
    const provider = scripted([BAD, BAD, GOOD])
    const { repo, id, draft } = await setup(provider)
    const result = await draft("33333333-aaaa-4bbb-8ccc-000000000003")
    expect(result).toMatchObject({ ok: true, qualityStatus: "fail", repaired: true, variant: { review_status: "draft" } })
    expect(provider.requests).toHaveLength(2)
    const stored = result.ok ? await repo.findVariant(result.variant.id) : null
    expect(JSON.stringify(stored?.quality_report)).toContain("delivery-guarantee")
    expect((await repo.listGenerations(id, 10))[0]).toMatchObject({ status: "succeeded", quality_status: "fail", call_count: 2 })
  })

  it("응답을 받지 못하면 결과 불명으로 닫고 다시 부르지 않으며, 예약 금액 전체가 예산에서 빠진다", async () => {
    const provider = scripted([new MarketingAiError("timeout", "no response"), GOOD])
    const { repo, id, draft } = await setup(provider)
    expect(await draft("44444444-aaaa-4bbb-8ccc-000000000004")).toEqual({ ok: false, reason: "ai-unknown" })
    expect(provider.requests).toHaveLength(1)
    expect(await repo.listVariants(id)).toEqual([])
    expect((await repo.listGenerations(id, 10))[0]).toMatchObject({ status: "unknown", actual_usd: null, variant_id: null, error_code: "ai-timeout", call_count: 1 })
  })

  it("제공자가 거절하거나 형식이 틀리면 실패로 닫는다", async () => {
    const provider = scripted([new MarketingAiError("http", "status 401"), new MarketingAiError("parse", "missing", { inputTokens: 100, outputTokens: 50 })])
    const { repo, id, draft } = await setup(provider)
    expect(await draft("55555555-aaaa-4bbb-8ccc-000000000005")).toEqual({ ok: false, reason: "ai-failed" })
    expect(await draft("55555555-aaaa-4bbb-8ccc-000000000006")).toEqual({ ok: false, reason: "ai-failed" })
    const rows = await repo.listGenerations(id, 10)
    expect(rows.map((row) => row.status)).toEqual(["failed", "failed"])
    expect(rows.find((row) => row.error_code === "ai-http")).toMatchObject({ actual_usd: 0 })
    expect(rows.find((row) => row.error_code === "ai-parse")).toMatchObject({ input_tokens: 100, output_tokens: 50 })
    expect(await repo.listVariants(id)).toEqual([])
  })

  it("같은 요청 키는 한 번만 처리한다 (버튼 두 번 누름)", async () => {
    const provider = scripted([GOOD, GOOD])
    const { repo, id, draft } = await setup(provider)
    const key = "66666666-aaaa-4bbb-8ccc-000000000007"
    expect((await draft(key)).ok).toBe(true)
    expect(await draft(key)).toEqual({ ok: false, reason: "duplicate" })
    expect(provider.requests).toHaveLength(1)
    expect(await repo.listVariants(id)).toHaveLength(1)
  })

  it("하루 건수 상한을 넘으면 호출하지 않는다 — 실패한 건도 센다", async () => {
    const failures = Array.from({ length: GENERATION_CAPS.dailyCount }, () => new MarketingAiError("http", "status 500"))
    const provider = scripted([...failures, GOOD])
    const { draft } = await setup(provider)
    for (let index = 0; index < GENERATION_CAPS.dailyCount; index += 1) {
      expect(await draft(`77777777-aaaa-4bbb-8ccc-0000000001${String(index).padStart(2, "0")}`)).toEqual({ ok: false, reason: "ai-failed" })
    }
    expect(await draft("77777777-aaaa-4bbb-8ccc-000000000199")).toEqual({ ok: false, reason: "cap-daily-count" })
    expect(provider.requests).toHaveLength(GENERATION_CAPS.dailyCount)
  })

  it("금액 상한은 정산된 금액과 결과 불명 건의 예약 금액을 합쳐 판정한다", async () => {
    const repo = createInMemoryMarketingRepository(() => "2026-11-10T03:00:00.000Z")
    const marketing = createMarketingService(repo)
    const campaign = await marketing.createCampaign({ code: "c1", name: "c", mode: "condolence", actor: ADMIN })
    if (!campaign.ok) {
      throw new Error("campaign expected")
    }
    const reserve = (requestKey: string, reserveUsd: number, caps = { dailyCount: 100, dailyUsd: 0.1, monthlyUsd: 0.15 }) =>
      repo.reserveGeneration({ campaignId: campaign.campaign.id, channelCode: "naver_blog", requestKey, topicKey: "t", model: MODEL, reserveUsd, caps, createdBy: ADMIN })

    const first = await reserve("key-00000001", 0.04)
    const second = await reserve("key-00000002", 0.04)
    if (first.kind !== "reserved" || second.kind !== "reserved") {
      throw new Error("reservations expected")
    }
    // 0.04 + 0.04 예약 중 → 0.04를 더 잡으면 하루 0.1을 넘는다
    expect(await reserve("key-00000003", 0.04)).toEqual({ kind: "cap", cap: "daily-usd" })
    // 첫 건이 실제 0.001로 정산되면 여유가 생긴다
    expect(await repo.settleGeneration(first.id, { status: "succeeded", actualUsd: 0.001, inputTokens: 1, outputTokens: 1, callCount: 1, variantId: null })).toBe(true)
    // 이미 정산된 건은 다시 정산되지 않는다
    expect(await repo.settleGeneration(first.id, { status: "failed", actualUsd: 9, inputTokens: null, outputTokens: null, callCount: 1 })).toBe(false)
    // 둘째 건이 결과 불명이면 예약 금액 0.04가 그대로 남는다 → 0.001 + 0.04 + 0.04 = 0.081
    await repo.settleGeneration(second.id, { status: "unknown", actualUsd: null, inputTokens: null, outputTokens: null, callCount: 1 })
    expect((await reserve("key-00000004", 0.04)).kind).toBe("reserved")
    // 월 상한 0.12: 0.001(정산) + 0.04(불명) + 0.04(예약 중) + 0.04 = 0.121 > 0.12
    expect(await reserve("key-00000005", 0.04, { dailyCount: 100, dailyUsd: 10, monthlyUsd: 0.12 })).toEqual({ kind: "cap", cap: "monthly-usd" })
    // 상한이 그보다 넉넉하면 받는다
    expect((await reserve("key-00000006", 0.04, { dailyCount: 100, dailyUsd: 10, monthlyUsd: 0.13 })).kind).toBe("reserved")
  })

  it("상한의 하루·한 달 경계는 한국 시간 기준이다", () => {
    // 11/10 23:30 KST = 11/10 14:30 UTC
    expect(kstPeriodStarts("2026-11-10T14:30:00.000Z")).toEqual({ dayStart: "2026-11-09T15:00:00.000Z", monthStart: "2026-10-31T15:00:00.000Z" })
    // 11/11 00:30 KST = 11/10 15:30 UTC — 날짜가 바뀐다
    expect(kstPeriodStarts("2026-11-10T15:30:00.000Z").dayStart).toBe("2026-11-10T15:00:00.000Z")
    // 12/1 00:10 KST = 11/30 15:10 UTC — 달이 바뀐다
    expect(kstPeriodStarts("2026-11-30T15:10:00.000Z").monthStart).toBe("2026-11-30T15:00:00.000Z")
  })

  it("꺼져 있으면 아무것도 호출·저장하지 않는다", async () => {
    const { repo, id, draft } = await setup(null)
    expect(await draft("88888888-aaaa-4bbb-8ccc-000000000008")).toEqual({ ok: false, reason: "ai-disabled" })
    expect(await repo.listGenerations(id, 10)).toEqual([])
    expect(await repo.listVariants(id)).toEqual([])
  })

  it("없는 캠페인·지원하지 않는 채널·중지된 채널·비싼 모델은 예약 전에 거부한다", async () => {
    const provider = scripted([GOOD])
    const { repo, marketing, id, draft } = await setup(provider)
    expect(await draft("99999999-aaaa-4bbb-8ccc-000000000001", "tistory")).toEqual({ ok: false, reason: "channel-unknown" })
    await marketing.setChannel({ channel: "naver_place", publishMode: "disabled" })
    expect(await draft("99999999-aaaa-4bbb-8ccc-000000000002", "naver_place")).toEqual({ ok: false, reason: "channel-disabled" })
    const missing = createDraftGenerator({ repo, marketing, provider })
    expect(await missing.generateDraft({ campaignId: "00000000-0000-4000-8000-000000000000", channel: "naver_blog", requestKey: "99999999-aaaa-4bbb-8ccc-000000000003", actor: ADMIN })).toEqual({ ok: false, reason: "not-found" })
    // 단가를 모르는 모델은 최악 비용을 계산할 수 없어 호출하지 않는다
    const pricey = createDraftGenerator({ repo, marketing, provider: { ...provider, model: "unlisted-model" } })
    expect(await pricey.generateDraft({ campaignId: id, channel: "naver_blog", requestKey: "99999999-aaaa-4bbb-8ccc-000000000004", actor: ADMIN })).toEqual({ ok: false, reason: "ai-cost-too-high" })
    expect(provider.requests).toHaveLength(0)
    expect(await repo.listGenerations(id, 10)).toEqual([])
  })

  it("두 번째 초안은 다른 주제로, 이미 쓴 제목을 피하도록 요청한다", async () => {
    const second = { ...GOOD, title: "근조화환 리본 문구 쓰는 법", body: `${GOOD.body}\n\n회사 이름으로 보낼 때는 회사명과 대표자 성함을 함께 적습니다.` }
    const provider = scripted([GOOD, second])
    const { draft } = await setup(provider)
    await draft("aaaaaaaa-aaaa-4bbb-8ccc-000000000001")
    await draft("bbbbbbbb-aaaa-4bbb-8ccc-000000000002")
    expect(provider.requests[0]?.topic).not.toBe(provider.requests[1]?.topic)
    expect(provider.requests[1]?.avoidTitles).toContain(GOOD.title)
  })
})

describe("화면", () => {
  async function render(ai: { status: "ready" | "disabled" | "misconfigured"; requestKey: string } | undefined) {
    const { repo, id } = await setup(null)
    return renderToStaticMarkup(createElement(MarketingCampaignContent, { detail: await loadCampaignDetail(repo, id), notice: null, error: null, useSample: false, ...(ai === undefined ? {} : { ai }) }))
  }

  it("켜져 있으면 초안 만들기 버튼과 요청 키가 나온다", async () => {
    const markup = await render({ status: "ready", requestKey: "req-key-123456" })
    expect(markup).toContain("AI 초안 1편 만들기")
    expect(markup).toContain('name="requestKey" value="req-key-123456"')
    expect(markup).not.toContain("MARKETING_AI_PROVIDER")
  })

  it("꺼져 있으면 버튼 대신 설정할 환경 변수 이름을 안내한다", async () => {
    for (const status of ["disabled", "misconfigured"] as const) {
      const markup = await render({ status, requestKey: "" })
      expect(markup).not.toContain("AI 초안 1편 만들기")
      expect(markup).toContain("MARKETING_AI_PROVIDER = openai")
      expect(markup).toContain("OPENAI_MODEL = gpt-4.1-mini")
    }
    expect(await render(undefined)).toContain("AI 자동 생성이 아직 꺼져 있습니다.")
  })

  it("실패 사유마다 조치가 담긴 문구가 있다", () => {
    for (const reason of ["ai-disabled", "ai-cost-too-high", "ai-unknown", "ai-failed", "save-failed", "cap-daily-count", "cap-daily-usd", "cap-monthly-usd", "generations-missing"]) {
      expect(failureMessage(reason), reason).not.toBe("처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
    }
    expect(failureMessage("ai-unknown")).toContain("자동으로 다시 시도하지 않았습니다")
  })
})

describe("migration", () => {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/202611100002_marketing_generations.sql"), "utf8")

  it("생성 기록 테이블은 서버 전용이고 예약 함수는 공개 역할이 실행할 수 없다", () => {
    expect(sql).toContain("alter table public.marketing_generations enable row level security;")
    expect(sql).toContain("revoke all on table public.marketing_generations from anon, authenticated;")
    expect(sql).not.toMatch(/create policy/i)
    expect(sql.match(/\$\$/g)).toHaveLength(2)
    for (const role of ["public", "anon", "authenticated"]) {
      expect(sql).toContain(`numeric, numeric, text) from ${role};`)
    }
    expect(sql).toContain("pg_advisory_xact_lock")
    expect(sql).not.toMatch(/alter table public\.(places|seo_pages|batch_)/)
  })
})
