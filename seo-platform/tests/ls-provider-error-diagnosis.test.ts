// LS파워솔루션 provider_error 반복 실패의 회귀 테스트 묶음.
//
// 실제 원인: BANNED_KEYWORD_PATTERNS의 /공식/이 corporate FAQ 후보 "준공식 화환 시간 확인"의
// '준공식'을 부분 문자열로 오탐 → buildKeywordPlan이 자기 후보를 스스로 걸러 plain Error를 던짐 →
// classifyAiGenerationError의 fallback이 provider_error로 위장 보고. (2026-08-04, LS 2회 연속 실패)
import { describe, expect, it, vi } from "vitest"

import { evaluateGeneratedContent } from "@/lib/ai/content-quality"
import { contentModeForCategory, UnsupportedContentCategoryError } from "@/lib/ai/content-mode"
import { faqTopicsFor } from "@/lib/ai/content-variation"
import { parseGenerationStoredMetadata, wrapFailedGenerationOutput } from "@/lib/ai/generation-mapping"
import { classifyAiGenerationError, safeErrorDetail } from "@/lib/ai/generation-runner"
import { AiGuardrailViolationError } from "@/lib/ai/guardrails"
import { buildKeywordPlan, isBannedKeyword, KeywordPlanViolationError } from "@/lib/ai/keyword-variation"
import { AiProviderRequestError, OpenAiSeoContentProvider } from "@/lib/ai/openai-provider"
import { decideRepeatedGenerationBlock, REPEATED_FAILURE_LOCK_MINUTES } from "@/lib/ai/repeat-failure-policy"
import { generateAiPreview } from "@/lib/ai/service"
import type { AiGenerationInput, AiRepository } from "@/lib/ai/types"
import type { ContentMode } from "@/lib/ai/content-mode"

// 실제 LS파워솔루션 값 — seed가 실측 실패를 그대로 재현하는 결정 인자다.
const LS_ID = "ad29ef32-0e89-43ce-bdba-f225b582cfeb"
const LS_NAME = "LS파워솔루션 울산공장"

describe("keyword 금지 규칙 — '공식' 오탐 교정", () => {
  it("'준공식'은 허용하고 '공식' 계열은 계속 차단한다", () => {
    expect(isBannedKeyword("준공식 화환 시간 확인")).toBe(false)
    expect(isBannedKeyword("공식 주문 안내")).toBe(true)
    expect(isBannedKeyword("공식 홈페이지")).toBe(true)
    expect(isBannedKeyword("제휴 업체 화환")).toBe(true)
    expect(isBannedKeyword("조문 서비스")).toBe(true)
  })

  it("모든 모드의 FAQ 후보 pool은 자체 금지 규칙과 충돌하지 않는다", () => {
    // 후보 pool이 스스로 걸리는 조합이 하나라도 있으면 그 seed의 장소는 영구 결정적 실패다.
    const modes: readonly ContentMode[] = ["condolence", "celebration", "corporate-celebration"]
    for (const mode of modes) {
      const keys = faqTopicsFor(mode).map((topic) => topic.key)
      for (const key of keys) {
        for (let seedIndex = 0; seedIndex < 20; seedIndex += 1) {
          const plan = buildKeywordPlan({
            seed: `seed-${String(seedIndex)}:장소-${String(seedIndex)}`,
            placeName: `장소-${String(seedIndex)}`,
            city: "울산",
            district: "울주군",
            mode,
            faqTopicKeys: [key],
            recentSets: [],
          })
          expect(plan.keywords.length).toBeGreaterThan(0)
        }
      }
    }
  })

  it("LS파워솔루션 실측 입력이 더 이상 던지지 않는다 (실패 재현 seed)", () => {
    const plan = buildKeywordPlan({
      seed: `${LS_ID}:${LS_NAME}`,
      placeName: LS_NAME,
      city: "울산",
      district: "울주군",
      mode: "corporate-celebration",
      faqTopicKeys: ["ceremony-time", "gate-delivery"],
      recentSets: [],
    })
    expect(plan.keywords).toHaveLength(5)
    // 교정 전 실측에서 걸렸던 바로 그 키워드가 이제 정상 후보로 살아 있다.
    expect(plan.keywords).toContain("준공식 화환 시간 확인")
  })

  it("'준공식 화환 시간 확인' 키워드는 품질 검사(evaluateGeneratedContent)도 통과한다", () => {
    const report = evaluateGeneratedContent({
      content: {
        description: "LS파워솔루션 울산공장으로 축하화환을 보내는 방법을 안내합니다. 수령 위치는 주문 과정에서 확인할 수 있습니다.",
        meta_title: "울산 사업장 행사 화환 주문 정보 — LS파워솔루션 울산공장",
        meta_description: "울산 LS파워솔루션 울산공장 축하화환 주문 안내입니다.",
        faq: [
          { question: "준공식 화환은 언제 보내야 하나요?", answer: "행사 일정은 주문 과정에서 확인할 수 있습니다." },
          { question: "경비실 수령이 가능한가요?", answer: "수령 위치는 주문 과정에서 확인할 수 있습니다." },
        ],
        keywords: [LS_NAME, "울주 개업화환", "준공식 화환 시간 확인"],
        internal_links: [],
      },
      placeName: LS_NAME,
      regionTokens: ["울산", "울주군"],
      verifiedInternalPaths: new Set<string>(),
      recentPages: [],
      mode: "corporate-celebration",
    })
    expect(report.status).not.toBe("fail")
  })
})

