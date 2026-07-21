import { describe, expect, it } from "vitest"

import { generateAiPreview } from "@/lib/ai/service"
import { AiProviderRequestError, OpenAiSeoContentProvider } from "@/lib/ai/openai-provider"
import { withAiGenerationMetadata } from "@/lib/ai/metadata"
import { InMemorySyncRepository } from "@/lib/sync/in-memory-repository"
import type { AiGenerationInput } from "@/lib/ai/types"
import type { SheetPayload } from "@/lib/domain/sheet-row"
import type { NewSyncedPlace } from "@/lib/sync/types"

const GENERATION_INPUT: AiGenerationInput = {
  place: { id: "place-1", name: "테스트 장소", category: "장례식장", city: "서울", district: "강남구", address: "서울 강남구 테헤란로 1", homepage: null },
  guardrails: ["Do not invent facts absent from the source place."],
}

const VALID_CONTENT = {
  description: "서울 강남구의 테스트 장소 장례식장 페이지입니다. 근조화환 주문은 공식 CTA를 통해 확인하세요.",
  meta_title: "테스트 장소 장례식장 근조화환 안내",
  meta_description: "서울 강남구 장례식장 방문자를 위한 근조화환 주문 안내입니다.",
  faq: [
    { question: "테스트 장소 근처로 근조화환을 보낼 수 있나요?", answer: "공식 주문 CTA에서 확인할 수 있습니다." },
    { question: "어떤 정보가 표시되나요?", answer: "검증된 기본 정보만 제공합니다." },
  ],
  keywords: ["서울 강남구 근조화환", "장례식장 화환", "테스트 장소"],
  internal_links: [{ href: "/area/seoul-gangnam", label: "서울 강남 장례화환" }],
}

