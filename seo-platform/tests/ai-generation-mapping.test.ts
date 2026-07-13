import { describe, expect, it } from "vitest"

import { aiGenerationRowToRecord, wrapGenerationInput, wrapGenerationOutput } from "@/lib/ai/generation-mapping"
import type { AiGeneratedSeoContent, AiGenerationInput } from "@/lib/ai/types"

const GENERATION_INPUT: AiGenerationInput = {
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