describe("오류 분류 세분화 — provider_error 뭉개짐 제거", () => {
  it("조립·업종·미분류 오류가 각자의 코드로 나뉜다", () => {
    expect(classifyAiGenerationError(new KeywordPlanViolationError("banned keyword produced: x"))).toBe("content_plan_error")
    expect(classifyAiGenerationError(new UnsupportedContentCategoryError("병원"))).toBe("unsupported_category")
    expect(classifyAiGenerationError(new AiGuardrailViolationError("email generated"))).toBe("invalid_response")
    expect(classifyAiGenerationError(new Error("db insert failed"))).toBe("unknown")
    expect(classifyAiGenerationError(new AiProviderRequestError("provider_error", "HTTP 500"))).toBe("provider_error")
    expect(classifyAiGenerationError(new AiProviderRequestError("timeout", "request timed out"))).toBe("timeout")
    expect(classifyAiGenerationError(new AiProviderRequestError("rate_limit", "HTTP 429"))).toBe("rate_limit")
  })

  it("안전 상세는 통제된 문자열만 담는다 (원문·시크릿 없음)", () => {
    expect(safeErrorDetail(new AiProviderRequestError("provider_error", "HTTP 500", "req_abc"))).toBe("HTTP 500 [request req_abc]")
    expect(safeErrorDetail(new KeywordPlanViolationError("banned keyword produced: 준공식 화환 시간 확인"))).toBe("banned keyword produced: 준공식 화환 시간 확인")
    expect(safeErrorDetail(new UnsupportedContentCategoryError("병원"))).toBe("category: 병원")
    // 알 수 없는 오류는 이름만 — message에 내부 정보가 담길 수 있다.
    expect(safeErrorDetail(new TypeError("secret: sk-123"))).toBe("TypeError")
  })

  it("실패 레코드에 안전 상세가 저장되고 다시 읽힌다", () => {
    const output = wrapFailedGenerationOutput({ provider: "openai", model: "gpt-4.1-mini" }, "provider_error", null, "HTTP 500 [request req_abc]")
    const parsed = parseGenerationStoredMetadata(output)
    expect(parsed.errorCode).toBe("provider_error")
    expect(parsed.errorDetail).toBe("HTTP 500 [request req_abc]")
    // 상세 없는 구 레코드 형태도 안전하게 null.
    expect(parseGenerationStoredMetadata(wrapFailedGenerationOutput({ provider: "openai", model: null }, "timeout")).errorDetail).toBeNull()
  })

  it("OpenAI HTTP 오류에서 x-request-id를 식별자로만 붙잡는다", async () => {
    const provider = new OpenAiSeoContentProvider({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      fetchImpl: () => Promise.resolve(new Response("upstream error", { status: 500, headers: { "x-request-id": "req_test_1" } })),
    })
    const input = { content_mode: "corporate-celebration", place: { id: "p", name: "장소", category: "제조", city: null, district: null, address: null, homepage: null }, guardrails: [] } as unknown as AiGenerationInput
    await expect(provider.generateSeoContent(input)).rejects.toMatchObject({ code: "provider_error", requestId: "req_test_1" })
  })
})

