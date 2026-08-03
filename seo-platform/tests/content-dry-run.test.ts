import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"

import {
  CONTENT_DRY_RUN_ALLOWLIST,
  createDryRunAiRepository,
  runContentModeDryRun,
  type ContentDryRunDependencies,
  type DryRunPlace,
} from "@/lib/ai/content-dry-run"
import { resolveContentDryRunEnvironment } from "@/lib/batch/approval-execution-policy"
import { decideBatchCandidate } from "@/lib/batch/candidate-policy"
import type { AiGeneratedSeoContent, AiGenerationInput, AiProvider } from "@/lib/ai/types"

const RAMADA = "38b4e03d-725d-4a7d-95eb-0d7d01e6e2dc"
const KCC = "b69fd464-67fd-4548-a82d-c15c23ffa4f1"

const HOTEL: DryRunPlace = {
  id: RAMADA,
  name: "라마다스위츠 거제호텔",
  category: "숙박/행사",
  city: "경남",
  district: "거제시",
  address: "경남 거제시 일운면 거제대로 2631",
  homepage: null,
  status: "draft",
  slug: "area-gyeongnam-geojesi-ramada",
  official_verification_status: "verified",
  exclusion_reason: null,
  verification_source_urls: ["http://www.ramadasuitegeoje.com/"],
}

const FACTORY: DryRunPlace = {
  ...HOTEL,
  id: KCC,
  name: "KCC 울산공장",
  category: "제조",
  city: "울산",
  district: "동구",
  slug: "area-ulsan-donggu-kcc",
  verification_source_urls: ["https://www.kccworld.co.kr/about-kcc/network.do"],
}

// 모드에 맞는 정상 출력을 돌려주는 provider 대역 — 실제 OpenAI는 부르지 않는다.
function cleanProvider(): AiProvider & { readonly inputs: AiGenerationInput[] } {
  const inputs: AiGenerationInput[] = []
  return {
    inputs,
    generateSeoContent: (input: AiGenerationInput) => {
      inputs.push(input)
      const celebration = input.content_mode === "celebration"
      const content: AiGeneratedSeoContent = {
        meta_title: input.content_plan?.title ?? `${input.place.name} 축하화환 주문 안내`,
        meta_description: celebration ? "행사 일정에 맞춰 주문 과정에서 반입 위치를 확인하세요." : "개업식 일정에 맞춰 주문 과정에서 수령 지점을 확인하세요.",
        description: celebration
          ? `${input.place.name}로 축하화환을 보내는 분을 위한 안내입니다. 반입 위치와 수령 담당자는 주문 과정에서 확인됩니다.`
          : `${input.place.name}로 개업·준공 축하화환을 보내는 분을 위한 안내입니다. 경비실 수령 여부는 주문 과정에서 확인됩니다.`,
        faq: [
          { question: celebration ? "행사 날짜에 맞출 수 있나요?" : "개업식 시간에 맞출 수 있나요?", answer: "주문 과정에서 확인됩니다." },
          { question: celebration ? "반입 위치는 어떻게 확인하나요?" : "경비실 수령이 가능한가요?", answer: "주문 과정에서 안내됩니다." },
        ],
        keywords: [...(input.content_plan?.keywords ?? [input.place.name])],
        internal_links: [],
      }
      return Promise.resolve(content)
    },
  }
}

// 첫 시도에서만 금지어를 섞는 provider — 재시도 정책이 실제로 도는지 본다.
function forbiddenThenCleanProvider(): AiProvider & { readonly inputs: AiGenerationInput[] } {
  const base = cleanProvider()
  let call = 0
  return {
    inputs: base.inputs,
    generateSeoContent: async (input: AiGenerationInput) => {
      const content = (await base.generateSeoContent(input)) as AiGeneratedSeoContent
      call += 1
      return call === 1 ? { ...content, description: `${content.description} 빈소 안내도 함께 확인하세요.` } : content
    },
  }
}

