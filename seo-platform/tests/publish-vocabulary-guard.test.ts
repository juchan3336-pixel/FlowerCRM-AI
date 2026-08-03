import { beforeEach, describe, expect, it, vi } from "vitest"

import { generateAiPreview } from "@/lib/ai/service"
import { OpenAiSeoContentProvider } from "@/lib/ai/openai-provider"
import { FORBIDDEN_VOCABULARY_AFTER_RETRY_REASON, FORBIDDEN_VOCABULARY_REASON, forbiddenVocabularyTerms, vocabularyFailureReason } from "@/lib/batch/quality-policy"
import { forbiddenVocabularyCode } from "@/lib/ai/mode-vocabulary"
import { InMemorySyncRepository } from "@/lib/sync/in-memory-repository"
import { syncSheetRows } from "@/lib/sync/service"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

// 게시 대상 장소 한 건을 흉내내는 최소 대역 — publish-runner가 읽는 컬럼만 채운다.
const HOTEL_PLACE = {
  id: "910e5a42",
  name: "아이스퀘어호텔",
  category: "호텔",
  city: "경남",
  district: "김해시",
  description: "아이스퀘어호텔 근조화환 주문 안내입니다.",
  meta_title: "아이스퀘어호텔 장례식장 화환 주문 정보",
  meta_description: "김해 근조화환 주문은 버튼에서 확인하세요.",
  faq: [{ question: "빈소명을 모를 때는?", answer: "관계자에게 문의하세요." }],
  keywords: ["아이스퀘어호텔", "김해 근조화환"],
}

const CLEAN_HOTEL_PLACE = {
  ...HOTEL_PLACE,
  description: "아이스퀘어호텔 축하화환 주문 안내입니다.",
  meta_title: "아이스퀘어호텔 행사·오픈 축하화환 배송",
  meta_description: "김해 축하화환 주문은 버튼에서 확인하세요.",
  faq: [{ question: "행사 날짜에 맞출 수 있나요?", answer: "주문 과정에서 확인됩니다." }],
  keywords: ["아이스퀘어호텔", "김해 축하화환"],
}

const publishPlacePage = vi.fn()
let currentPlace: Record<string, unknown> = HOTEL_PLACE

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: currentPlace, error: null }),
        }),
      }),
    }),
  }),
}))

vi.mock("@/lib/seo-pages/place-publish", () => ({
  publishPlacePage: (...args: readonly unknown[]) => {
    publishPlacePage(...args)
    return Promise.resolve({ kind: "published", path: "/places/x" })
  },
}))

vi.mock("@/lib/seo-pages/supabase-place-publish", () => ({
  createSupabasePlacePublishRepository: () => ({}),
}))

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }))

describe("게시 직전 금지어 최종 방어", () => {
  beforeEach(() => {
    publishPlacePage.mockClear()
  })

  it("refuses to publish and never calls the publish RPC", async () => {
    currentPlace = HOTEL_PLACE
    const { runPlacePublish } = await import("@/lib/seo-pages/publish-runner")
    const result = await runPlacePublish("910e5a42", { registerAfter: () => undefined })

    expect(result.kind).toBe("vocabulary-blocked")
    // RPC를 부르지 않았다 = places.status·published_at·seo_pages.status 어느 것도 바뀌지 않았다.
    expect(publishPlacePage).not.toHaveBeenCalled()
    if (result.kind === "vocabulary-blocked") {
      expect(result.findings.map((finding) => finding.term)).toEqual(expect.arrayContaining(["근조", "장례식장", "빈소"]))
      expect(result.findings.some((finding) => finding.field === "meta_title")).toBe(true)
    }
  })

  it("publishes normally when the wording matches the industry", async () => {
    currentPlace = CLEAN_HOTEL_PLACE
    const { runPlacePublish } = await import("@/lib/seo-pages/publish-runner")
    const result = await runPlacePublish("910e5a42", { registerAfter: () => undefined })

    expect(result.kind).toBe("published")
    expect(publishPlacePage).toHaveBeenCalledTimes(1)
  })

  // 모드를 정할 수 없으면 '검사 통과'가 아니라 '검사 불가'다 — 건너뛰고 공개하면 게이트가 무의미해진다.
  it.each([
    ["hospital", "hospital"],
    ["미상 업종", "자동차"],
    ["빈 문자열", ""],
    ["공백", "   "],
    ["null", null],
  ])("refuses to publish when the category has no content mode (%s)", async (_label, category) => {
    currentPlace = { ...CLEAN_HOTEL_PLACE, category }
    const { runPlacePublish } = await import("@/lib/seo-pages/publish-runner")
    const result = await runPlacePublish("910e5a42", { registerAfter: () => undefined })

    expect(result.kind).toBe("category-blocked")
    expect(publishPlacePage).not.toHaveBeenCalled()
  })

  it("never falls back to condolence when the mode is unresolved", async () => {
    // condolence 어휘표를 적용했다면 이 콘텐츠(축하화환)는 통과했을 것이다 — 통과하지 않아야 fallback이 없다는 뜻이다.
    currentPlace = { ...CLEAN_HOTEL_PLACE, category: "hospital" }
    const { runPlacePublish } = await import("@/lib/seo-pages/publish-runner")
    expect((await runPlacePublish("910e5a42", { registerAfter: () => undefined })).kind).toBe("category-blocked")
  })
})

