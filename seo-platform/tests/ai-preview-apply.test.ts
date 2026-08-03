import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { FakeDeterministicAiProvider } from "@/lib/ai/fake-provider"
import { AiGuardrailViolationError } from "@/lib/ai/guardrails"
import { applyAiGeneration, generateAiPreview } from "@/lib/ai/service"
import { InMemorySyncRepository } from "@/lib/sync/in-memory-repository"
import { syncSheetRows } from "@/lib/sync/service"

const fixturePath = resolve("tests/fixtures/sheet-rows.json")

async function seededRepository(): Promise<InMemorySyncRepository> {
  const rows: unknown = JSON.parse(await readFile(fixturePath, "utf8"))
  const repository = new InMemorySyncRepository()
  await syncSheetRows({ repository, rows, sheetName: "기업 DB" })
  return repository
}

describe("AI Preview -> Apply domain flow", () => {
  it("creates a preview audit record without mutating public place content", async () => {
    // Given: a synced public place and deterministic non-live AI provider.
    const repository = await seededRepository()
    // 생성은 장례식장(funeral)만 지원한다 — fixture 첫 행은 병원이라 funeral 장소를 고른다.
    const place = repository.places().find((row) => row.category === "funeral")
    expect(place).toBeDefined()
    if (place === undefined) {
      return
    }

    // When: an AI preview is generated for the place.
    const preview = await generateAiPreview({
      placeId: place.id,
      provider: new FakeDeterministicAiProvider(),
      repository,
    })

    // Then: only the audit-like generation record changes; place SEO fields stay public-safe drafts.
    const unchangedPlace = repository.findSeededPlace(place.source_key)
    expect(preview).toMatchObject({ place_id: place.id, status: "preview", applied_at: null })
    expect(repository.aiGenerations()).toHaveLength(1)
    expect(unchangedPlace?.description).toBeNull()
    expect(unchangedPlace?.meta_title).toBeNull()
    expect(unchangedPlace?.meta_description).toBeNull()
    expect(unchangedPlace?.faq).toEqual([])
    expect(unchangedPlace?.keywords).toEqual([])
    expect(unchangedPlace?.internal_links).toEqual([])
  })

  it("applies generated SEO fields and records applied_at", async () => {
    // Given: a preview generation exists for a synced place.
    const repository = await seededRepository()
    // 생성은 장례식장(funeral)만 지원한다 — fixture 첫 행은 병원이라 funeral 장소를 고른다.
    const place = repository.places().find((row) => row.category === "funeral")
    expect(place).toBeDefined()
    if (place === undefined) {
      return
    }
    const preview = await generateAiPreview({
      placeId: place.id,
      provider: new FakeDeterministicAiProvider(),
      repository,
    })

    // When: the preview is applied.
    const applied = await applyAiGeneration({ generationId: preview.id, repository })

    // Then: SEO fields are copied to the place and the generation records applied state/time.
    const updatedPlace = repository.findSeededPlace(place.source_key)
    expect(applied.status).toBe("applied")
    expect(applied.applied_at).toEqual(expect.any(String))
    expect(updatedPlace?.description).toBe(preview.output.description)
    expect(updatedPlace?.meta_title).toBe(preview.output.meta_title)
    expect(updatedPlace?.meta_description).toBe(preview.output.meta_description)
    expect(updatedPlace?.faq).toEqual(preview.output.faq)
    expect(updatedPlace?.keywords).toEqual(preview.output.keywords)
    expect(updatedPlace?.internal_links).toEqual(preview.output.internal_links)
  })

  it("keeps generated output free of phone, email, and price fields or values", async () => {
    // Given: source data contains private phone/email values that AI output must not expose.
    const repository = await seededRepository()
    // 생성은 장례식장(funeral)만 지원한다 — fixture 첫 행은 병원이라 funeral 장소를 고른다.
    const place = repository.places().find((row) => row.category === "funeral")
    expect(place).toBeDefined()
    if (place === undefined) {
      return
    }

    // When: a deterministic preview is generated.
    const preview = await generateAiPreview({
      placeId: place.id,
      provider: new FakeDeterministicAiProvider(),
      repository,
    })

    // Then: guardrails keep forbidden fields absent and forbidden values out of all textual output.
    const serializedOutput = JSON.stringify(preview.output)
    expect(Object.keys(preview.output).sort()).toEqual([
      "description",
      "faq",
      "internal_links",
      "keywords",
      "meta_description",
      "meta_title",
    ])
    expect(serializedOutput).not.toContain("02-123-4567")
    expect(serializedOutput).not.toContain("private@hospital.example.com")
    expect(serializedOutput).not.toMatch(/가격|금액|price|₩|\d+원/iu)
  })

  it("rejects provider output with extra private keys before storing preview", async () => {
    // Given: a buggy provider returns forbidden top-level and nested private keys with null values.
    const repository = await seededRepository()
    // 생성은 장례식장(funeral)만 지원한다 — fixture 첫 행은 병원이라 funeral 장소를 고른다.
    const place = repository.places().find((row) => row.category === "funeral")
    expect(place).toBeDefined()
    if (place === undefined) {
      return
    }
    const buggyProvider = {
      generateSeoContent: () =>
        Promise.resolve({
          description: "안전한 설명",
          meta_title: "안전한 제목",
          meta_description: "안전한 메타 설명",
          faq: [{ question: "질문", answer: "답변", email: null }],
          keywords: ["근조화환"],
          internal_links: [{ href: "/area/seoul", label: "서울", private_note: null }],
          phone: null,
        }),
    }

    // When/Then: strict boundary parsing rejects the output and stores no preview record.
    await expect(
      generateAiPreview({ placeId: place.id, provider: buggyProvider, repository }),
    ).rejects.toBeInstanceOf(AiGuardrailViolationError)
    expect(repository.aiGenerations()).toHaveLength(0)
  })
})