function successPayload(content: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 820, completion_tokens: 310, total_tokens: 1130 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

function providerWith(fetchImpl: typeof fetch, timeoutMs = 5000): OpenAiSeoContentProvider {
  return new OpenAiSeoContentProvider({ apiKey: "sk-test", model: "gpt-4o-mini", timeoutMs, fetchImpl })
}

describe("openai seo content provider", () => {
  it("returns parsed model output and captures token usage", async () => {
    // Given: OpenAI responds with valid JSON content and usage.
    const requests: Request[] = []
    const provider = providerWith((input, init) => {
      requests.push(new Request(input, init))
      return Promise.resolve(successPayload(VALID_CONTENT))
    })

    // When: content is generated.
    const output = await provider.generateSeoContent(GENERATION_INPUT)

    // Then: the output is the model JSON and usage maps prompt/completion tokens.
    expect(output).toEqual(VALID_CONTENT)
    expect(provider.lastUsage).toEqual({ input_tokens: 820, output_tokens: 310, total_tokens: 1130 })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer sk-test")
  })

  it("classifies rate limit responses", async () => {
    // Given: OpenAI returns 429.
    const provider = providerWith(() => Promise.resolve(new Response("{}", { status: 429 })))

    // When / Then: the failure code is rate_limit and the message stays safe.
    await expect(provider.generateSeoContent(GENERATION_INPUT)).rejects.toMatchObject({ code: "rate_limit" })
  })

  it("classifies auth failures as provider_config without leaking details", async () => {
    // Given: OpenAI rejects the key.
    const provider = providerWith(() => Promise.resolve(new Response(JSON.stringify({ error: { message: "sk-secret leaked?" } }), { status: 401 })))

    // When: the call fails.
    const failure = await provider.generateSeoContent(GENERATION_INPUT).catch((error: unknown) => error)

    // Then: only the code and HTTP status appear in the error.
    expect(failure).toBeInstanceOf(AiProviderRequestError)
    expect((failure as AiProviderRequestError).code).toBe("provider_config")
    expect((failure as Error).message).not.toContain("sk-")
    expect((failure as Error).message).not.toContain("leaked")
  })

  it("classifies server errors, timeouts, and network failures", async () => {
    // Given / When / Then: each transport failure maps to its own code.
    await expect(providerWith(() => Promise.resolve(new Response("{}", { status: 500 }))).generateSeoContent(GENERATION_INPUT)).rejects.toMatchObject({ code: "provider_error" })

    const abortingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        })
      })
    await expect(providerWith(abortingFetch, 20).generateSeoContent(GENERATION_INPUT)).rejects.toMatchObject({ code: "timeout" })

    const failingFetch: typeof fetch = () => Promise.reject(new TypeError("fetch failed"))
    await expect(providerWith(failingFetch).generateSeoContent(GENERATION_INPUT)).rejects.toMatchObject({ code: "network" })
  })

  it("classifies malformed bodies and non-JSON model output", async () => {
    // Given / When / Then: invalid response body vs invalid model JSON are distinguished.
    await expect(providerWith(() => Promise.resolve(new Response("not json", { status: 200 }))).generateSeoContent(GENERATION_INPUT)).rejects.toMatchObject({ code: "invalid_response" })
    await expect(
      providerWith(() => Promise.resolve(new Response(JSON.stringify({ choices: [] }), { status: 200 }))).generateSeoContent(GENERATION_INPUT),
    ).rejects.toMatchObject({ code: "invalid_response" })
    await expect(
      providerWith(() => Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: "не json" } }] }), { status: 200 }))).generateSeoContent(GENERATION_INPUT),
    ).rejects.toMatchObject({ code: "json_parse" })
  })

  it("stores nothing when the provider fails, keeping existing data intact", async () => {
    // Given: a repository with a synced place and a failing provider.
    const repository = new InMemorySyncRepository()
    const place = await repository.insertPlace(makeSyncedPlaceInput())
    const provider = providerWith(() => Promise.resolve(new Response("{}", { status: 500 })))

    // When: preview generation fails.
    await expect(generateAiPreview({ placeId: place.id, provider, repository })).rejects.toMatchObject({ code: "provider_error" })

    // Then: no generation is stored and the place content is unchanged.
    expect(repository.aiGenerations()).toHaveLength(0)
    expect(repository.findSeededPlace(place.source_key)?.description).toBeNull()
  })

  it("passes schema validation and guardrails end to end with metadata injection", async () => {
    // Given: a valid OpenAI response flowing through the real service seam.
    const repository = new InMemorySyncRepository()
    const place = await repository.insertPlace(makeSyncedPlaceInput())
    const provider = providerWith(() => Promise.resolve(successPayload(VALID_CONTENT)))
    const decorated = withAiGenerationMetadata(repository, () => ({
      provider: "openai",
      model: "gpt-4o-mini",
      usage: provider.lastUsage,
      estimated_cost: 0.000309,
    }))

    // When: the preview is generated.
    const record = await generateAiPreview({ placeId: place.id, provider, repository: decorated })

    // Then: the preview is stored through the unchanged service contract.
    // 제목은 content_plan 계획값으로 후처리 정규화되고, 나머지 필드는 모델 출력 그대로다.
    expect(record.status).toBe("preview")
    expect(record.input.content_plan?.title).toBeDefined()
    expect(record.output).toEqual({ ...VALID_CONTENT, meta_title: record.input.content_plan?.title })
    expect(repository.aiGenerations()).toHaveLength(1)
  })

  it("rejects guardrail-violating output through the existing guardrails", async () => {
    // Given: model output containing a generated phone number.
    const repository = new InMemorySyncRepository()
    const place = await repository.insertPlace(makeSyncedPlaceInput())
    const badContent = { ...VALID_CONTENT, description: "전화 02-1234-5678로 문의하세요." }
    const provider = providerWith(() => Promise.resolve(successPayload(badContent)))

    // When / Then: the existing guardrail rejects it and nothing is stored.
    await expect(generateAiPreview({ placeId: place.id, provider, repository })).rejects.toMatchObject({ name: "AiGuardrailViolationError" })
    expect(repository.aiGenerations()).toHaveLength(0)
  })
})

function makeSyncedPlaceInput(): NewSyncedPlace {
  return {
    source: "google_sheets",
    source_sheet_name: "기업 DB",
    source_row_number: 1,
    source_key: "qa-place-1",
    name: "테스트 장소",
    normalized_name: "테스트 장소",
    category: "장례식장",
    detail_category: null,
    region: null,
    city: "서울",
    district: "강남구",
    address: "서울 강남구 테헤란로 1",
    normalized_address: null,
    phone: null,
    normalized_phone: null,
    homepage: null,
    email: null,
    source_url: null,
    collected_at: null,
    grade: null,
    sales_status: null,
    memo: null,
    imported_payload: {} as SheetPayload,
    synced_at: "2026-07-14T00:00:00.000Z",
    slug: "test-place-1",
  }
}
