import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { FakeDeterministicAiProvider } from "@/lib/ai/fake-provider"
import { mergeGenerationOutputWrapper, parseGenerationVariationAudit, wrapGenerationOutput } from "@/lib/ai/generation-mapping"
import { generateAiPreview } from "@/lib/ai/service"
import type { AiRepository, GenerationVariationAudit, NewAiGeneration } from "@/lib/ai/types"
import { InMemorySyncRepository } from "@/lib/sync/in-memory-repository"
import { syncSheetRows } from "@/lib/sync/service"

const fixturePath = resolve("tests/fixtures/sheet-rows.json")

async function seededRepository(): Promise<InMemorySyncRepository> {
  const rows: unknown = JSON.parse(await readFile(fixturePath, "utf8"))
  const repository = new InMemorySyncRepository()
  await syncSheetRows({ repository, rows, sheetName: "기업 DB" })
  return repository
}

// createAiGeneration 입력을 가로채 audit 전달을 검증한다 (저장 계약은 그대로 위임).
function withCaptor(repository: AiRepository, captured: NewAiGeneration[]): AiRepository {
  return {
    findPlaceById: (placeId) => repository.findPlaceById(placeId),
    findAiGenerationById: (generationId) => repository.findAiGenerationById(generationId),
    applyAiGeneration: (input) => repository.applyAiGeneration(input),
    createAiGeneration: (input) => {
      captured.push(input)
      return repository.createAiGeneration(input)
    },
  }
}

const SAMPLE_AUDIT: GenerationVariationAudit = {
  title_pattern_id: "checklist",
  title_suffix_key: "checklist",
  title_fallback: false,
  keyword_roles: ["official-name", "region-wreath", "place-flower", "faq-intent", "delivery"],
  keywords_rebuilt: false,
  faq_topic_keys: ["pre-order-check", "no-room-name"],
  faq_selection: "hash",
  fallback: false,
}

describe("generation output.audit — 신규 생성 다양화 감사 기록 (PR-S2)", () => {
  it("passes a consistent variation audit alongside the content plan on new generations", async () => {
    // Given: 결정적 provider와 캡처 저장소.
    const repository = await seededRepository()
    const place = repository.places()[0]
    expect(place).toBeDefined()
    if (place === undefined) {
      return
    }
    const captured: NewAiGeneration[] = []

    // When: 신규 생성을 실행한다.
    await generateAiPreview({ placeId: place.id, provider: new FakeDeterministicAiProvider(), repository: withCaptor(repository, captured) })

    // Then: audit가 content_plan과 일치하는 값으로 전달된다.
    const record = captured[0]
    expect(record).toBeDefined()
    const audit = record?.audit
    expect(audit).toBeDefined()
    expect(audit?.title_pattern_id).toBe(record?.input.content_plan?.title_pattern_id)
    expect(audit?.keyword_roles).toEqual(record?.input.content_plan?.keyword_roles)
    expect(audit?.faq_topic_keys).toEqual(record?.input.content_plan?.faq_topic_keys)
    expect(audit?.faq_selection).toBe(record?.input.content_plan?.faq_selection)
    expect(typeof audit?.title_fallback).toBe("boolean")
    expect(typeof audit?.keywords_rebuilt).toBe("boolean")
    // fallback 요약은 세 경로 판정의 OR와 일치한다.
    expect(audit?.fallback).toBe((audit?.title_fallback ?? false) || (audit?.keywords_rebuilt ?? false) || audit?.faq_selection !== "hash")
  })

  it("is deterministic for the same place input", async () => {
    const repository = await seededRepository()
    const place = repository.places()[0]
    if (place === undefined) {
      return
    }
    const first: NewAiGeneration[] = []
    const second: NewAiGeneration[] = []
    await generateAiPreview({ placeId: place.id, provider: new FakeDeterministicAiProvider(), repository: withCaptor(repository, first) })
    await generateAiPreview({ placeId: place.id, provider: new FakeDeterministicAiProvider(), repository: withCaptor(repository, second) })
    expect(first[0]?.audit).toEqual(second[0]?.audit)
  })
})

describe("output.audit 저장·파싱 계약", () => {
  const content = { meta_title: "t", meta_description: "d", description: "body", faq: [], keywords: [], internal_links: [] }

  it("stores audit inside the output wrapper and parses it back", () => {
    const wrapped = wrapGenerationOutput(content, null, null, null, null, SAMPLE_AUDIT)
    expect(parseGenerationVariationAudit(wrapped)).toEqual(SAMPLE_AUDIT)
  })

  it("returns null for legacy records without audit — 역보정하지 않는다", () => {
    const legacy = wrapGenerationOutput(content, null, null, null, null, null)
    expect(parseGenerationVariationAudit(legacy)).toBeNull()
    expect(parseGenerationVariationAudit({ generated: null, after: null })).toBeNull()
    expect(parseGenerationVariationAudit(null)).toBeNull()
  })

  it("rejects malformed audit payloads safely", () => {
    expect(parseGenerationVariationAudit({ audit: { title_pattern_id: 3 } })).toBeNull()
    expect(parseGenerationVariationAudit({ audit: { ...SAMPLE_AUDIT, faq_selection: "unknown" } })).toBeNull()
  })

  it("survives apply and quality-attach merges — audit는 이후 갱신에서도 보존된다", () => {
    const wrapped = wrapGenerationOutput(content, null, null, null, null, SAMPLE_AUDIT)
    const afterApply = mergeGenerationOutputWrapper(wrapped, content, content)
    expect(parseGenerationVariationAudit(afterApply)).toEqual(SAMPLE_AUDIT)
    // attachGenerationQuality와 동일한 spread 패턴
    const afterQuality = { ...(afterApply as Record<string, unknown>), quality: { status: "pass", issues: [] } }
    expect(parseGenerationVariationAudit(afterQuality as never)).toEqual(SAMPLE_AUDIT)
  })
})
