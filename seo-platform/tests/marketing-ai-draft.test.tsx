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
  MAX_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  messagesByteLength,
  parseCopyContent,
  resolveMarketingAiSelection,
  worstCaseDraftCostUsd,
  type CopyRequest,
  type MarketingCopyProvider,
} from "@/lib/marketing/ai/provider"
import { checkDraftStyle } from "@/lib/marketing/ai/style-check"
import { listDraftTopics, pickDraftTopic, topicBrief } from "@/lib/marketing/ai/topics"
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

async function setup(provider: MarketingCopyProvider | null, nowIso = "2026-11-10T03:00:00.000Z", region: string | null = null) {
  let tick = 0
  const now = () => new Date(new Date(nowIso).getTime() + 1000 * tick++).toISOString()
  const repo = createInMemoryMarketingRepository(now)
  const marketing = createMarketingService(repo, now)
  const campaign = await marketing.createCampaign({ code: "condolence-guide-01", name: "근조 주문 준비 안내", mode: "condolence", region, actor: ADMIN })
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
    // 최악 비용 = 2회 × (입력 16,000 + 출력 900 토큰)
    expect(worstCaseDraftCostUsd(MODEL)).toBe(0.01568)
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

  it("지역·기존 제목·반려 사유·이전 초안이 아무리 길어도 요청 크기는 입력 상한 안이다", () => {
    const huge = "서울 ".repeat(100_000)
    const messages = buildCopyMessages({
      mode: "condolence",
      channel: "naver_blog",
      topic: huge,
      region: huge,
      avoidTitles: Array.from({ length: 50 }, () => huge),
      fixIssues: Array.from({ length: 50 }, () => huge),
      previous: { title: huge, body: huge, caption: huge },
    })
    expect(messagesByteLength(messages)).toBeLessThan(MAX_INPUT_TOKENS - 100)
    // 정상 크기의 요청은 상한보다 훨씬 작다
    expect(messagesByteLength(buildCopyMessages({ mode: "condolence", channel: "naver_blog", topic: "주제", region: "경남", avoidTitles: [] }))).toBeLessThan(6000)
  })

  it("주제 프롬프트 자체가 그 모드의 금지 어휘를 담고 있지 않다", () => {
    for (const mode of ["condolence", "celebration", "corporate-celebration"] as const) {
      for (const topic of listDraftTopics(mode)) {
        const report = evaluateAdCopy({ mode, copy: { title: topic.prompt, body: topicBrief(topic) } })
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

  it("헤더만 오고 본문이 멈춰도 시간 초과로 끊는다", async () => {
    // 200 응답이지만 본문 스트림이 영원히 끝나지 않는다
    const stalled: typeof fetch = () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        pull() {
          // 데이터를 영원히 보내지 않는다
          return new Promise<void>(() => undefined)
        },
      }), { status: 200 }))
    const started = Date.now()
    await expect(createOpenAiMarketingProvider({ apiKey: "k", model: MODEL, fetchImpl: stalled, timeoutMs: 30 }).generate(request)).rejects.toMatchObject({ code: "timeout" })
    expect(Date.now() - started).toBeLessThan(2000)
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
    expect(result.variant).toMatchObject({ title: GOOD.title, review_status: "needs_review", channel_code: "naver_blog", destination_code: "smartstore", })
    expect(result.variant.code).toMatch(/^ai-261110-[0-9a-f]{8}$/)
    expect(result.variant.order_url).toContain(`nt_detail=condolence-guide-01.${result.variant.code}`)
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

  it("앞부분이 같은 서로 다른 요청 키도 각각 초안이 저장된다", async () => {
    const second = { ...GOOD, title: "근조화환 리본 문구 쓰는 법", body: `${GOOD.body}

오른쪽 리본에는 '삼가 고인의 명복을 빕니다'나 '깊은 애도를 표합니다'를 적고, 왼쪽에는 '○○주식회사 대표이사 홍길동'처럼 보내는 분을 적습니다.` }
    const provider = scripted([GOOD, second])
    const { repo, id, draft } = await setup(provider)
    const a = await draft("abcdef00-aaaa-4bbb-8ccc-000000000001")
    const b = await draft("abcdef01-aaaa-4bbb-8ccc-000000000002")
    expect(a.ok && b.ok).toBe(true)
    const codes = (await repo.listVariants(id)).map((variant) => variant.code)
    expect(new Set(codes).size).toBe(2)
    expect((await repo.listGenerations(id, 10)).every((row) => row.status === "succeeded")).toBe(true)
  })

  it("소재 코드가 겹치면 긴 코드로 다시 저장해, 이미 만든 글을 잃지 않는다", async () => {
    const provider = scripted([GOOD])
    const { repo, marketing, id } = await setup(provider)
    // 짧은 코드(8자)는 항상 이미 쓰였다고 답하는 저장소
    const colliding = createDraftGenerator({
      repo,
      provider,
      marketing: {
        ...marketing,
        createVariant: (input) => (/^ai-\d{6}-[0-9a-f]{8}$/.test(input.code) ? Promise.resolve({ ok: false, reason: "code-taken" }) : marketing.createVariant(input)),
      },
    })
    const result = await colliding.generateDraft({ campaignId: id, channel: "naver_blog", requestKey: "cccccccc-aaaa-4bbb-8ccc-000000000003", actor: ADMIN })
    expect(result.ok && result.variant.code).toMatch(/^ai-\d{6}-[0-9a-f]{32}$/)
    expect((await repo.listGenerations(id, 10))[0]).toMatchObject({ status: "succeeded" })
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
    // 소재 없는 성공은 DB 제약처럼 거부된다 — 예산을 풀지 못한다
    await expect(repo.settleGeneration(first.id, { status: "succeeded", actualUsd: 0.001, inputTokens: 1, outputTokens: 1, callCount: 1, variantId: null })).rejects.toThrow("success_check")
    expect(await repo.settleGeneration(first.id, { status: "failed", actualUsd: 0.001, inputTokens: 1, outputTokens: 1, callCount: 1 })).toBe(true)
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
    const second = { ...GOOD, title: "근조화환 리본 문구 쓰는 법", body: `${GOOD.body}

오른쪽 리본에는 '삼가 고인의 명복을 빕니다'나 '깊은 애도를 표합니다'를 적고, 왼쪽에는 '○○주식회사 대표이사 홍길동'처럼 보내는 분을 적습니다.` }
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

// 2026-11-11 운영에서 처음 만든 초안 — 금지 규칙은 통과했지만 승인하지 않은 글. 문장 검사가 이 글을 잡아야 한다.
// 2026-11-11 운영 두 번째 초안(ai-261111-fad1e1e3, 경남) — 금지 규칙·첫 문장 검사는 통과했지만 상호를 예시로 쓰고 지역을 세 번 썼다
const SECOND_PRODUCTION_DRAFT = {
  title: "경남 근조화환 리본 문구 작성 요령",
  body: "경남 지역에서 근조화환을 주문할 때 리본 문구는 오른쪽과 왼쪽으로 구분하여 작성합니다. 오른쪽 리본에는 조의의 뜻을 담은 문구를, 왼쪽 리본에는 보내는 사람의 이름이나 단체명을 적는 역할을 합니다.\n\n오른쪽 리본에 적는 조의 문구는 예를 들어 '삼가 고인의 명복을 빕니다', '깊은 애도를 표합니다', '고인의 영면을 기원합니다'와 같이 간결하고 정중한 표현을 사용합니다. 이러한 문구는 조의를 전하는 데 적합합니다.\n\n왼쪽 리본에는 보내는 사람을 표시합니다. 개인일 경우에는 '홍길동'과 같이 이름만 적으면 되고, 회사나 단체일 때는 '㈜팔도플라워 임직원 일동'처럼 회사명과 단체임을 알 수 있는 문구로 작성합니다.\n\n리본 문구 작성 시 글자 수와 배치에 유의해야 하므로, 주문 과정에서 제공되는 안내를 참고하여 입력하는 것이 바람직합니다. 경남 지역에서 근조화환 주문 시 오른쪽과 왼쪽 리본에 들어갈 문구를 정확히 입력하여 주문서를 제출하시기 바랍니다.",
  caption: "리본 문구 작성 요령",
}

const FIRST_PRODUCTION_DRAFT = {
  title: "경남 지역 근조화환 주문 전 꼭 확인할 사항",
  body: [
    "경남 지역에서 근조화환을 준비할 때는 몇 가지 중요한 정보를 미리 확인하는 것이 필요합니다. 먼저, 장례식장의 정식 명칭을 정확히 알아두어야 합니다. 장례식장은 여러 이름으로 불릴 수 있으므로, 정확한 명칭을 확인하면 화환이 올바른 장소로 전달되는 데 도움이 됩니다.",
    "다음으로 빈소 호실을 확인하는 것도 중요합니다. 빈소 호실은 장례식장 내에서 고인의 빈소가 위치한 구역을 의미하며, 이를 정확히 알아야 화환이 올바른 장소에 놓일 수 있습니다. 빈소 호실 정보는 장례식장 측에 문의하거나 상주로부터 안내받을 수 있습니다.",
    "마지막으로 상주의 성함을 정확히 확인해야 합니다. 상주는 고인의 가족 또는 대표자로, 근조화환에 적힐 이름이나 전달 시 필요한 정보를 제공하는 중요한 역할을 합니다. 상주의 이름이 정확하지 않으면 전달 과정에서 혼선이 생길 수 있으니 주의가 필요합니다.",
    "이처럼 경남 지역에서 근조화환 주문을 준비할 때는 장례식장 정식 명칭, 빈소 호실, 상주 성함 세 가지 정보를 반드시 확인하시기 바랍니다. 이러한 정보를 사전에 준비하면 원활한 주문과 전달이 가능합니다. 주문 과정에서 도착 시점도 함께 확인할 수 있으니 참고하시기 바랍니다.",
  ].join("\n\n"),
  caption: "경남 근조화환 주문 전 필수 확인 사항 안내",
}

describe("문장 검사 (읽을 가치가 있는 글인가)", () => {
  const orderChecklist = listDraftTopics("condolence").find((topic) => topic.key === "order-checklist")
  const ribbon = listDraftTopics("condolence").find((topic) => topic.key === "ribbon-wording")
  if (orderChecklist === undefined || ribbon === undefined) {
    throw new Error("topics expected")
  }

  it("운영 첫 초안의 문제를 모두 잡는다 — 반복·빈말·당연한 설명·요약 마무리·예고 첫 문장", () => {
    const codes = checkDraftStyle(FIRST_PRODUCTION_DRAFT, orderChecklist).map((issue) => issue.code)
    expect(codes).toEqual(expect.arrayContaining(["style:repeat:정확", "style:repeat:중요", "style:cliche", "style:definition", "style:summary-ending", "style:vague-opener"]))
    // 금지 규칙만으로는 이 글을 막지 못했다 — 그래서 문장 검사가 따로 필요하다
    expect(evaluateAdCopy({ mode: "condolence", copy: FIRST_PRODUCTION_DRAFT, regionTokens: ["경남"] }).status).toBe("pass")
  })

  it("구체적인 글은 통과한다", () => {
    const good = {
      title: "부고 문자에서 옮겨 적을 세 가지",
      body: [
        "부고 문자를 받으면 장례식장 이름, 빈소 호실, 상주 성함을 그대로 주문서에 옮겨 적으면 됩니다.",
        "첫째, 장례식장 이름은 지점명까지 적습니다. 같은 이름의 장례식장이 한 도시에 여러 곳 있는 경우가 많습니다.",
        "둘째, 빈소 호실은 숫자까지 적습니다. 한 장례식장에 여러 빈소가 동시에 차려집니다.",
        "셋째, 상주 성함을 함께 적으면 호실이 바뀌어도 화환이 제자리를 찾습니다.",
        "주문할 때는 부고 문자를 열어 둔 채로 위 세 항목을 순서대로 옮겨 적어 주세요.",
      ].join("\n\n"),
    }
    expect(checkDraftStyle(good, orderChecklist)).toEqual([])
  })

  it("예시를 요구하는 주제에서 작은따옴표 예시가 부족하면 잡는다", () => {
    const noExamples = { title: "근조화환 리본 문구 쓰는 법", body: "오른쪽 리본에는 조의 문구를, 왼쪽 리본에는 보내는 분을 적습니다.\n\n회사로 보낼 때는 회사명과 대표자 성함을 함께 적습니다." }
    expect(checkDraftStyle(noExamples, ribbon).map((issue) => issue.code)).toEqual(["style:missing-examples"])
    const withExamples = { ...noExamples, body: `${noExamples.body}

예를 들어 '삼가 고인의 명복을 빕니다', '깊은 애도를 표합니다', '고인의 영면을 기원합니다'처럼 씁니다.` }
    expect(checkDraftStyle(withExamples, ribbon)).toEqual([])
    // 예시를 요구하지 않는 주제에는 적용하지 않는다
    expect(checkDraftStyle(noExamples, orderChecklist)).toEqual([])
  })

  it("문장 문제가 있으면 금지 규칙을 통과해도 한 번 다시 쓰게 하고, 사유를 넘긴다", async () => {
    const provider = scripted([FIRST_PRODUCTION_DRAFT, GOOD])
    const { draft } = await setup(provider)
    const result = await draft("dddddddd-aaaa-4bbb-8ccc-000000000001")
    expect(result).toMatchObject({ ok: true, repaired: true, qualityStatus: "pass", styleIssues: [] })
    expect(provider.requests).toHaveLength(2)
    const sent = provider.requests[1]?.fixIssues?.join(" ") ?? ""
    expect(sent).toContain("요약")
    expect(sent).toContain("빈말")
  })

  it("다시 써도 문장 문제가 남으면 저장은 하되 남은 문제를 알려 준다", async () => {
    const provider = scripted([FIRST_PRODUCTION_DRAFT, FIRST_PRODUCTION_DRAFT])
    const { repo, id, draft } = await setup(provider)
    const result = await draft("eeeeeeee-aaaa-4bbb-8ccc-000000000002")
    expect(result.ok).toBe(true)
    expect(result.ok && result.styleIssues.length).toBeGreaterThan(0)
    expect(provider.requests).toHaveLength(2)
    expect(await repo.listVariants(id)).toHaveLength(1)
  })

  it("주제마다 요구한 예시 개수로 검사한다 — 1개 요구에는 1개면 되고, 3개 요구에는 2개로 부족하다", () => {
    const farAway = listDraftTopics("condolence").find((topic) => topic.key === "far-away")
    if (farAway === undefined) {
      throw new Error("topic expected")
    }
    const oneQuote = { title: "멀리서 마음을 전하는 법", body: "화환과 함께 상주에게 '멀리서나마 깊은 위로를 전합니다'라고 짧게 문자를 보내 주세요.\n\n리본의 보내는 사람에는 소속을 함께 적습니다." }
    expect(checkDraftStyle(oneQuote, farAway)).toEqual([])
    const twoQuotes = { title: "근조화환 리본 문구", body: "'삼가 고인의 명복을 빕니다'나 '깊은 애도를 표합니다'를 적습니다." }
    expect(checkDraftStyle(twoQuotes, ribbon).map((issue) => issue.code)).toEqual(["style:missing-examples"])
    expect(checkDraftStyle(twoQuotes, ribbon)[0]?.message).toContain("3개 이상")
  })

  it("주제의 예시 개수는 '반드시 넣을 내용'이 요구한 개수와 같다", () => {
    for (const mode of ["condolence", "celebration", "corporate-celebration"] as const) {
      for (const topic of listDraftTopics(mode)) {
        const required = topic.must
          .filter((item) => item.includes("작은따옴표"))
          .reduce((total, item) => total + Number(/예시 (\d+)개/.exec(item)?.[1] ?? "1"), 0)
        expect(topic.quotedExamples, `${mode}/${topic.key}`).toBe(required)
      }
    }
  })

  it("근거 없는 단정이나 빈도 주장을 필수 내용으로 넣지 않는다", () => {
    const all = (["condolence", "celebration", "corporate-celebration"] as const).flatMap((mode) => listDraftTopics(mode).flatMap((topic) => topic.must))
    for (const item of all) {
      expect(item, item).not.toMatch(/경우가 많다|대부분|항상|절대|빈소를 정리하므로/)
    }
  })

  it("문장만 다듬으려던 보정 호출이 실패하면, 이미 만든 1차 초안을 저장하고 실패를 기록한다", async () => {
    for (const [error, expectedCode, expectNullCost] of [
      [new MarketingAiError("http", "status 500"), "repair-ai-http", false],
      [new MarketingAiError("timeout", "no response"), "repair-ai-timeout", true],
    ] as const) {
      const provider = scripted([FIRST_PRODUCTION_DRAFT, error])
      const { repo, id, draft } = await setup(provider)
      const result = await draft(`ffffffff-aaaa-4bbb-8ccc-00000000000${expectNullCost ? "2" : "1"}`)
      expect(result, expectedCode).toMatchObject({ ok: true, repaired: false, qualityStatus: "pass", variant: { title: FIRST_PRODUCTION_DRAFT.title } })
      expect(result.ok && result.styleIssues.length).toBeGreaterThan(0)
      const [generation] = await repo.listGenerations(id, 10)
      expect(generation).toMatchObject({ status: "succeeded", error_code: expectedCode, call_count: 2 })
      if (expectNullCost) {
        // 응답을 못 받은 보정 호출은 사용량을 모른다 — 예약 금액 전체가 예산에서 빠지게 실제 비용을 비워 둔다
        expect(generation?.actual_usd).toBeNull()
      } else {
        expect(generation?.actual_usd).toBeGreaterThan(0)
      }
    }
  })

  it("금지 규칙에 걸린 초안은 보정 호출이 실패하면 저장하지 않는다", async () => {
    const provider = scripted([BAD, new MarketingAiError("http", "status 500")])
    const { repo, id, draft } = await setup(provider)
    expect(await draft("abababab-aaaa-4bbb-8ccc-000000000001")).toEqual({ ok: false, reason: "ai-failed" })
    expect(await repo.listVariants(id)).toEqual([])
  })

  it("운영 두 번째 초안의 문제를 잡는다 — 예시에 우리 상호, 지역 이름 반복, 빈말", () => {
    const codes = checkDraftStyle(SECOND_PRODUCTION_DRAFT, ribbon, "경남").map((issue) => issue.code)
    expect(codes).toEqual(expect.arrayContaining(["style:cliche", "style:brand-example", "style:region-repeat"]))
    const cliche = checkDraftStyle(SECOND_PRODUCTION_DRAFT, ribbon, "경남").find((issue) => issue.code === "style:cliche")
    expect(cliche?.message).toContain("역할을 합니다")
    expect(cliche?.message).toContain("적합합니다")
    expect(cliche?.message).toContain("바람직합니다")
    // 지역을 모르면 반복 검사는 하지 않는다
    expect(checkDraftStyle(SECOND_PRODUCTION_DRAFT, ribbon).map((issue) => issue.code)).not.toContain("style:region-repeat")
  })

  it("지역 이름은 두 번까지, 예시의 회사 이름은 ○○로 쓰면 통과한다", () => {
    const fixed = {
      title: "경남 근조화환 리본 문구 쓰는 법",
      body: "경남에서 근조화환을 보낼 때 오른쪽 리본에는 조의 문구를, 왼쪽 리본에는 보내는 사람을 적습니다.\n\n조의 문구는 '삼가 고인의 명복을 빕니다', '깊은 애도를 표합니다', '고인의 영면을 기원합니다' 중에서 고릅니다.\n\n보내는 사람은 개인이면 '홍길동', 회사면 '㈜○○ 임직원 일동'처럼 적습니다.\n\n주문서의 리본 문구 칸에 오른쪽 문구와 왼쪽 이름을 나눠 입력하세요.",
    }
    expect(checkDraftStyle(fixed, ribbon, "경남")).toEqual([])
    expect(checkDraftStyle({ ...fixed, body: `${fixed.body}\n\n경남 지역 주문도 같습니다.` }, ribbon, "경남").map((issue) => issue.code)).toEqual(["style:region-repeat"])
    // 상호가 예시가 아닌 곳에 나오는 것은 막지 않는다
    expect(checkDraftStyle({ ...fixed, body: `${fixed.body}\n\n팔도플라워 주문서에서 확인하세요.` }, ribbon)).toEqual([])
  })

  it("생성할 때 캠페인 지역으로 반복을 검사한다 — 지역만 세 번 쓴 초안도 한 번 다시 쓰게 한다", async () => {
    const regionOnly = {
      title: "경남 근조화환 리본 문구 쓰는 법",
      body: "경남에서 근조화환을 보낼 때 오른쪽 리본에는 조의 문구를, 왼쪽 리본에는 보내는 사람을 적습니다.\n\n조의 문구는 '삼가 고인의 명복을 빕니다', '깊은 애도를 표합니다', '고인의 영면을 기원합니다' 중에서 고릅니다.\n\n보내는 사람은 개인이면 '홍길동', 회사면 '㈜○○ 임직원 일동'처럼 적습니다.\n\n경남 지역 주문서의 리본 문구 칸에 오른쪽 문구와 왼쪽 이름을 나눠 입력하세요.",
      caption: "리본 문구 쓰는 법",
    }
    const provider = scripted([regionOnly, SECOND_PRODUCTION_DRAFT])
    const { draft } = await setup(provider, undefined, "경남")
    const result = await draft("cdcdcdcd-aaaa-4bbb-8ccc-000000000001")
    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[1]?.fixIssues?.join("\n")).toContain("'경남'을(를) 3번")
    // 다시 쓴 글에 남은 문제는 저장하되 알린다
    expect(result.ok && result.styleIssues.join("\n")).toContain("○○")
  })

  it("생성 요청에 주제의 '반드시 넣을 내용'과 글쓰기 지침이 실린다", () => {
    const [system, user] = buildCopyMessages({ mode: "condolence", channel: "naver_blog", topic: topicBrief(ribbon), region: null, avoidTitles: [] })
    expect(system?.content).toContain("글쓰기 지침")
    expect(system?.content).toContain("요약하지 않는다")
    expect(system?.content).toContain("'팔도플라워'를 예시에 쓰지 않는다")
    expect(user?.content).toContain("반드시 넣을 내용")
    expect(user?.content).toContain("작은따옴표로 인용")
  })

  it("모든 주제에 반드시 넣을 내용이 2~4개 있고, 주제 문장 길이가 요청 상한 안이다", () => {
    for (const mode of ["condolence", "celebration", "corporate-celebration"] as const) {
      for (const topic of listDraftTopics(mode)) {
        expect(topic.must.length, `${mode}/${topic.key}`).toBeGreaterThanOrEqual(2)
        expect(topic.must.length, `${mode}/${topic.key}`).toBeLessThanOrEqual(4)
        expect(Array.from(topicBrief(topic)).length, `${mode}/${topic.key}`).toBeLessThanOrEqual(600)
      }
    }
  })
})
