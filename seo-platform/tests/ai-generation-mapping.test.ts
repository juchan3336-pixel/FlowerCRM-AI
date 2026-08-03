import { describe, expect, it } from "vitest"

import {
  aiGenerationRowToRecord,
  mergeGenerationOutputWrapper,
  parseGenerationStoredMetadata,
  wrapFailedGenerationOutput,
  wrapGenerationInput,
  wrapGenerationOutput,
} from "@/lib/ai/generation-mapping"
import { endAiGeneration, tryBeginAiGeneration } from "@/lib/ai/in-flight"
import type { AiGeneratedSeoContent, AiGenerationInput, AiGenerationMetadata } from "@/lib/ai/types"

const GENERATION_INPUT: AiGenerationInput = {
  content_mode: "condolence" as const,
  place: { id: "place-1", name: "테스트 장소", category: "funeral", city: "서울", district: "강남구", address: "서울 강남구 테헤란로 1", homepage: null },
  guardrails: ["Do not invent facts absent from the source place."],
}

const GENERATED: AiGeneratedSeoContent = {
  description: "본문",
  meta_title: "제목",
  meta_description: "메타",
  faq: [{ question: "질문?", answer: "답변." }],
  keywords: ["키워드"],
  internal_links: [{ href: "/area/seoul", label: "서울" }],
}

describe("ai generation supabase mapping", () => {
  it("round-trips a preview row through the jsonb wrappers", () => {
    // Given: a preview row as stored by the Supabase adapter.
    const row = {
      id: "gen-1",
      place_id: "place-1",
      status: "preview" as const,
      input: wrapGenerationInput(GENERATION_INPUT, null),
      output: wrapGenerationOutput(GENERATED, null),
      model: "FakeDeterministicAiProvider",
      created_at: "2026-07-13T00:00:00.000Z",
      applied_at: null,
    }

    // When: the row maps back to the domain record.
    const record = aiGenerationRowToRecord(row)

    // Then: the domain shape survives the jsonb round trip.
    expect(record.input).toEqual(GENERATION_INPUT)
    expect(record.output).toEqual(GENERATED)
    expect(record.before).toBeNull()
    expect(record.after).toBeNull()
  })

  it("carries before and after snapshots once applied", () => {
    // Given: an applied row with snapshots.
    const before = { description: null, meta_title: null, meta_description: null, faq: [], keywords: [], internal_links: [] }
    const row = {
      id: "gen-1",
      place_id: "place-1",
      status: "applied" as const,
      input: wrapGenerationInput(GENERATION_INPUT, before),
      output: wrapGenerationOutput(GENERATED, GENERATED),
      model: "FakeDeterministicAiProvider",
      created_at: "2026-07-13T00:00:00.000Z",
      applied_at: "2026-07-13T01:00:00.000Z",
    }

    // When: the row maps back.
    const record = aiGenerationRowToRecord(row)

    // Then: the apply snapshots are recovered.
    expect(record.before).toEqual(before)
    expect(record.after).toEqual(GENERATED)
    expect(record.status).toBe("applied")
  })

  it("stores the approved metadata structure and parses it back", () => {
    // Given: an openai generation with usage and estimated cost.
    const metadata: AiGenerationMetadata = {
      provider: "openai",
      model: "gpt-4o-mini",
      usage: { input_tokens: 820, output_tokens: 310, total_tokens: 1130 },
      estimated_cost: 0.000309,
    }

    // When: the wrapper is written and parsed back.
    const wrapped = wrapGenerationOutput(GENERATED, null, metadata)
    const stored = parseGenerationStoredMetadata(wrapped)

    // Then: the fixed JSON structure round-trips.
    expect(stored).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
      usage: { input_tokens: 820, output_tokens: 310, total_tokens: 1130 },
      estimatedCost: 0.000309,
      errorCode: null,
    })
  })

  it("keeps old records without metadata parseable as '기록 없음' values", () => {
    // Given: a legacy wrapper with only generated/after keys.
    const legacy = { generated: GENERATED, after: null } as unknown as Parameters<typeof parseGenerationStoredMetadata>[0]

    // When / Then: parsing never fails and every metadata field is null.
    expect(parseGenerationStoredMetadata(legacy)).toEqual({ provider: null, model: null, usage: null, estimatedCost: null, errorCode: null })
    expect(parseGenerationStoredMetadata(null)).toEqual({ provider: null, model: null, usage: null, estimatedCost: null, errorCode: null })
  })

  it("records failed generations with a safe error code and no content", () => {
    // Given / When: a failed wrapper is written.
    const failed = wrapFailedGenerationOutput({ provider: "openai", model: "gpt-4o-mini" }, "rate_limit")
    const stored = parseGenerationStoredMetadata(failed)

    // Then: only the code and provider identity are stored.
    expect(stored.errorCode).toBe("rate_limit")
    expect(stored.provider).toBe("openai")
    expect(JSON.stringify(failed)).not.toContain("sk-")
  })

  it("preserves metadata when apply merges the wrapper", () => {
    // Given: a preview wrapper with metadata.
    const metadata: AiGenerationMetadata = { provider: "openai", model: "gpt-4o-mini", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }, estimated_cost: null }
    const previewWrapper = wrapGenerationOutput(GENERATED, null, metadata)

    // When: apply rewrites generated/after through the merge helper.
    const merged = mergeGenerationOutputWrapper(previewWrapper, GENERATED, GENERATED)
    const stored = parseGenerationStoredMetadata(merged)

    // Then: provider/usage survive the apply transition.
    expect(stored.provider).toBe("openai")
    expect(stored.usage?.total_tokens).toBe(3)
    expect(parseGenerationStoredMetadata(merged).errorCode).toBeNull()
  })

  it("blocks concurrent in-flight generations per place", () => {
    // Given / When / Then: the same place cannot start twice until released.
    expect(tryBeginAiGeneration("place-lock-1")).toBe(true)
    expect(tryBeginAiGeneration("place-lock-1")).toBe(false)
    expect(tryBeginAiGeneration("place-lock-2")).toBe(true)
    endAiGeneration("place-lock-1")
    expect(tryBeginAiGeneration("place-lock-1")).toBe(true)
    endAiGeneration("place-lock-1")
    endAiGeneration("place-lock-2")
  })

  it("falls back to raw jsonb for rows written without wrappers", () => {
    // Given: a legacy row storing plain payloads.
    const row = {
      id: "gen-legacy",
      place_id: "place-1",
      status: "preview" as const,
      input: GENERATION_INPUT as never,
      output: GENERATED as never,
      model: null,
      created_at: "2026-07-13T00:00:00.000Z",
      applied_at: null,
    }

    // When: the row maps back.
    const record = aiGenerationRowToRecord(row)

    // Then: the payloads still surface without wrappers.
    expect(record.input).toEqual(GENERATION_INPUT)
    expect(record.output).toEqual(GENERATED)
  })
})