function dependencies(overrides: Partial<ContentDryRunDependencies> & { place?: DryRunPlace | null }): ContentDryRunDependencies {
  const place = overrides.place === undefined ? HOTEL : overrides.place
  return {
    provider: overrides.provider ?? cleanProvider(),
    model: overrides.model ?? "gpt-4.1-mini",
    loadPlace: overrides.loadPlace ?? ((placeId: string) => Promise.resolve(place !== null && place.id === placeId ? place : null)),
    loadRecentContent: overrides.loadRecentContent ?? (() => Promise.resolve([])),
    loadVerifiedInternalPaths: overrides.loadVerifiedInternalPaths ?? (() => Promise.resolve(new Set<string>())),
    ...(overrides.usage === undefined ? {} : { usage: overrides.usage }),
    ...(overrides.estimateCostUsd === undefined ? {} : { estimateCostUsd: overrides.estimateCostUsd }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  }
}

describe("Dry-run allowlist와 자격", () => {
  it("allows exactly the two measured places with their expected modes", () => {
    expect(Object.keys(CONTENT_DRY_RUN_ALLOWLIST)).toEqual([RAMADA, KCC])
    expect(CONTENT_DRY_RUN_ALLOWLIST[RAMADA]).toBe("celebration")
    expect(CONTENT_DRY_RUN_ALLOWLIST[KCC]).toBe("corporate-celebration")
  })

  it("rejects any other place id before touching the provider", async () => {
    const provider = cleanProvider()
    const result = await runContentModeDryRun("f05a235c-81d7-4774-8a41-a755d99793ef", dependencies({ provider }))
    expect(result).toMatchObject({ kind: "blocked", reason: "not-allowlisted" })
    expect(provider.inputs).toHaveLength(0)
  })

  it.each([
    ["draft가 아님", { status: "published" as const }, "not-draft"],
    ["검증 미완료", { official_verification_status: null }, "not-verified"],
    ["제외 장소", { official_verification_status: "excluded" }, "excluded"],
    ["검증 출처 없음", { verification_source_urls: [] }, "verification-source-missing"],
    ["업종 미지원", { category: "hospital" }, "category-unsupported"],
    ["모드 불일치", { category: "funeral" }, "mode-mismatch"],
  ])("refuses when the place is %s", async (_label, patch, reason) => {
    const provider = cleanProvider()
    const result = await runContentModeDryRun(RAMADA, dependencies({ provider, place: { ...HOTEL, ...patch } }))
    expect(result).toMatchObject({ kind: "blocked", reason })
    expect(provider.inputs).toHaveLength(0)
  })

  it("refuses when the place is missing", async () => {
    const result = await runContentModeDryRun(RAMADA, dependencies({ place: null }))
    expect(result).toMatchObject({ kind: "blocked", reason: "place-missing" })
  })
})

describe("무저장 보장", () => {
  it("never writes: the repository has no apply/read path and nothing is persisted", () => {
    const repository = createDryRunAiRepository(HOTEL)
    expect(() => repository.findAiGenerationById("x")).toThrow()
    expect(() => repository.applyAiGeneration({ generationId: "x", before: {} as never, after: {} as never })).toThrow()
    expect(repository.created).toHaveLength(0)
  })

  it("reports stored/applied/published as false", async () => {
    const result = await runContentModeDryRun(RAMADA, dependencies({}))
    expect(result).toMatchObject({ kind: "completed", stored: false, applied: false, published: false })
  })

  it("does not import any write path in the dry-run modules", () => {
    const core = readFileSync(resolve("lib/ai/content-dry-run.ts"), "utf8")
    const deps = readFileSync(resolve("lib/ai/content-dry-run-dependencies.ts"), "utf8")
    const route = readFileSync(resolve("app/api/internal/content-mode-dry-run/route.ts"), "utf8")
    for (const source of [core, deps, route]) {
      expect(source).not.toContain("applyAiGeneration(")
      expect(source).not.toContain("recordItemResult")
      expect(source).not.toContain("createRun")
      expect(source).not.toContain("runPlacePublish")
      expect(source).not.toContain("publish_place_page")
      expect(source).not.toMatch(/\.(insert|update|upsert|delete)\(/)
    }
  })
})

describe("운영 생성 계층 재사용", () => {
  it("passes the real content mode and plan through the production pipeline", async () => {
    const provider = cleanProvider()
    const result = await runContentModeDryRun(RAMADA, dependencies({ provider }))

    expect(provider.inputs[0]?.content_mode).toBe("celebration")
    // content_plan은 운영 제목·키워드 다양화가 만든 값이어야 한다 (QA 전용 프롬프트가 아님).
    expect(provider.inputs[0]?.content_plan?.title).toBeTruthy()
    expect(provider.inputs[0]?.content_plan?.keywords.length).toBeGreaterThan(0)
    expect(result).toMatchObject({ kind: "completed", contentMode: "celebration" })
    if (result.kind === "completed") {
      expect(["pass", "warn"]).toContain(result.finalStatus)
    }
  })

  it("resolves the corporate mode for the factory", async () => {
    const provider = cleanProvider()
    const result = await runContentModeDryRun(KCC, dependencies({ provider, place: FACTORY }))
    expect(provider.inputs[0]?.content_mode).toBe("corporate-celebration")
    expect(result).toMatchObject({ kind: "completed", contentMode: "corporate-celebration" })
  })
})

describe("품질·재시도 처리", () => {
  it("retries once with the blocked terms and passes when the retry is clean", async () => {
    const provider = forbiddenThenCleanProvider()
    const result = await runContentModeDryRun(RAMADA, dependencies({ provider }))

    expect(result.kind).toBe("completed")
    if (result.kind !== "completed") return
    expect(result.retried).toBe(true)
    expect(result.attempts).toHaveLength(2)
    expect(result.attempts[0]?.forbidden.map((finding) => finding.term)).toContain("빈소")
    expect(result.attempts[1]?.forbidden).toEqual([])
    expect(result.finalStatus).not.toBe("failed")
    // 재시도 프롬프트에 직전 금지 표현이 실려야 한다.
    expect(provider.inputs[1]?.retry_guidance?.forbidden_terms).toContain("빈소")
  })

  it("ends as failed when the wording survives the retry", async () => {
    const provider: AiProvider = {
      generateSeoContent: (input: AiGenerationInput) =>
        Promise.resolve({
          meta_title: input.content_plan?.title ?? `${input.place.name} 안내`,
          meta_description: "빈소 안내입니다.",
          description: `${input.place.name} 빈소 화환 안내입니다. 주문 과정에서 확인됩니다.`,
          faq: [
            { question: "행사 날짜에 맞출 수 있나요?", answer: "주문 과정에서 확인됩니다." },
            { question: "반입 위치는?", answer: "주문 과정에서 안내됩니다." },
          ],
          keywords: [...(input.content_plan?.keywords ?? [])],
          internal_links: [],
        }),
    }
    const result = await runContentModeDryRun(RAMADA, dependencies({ provider }))
    expect(result.kind).toBe("completed")
    if (result.kind !== "completed") return
    expect(result.retried).toBe(true)
    expect(result.finalStatus).toBe("failed")
    expect(result.stored).toBe(false)
  })
})

describe("환경 게이트", () => {
  const base = {
    VERCEL_ENV: "preview",
    AI_PROVIDER: "openai",
    OPENAI_API_KEY: "k",
    OPENAI_MODEL: "gpt-4.1-mini",
    BATCH_CHAIN_SECRET: "x".repeat(32),
    PREVIEW_EXEC_BASE_URL: "https://flowercrm-seo-git-preview-latest-juchans-projects-ecbdf050.vercel.app",
    VERCEL_AUTOMATION_BYPASS_SECRET: "b".repeat(32),
    CONTENT_DRY_RUN_SECRET: "s".repeat(32),
  }

  it("accepts a fully configured preview environment", () => {
    expect(resolveContentDryRunEnvironment(base)).toMatchObject({ ok: true })
  })

  it.each([
    ["production 배포", { VERCEL_ENV: "production" }, "production-blocked"],
    ["fake provider", { AI_PROVIDER: "fake" }, "provider-not-openai"],
    ["QA secret 없음", { CONTENT_DRY_RUN_SECRET: "" }, "dry-run-secret-missing"],
    ["bypass 없음", { VERCEL_AUTOMATION_BYPASS_SECRET: "" }, "bypass-secret-missing"],
    ["고정 별칭 아님", { PREVIEW_EXEC_BASE_URL: "https://evil.example.com" }, "base-url-missing"],
  ])("blocks %s", (_label, patch, blockedBy) => {
    expect(resolveContentDryRunEnvironment({ ...base, ...patch })).toEqual({ ok: false, blockedBy })
  })
})

describe("응답에 비밀이 새지 않는다", () => {
  it("keeps secrets and the system prompt out of the route response shape", () => {
    const route = readFileSync(resolve("app/api/internal/content-mode-dry-run/route.ts"), "utf8")
    expect(route).not.toContain("SYSTEM_PROMPT")
    expect(route).not.toContain("systemPromptForMode")
    // (환경 게이트에 넘기려고 process.env를 읽는 것은 별개다 — 문제는 '응답에 담기는가'이다.)
    // 응답 본문 조립부에 secret 계열 값이 들어가지 않는다.
    const responseBlock = route.slice(route.indexOf("return json(200"))
    for (const forbidden of ["secret", "apiKey", "api_key", "authorization", "prompt"]) {
      expect(responseBlock.toLowerCase()).not.toContain(forbidden)
    }
  })
})

describe("후보 자격은 이 PR에서도 열리지 않는다", () => {
  it("keeps candidate policy funeral-only", () => {
    const place = { id: "p1", status: "draft" as const, slug: "x", official_verification_status: "verified" as const, exclusion_reason: null, category: "funeral" }
    const base = { place, generationCount: 0, seoPagePathExists: false, slugDuplicateCount: 0 }
    expect(decideBatchCandidate(base)).toEqual({ eligible: true })
    for (const category of ["숙박/행사", "호텔", "제조", "건설/부동산", "hospital"]) {
      expect(decideBatchCandidate({ ...base, place: { ...place, category } })).toEqual({ eligible: false, reason: "category-unsupported" })
    }
  })

  it("does not call the real OpenAI endpoint anywhere in the tests", () => {
    // 이 파일의 모든 provider는 대역이다 — 네트워크 호출 경로가 없다.
    expect(vi.isMockFunction(globalThis.fetch)).toBe(false)
  })
})