describe("반복 실패 잠금 정책", () => {
  const NOW = new Date("2026-08-04T05:00:00.000Z")
  const failure = (minutesAgo: number, errorCode = "provider_error") => ({
    status: "failed",
    errorCode,
    createdAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
  })

  it("같은 코드 연속 2회 실패 + 잠금 시간 내면 차단한다", () => {
    const decision = decideRepeatedGenerationBlock({ recentOutcomes: [failure(5), failure(6)], now: NOW })
    expect(decision.blocked).toBe(true)
    if (!decision.blocked) return
    expect(decision.errorCode).toBe("provider_error")
    expect(decision.consecutiveFailures).toBe(2)
  })

  it("실패 1회·코드 상이·성공 개입은 차단하지 않는다", () => {
    expect(decideRepeatedGenerationBlock({ recentOutcomes: [failure(5)], now: NOW }).blocked).toBe(false)
    expect(decideRepeatedGenerationBlock({ recentOutcomes: [failure(5), failure(6, "timeout")], now: NOW }).blocked).toBe(false)
    expect(decideRepeatedGenerationBlock({ recentOutcomes: [{ status: "preview", errorCode: null, createdAt: NOW.toISOString() }, failure(5), failure(6)], now: NOW }).blocked).toBe(false)
  })

  it("잠금 시간이 지나면 재시도가 다시 열린다", () => {
    const old = REPEATED_FAILURE_LOCK_MINUTES + 1
    expect(decideRepeatedGenerationBlock({ recentOutcomes: [failure(old), failure(old + 1)], now: NOW }).blocked).toBe(false)
  })
})

describe("LS 입력 prompt 조립 — provider 스텁으로 전 경로 통과", () => {
  it("corporate-celebration 모드로 조립·파싱·기록까지 성공한다 (OpenAI 실호출 0)", async () => {
    expect(contentModeForCategory("제조")).toBe("corporate-celebration")
    const captured: { body?: string } = {}
    const provider = new OpenAiSeoContentProvider({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      fetchImpl: (_url, init) => {
        captured.body = typeof init?.body === "string" ? init.body : ""
        const content = JSON.stringify({
          description: "축하화환 주문 안내입니다. 수령 위치는 주문 과정에서 확인할 수 있습니다.",
          meta_title: "임시 제목",
          meta_description: "임시 메타 설명입니다.",
          faq: [
            { question: "반입 시간은 어떻게 확인하나요?", answer: "주문 과정에서 확인할 수 있습니다." },
            { question: "수령 부서를 모르면 어떻게 하나요?", answer: "주문 과정에서 확인할 수 있습니다." },
          ],
          keywords: ["임시 키워드"],
          internal_links: [],
        })
        return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } }))
      },
    })
    const created: unknown[] = []
    const repository = {
      findPlaceById: () =>
        Promise.resolve({
          id: LS_ID,
          name: LS_NAME,
          category: "제조",
          city: "울산",
          district: "울주군",
          address: "울산 울주군 삼남읍 가천금사길 250 (우)44953",
          homepage: "http://www.lspowersolution.com/",
          phone: null,
          normalized_phone: null,
          email: null,
          description: null,
          meta_title: null,
          meta_description: null,
          faq: [],
          keywords: [],
          internal_links: [],
        } as never),
      createAiGeneration: (input: { input: unknown; output: unknown }) => {
        created.push(input)
        return Promise.resolve({ id: "gen-ls-test", place_id: LS_ID, status: "preview", input: input.input, output: input.output } as never)
      },
    } as unknown as AiRepository
    const record = await generateAiPreview({ placeId: LS_ID, provider, repository, recentContent: [] })
    expect(record.id).toBe("gen-ls-test")
    expect(created).toHaveLength(1)
    const sent = JSON.parse(captured.body ?? "{}") as { messages?: { content: string }[] }
    const userPayload = JSON.parse(sent.messages?.[1]?.content ?? "{}") as { content_plan?: { keywords?: string[] } }
    expect(userPayload.content_plan?.keywords).toHaveLength(5)
  })
})

describe("runPlaceAiGeneration — 반복 실패 잠금 배선", () => {
  it("연속 2회 같은 코드 실패면 provider 호출 전에 repeat-blocked를 돌려준다", async () => {
    vi.resetModules()
    const listRecent = vi.fn().mockResolvedValue([
      { status: "failed", errorCode: "provider_error", createdAt: new Date().toISOString() },
      { status: "failed", errorCode: "provider_error", createdAt: new Date(Date.now() - 60_000).toISOString() },
    ])
    vi.doMock("@/lib/ai/supabase-repository", () => ({
      createSupabaseAiRepository: vi.fn(() => {
        throw new Error("must not reach repository")
      }),
      hasRecentPreviewAiGeneration: vi.fn(),
      listRecentAiGenerationOutcomes: listRecent,
      recordFailedAiGeneration: vi.fn(),
      listRecentPublishedContentSnapshots: vi.fn().mockResolvedValue([]),
    }))
    const { runPlaceAiGeneration } = await import("@/lib/ai/generation-runner")
    const result = await runPlaceAiGeneration({ placeId: LS_ID })
    expect(result.kind).toBe("repeat-blocked")
    if (result.kind !== "repeat-blocked") return
    expect(result.errorCode).toBe("provider_error")
    expect(listRecent).toHaveBeenCalledWith(LS_ID)
    vi.doUnmock("@/lib/ai/supabase-repository")
    vi.resetModules()
  })
})