describe("재시도 사유 코드", () => {
  const issues = [{ code: forbiddenVocabularyCode({ mode: "celebration", field: "meta_title", term: "빈소", kind: "term" }) }]

  it("distinguishes the first block from the after-retry block", () => {
    expect(vocabularyFailureReason({ issues, retried: false })).toBe(FORBIDDEN_VOCABULARY_REASON)
    expect(vocabularyFailureReason({ issues, retried: true })).toBe(FORBIDDEN_VOCABULARY_AFTER_RETRY_REASON)
    expect(vocabularyFailureReason({ issues: [{ code: "repeat:title" }], retried: true })).toBeNull()
  })

  it("collects the terms to hand back to the retry prompt", () => {
    expect(forbiddenVocabularyTerms(issues)).toEqual(["빈소"])
    expect(forbiddenVocabularyTerms([{ code: "repeat:title" }])).toEqual([])
  })
})

describe("재시도 프롬프트에 금지 표현을 넘긴다", () => {
  it("puts the blocked terms in the request body", async () => {
    const rows: unknown = JSON.parse(await readFile(resolve("tests/fixtures/sheet-rows.json"), "utf8"))
    const repository = new InMemorySyncRepository()
    await syncSheetRows({ repository, rows, sheetName: "기업 DB" })
    const place = repository.places().find((row) => row.category === "funeral")

    let requestBody: Record<string, unknown> | null = null
    const fetchImpl: typeof fetch = (_url, init) => {
      requestBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>
      const content = JSON.stringify({
        description: `${place?.name ?? ""} 근조화환 주문 안내입니다. 빈소 정보는 주문 과정에서 확인됩니다.`,
        meta_title: `${place?.name ?? ""} 근조화환 주문 안내`,
        meta_description: "주문 과정에서 확인하세요.",
        faq: [
          { question: "빈소명을 모를 때는?", answer: "관계자에게 문의하세요." },
          { question: "받는 분 정보는?", answer: "주문 과정에서 안내됩니다." },
        ],
        keywords: ["k1", "k2", "k3"],
        internal_links: [],
      })
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content } }], usage: {} }), { status: 200 }))
    }

    await generateAiPreview({
      placeId: place?.id ?? "",
      provider: new OpenAiSeoContentProvider({ apiKey: "test-key", model: "test-model", fetchImpl }),
      repository,
      retry: { of: "gen-1", reason: "forbidden-mode-vocabulary", forbiddenTerms: ["개업", "준공"] },
    })

    const messages = (requestBody as unknown as { messages: readonly { role: string; content: string }[] } | null)?.messages ?? []
    const userMessage = messages.find((message) => message.role === "user")?.content ?? ""
    const parsed = JSON.parse(userMessage) as { retry_guidance?: { forbidden_terms?: readonly string[]; note?: string } }
    expect(parsed.retry_guidance?.forbidden_terms).toEqual(["개업", "준공"])
    expect(parsed.retry_guidance?.note).toContain("다시 쓰지 마세요")
  })
})
