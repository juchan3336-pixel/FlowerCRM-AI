import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AiRepository, NewAiGeneration } from "@/lib/ai/types"

// 생성 코어는 supabase 저장소를 동적 import한다 — 저장소 전체를 대역으로 바꿔 가드 동작만 검증한다.
const created: NewAiGeneration[] = []
const failures: Readonly<{ errorCode: string; retry?: unknown }>[] = []
const hasRecentPreview = vi.fn(() => Promise.resolve(true))

const PLACE = {
  id: "0780adcc-f7dc-4385-9870-c78e6c9b5012",
  name: "대구병원 장례식장",
  category: "funeral",
  city: "대구",
  district: "북구",
  address: "대구 북구 칠곡중앙대로 194 지하1층",
  homepage: null,
  phone: "053-311-4488",
  normalized_phone: "0533114488",
  email: null,
  slug: "funeral-daegu-bukgu-daegubyeongwon-jangryesikjang",
  description: null,
  meta_title: null,
  meta_description: null,
  faq: [],
  keywords: [],
  internal_links: [],
}

vi.mock("@/lib/ai/supabase-repository", () => ({
  createSupabaseAiRepository: (): AiRepository => ({
    findPlaceById: () => Promise.resolve(PLACE as unknown as Awaited<ReturnType<AiRepository["findPlaceById"]>>),
    createAiGeneration: (input) => {
      created.push(input)
      return Promise.resolve({ id: "gen-new", place_id: input.placeId, status: "preview", input: input.input, output: input.output, before: null, after: null, created_at: "", applied_at: null })
    },
    // 품질 재평가는 레코드를 찾지 못하면 null을 반환하고 조용히 끝난다 — 이 테스트의 관심사가 아니다.
    findAiGenerationById: () => Promise.resolve(undefined),
    applyAiGeneration: () => Promise.reject(new Error("not used")),
  }),
  hasRecentPreviewAiGeneration: () => hasRecentPreview(),
  recordFailedAiGeneration: (input: Readonly<{ errorCode: string; retry?: unknown }>) => {
    failures.push(input)
    return Promise.resolve()
  },
  listRecentPublishedContentSnapshots: () => Promise.resolve([]),
  listVerifiedInternalPaths: () => Promise.resolve(new Set<string>()),
  attachGenerationQuality: () => Promise.resolve(),
  // 반복 실패 잠금 — 이 테스트 묶음은 잠금이 없는 상태를 전제한다 (잠금 자체는 ls-provider-error-diagnosis에서 검증).
  listRecentAiGenerationOutcomes: () => Promise.resolve([]),
}))

const RETRY = { of: "67b3fd0d-1724-4ed7-8308-b717b91ad8aa", reason: "quality-fail-repeat-faq", bannedFaqPairs: [] } as const

describe("복구 재시도와 최근 preview 가드", () => {
  beforeEach(() => {
    created.length = 0
    failures.length = 0
    hasRecentPreview.mockClear()
    delete process.env["AI_PROVIDER"]
    delete process.env["OPENAI_API_KEY"]
  })

  it("blocks an ordinary re-click while a recent preview exists", async () => {
    const { runPlaceAiGeneration } = await import("@/lib/ai/generation-runner")
    const result = await runPlaceAiGeneration({ placeId: PLACE.id })
    expect(result.kind).toBe("recent-preview")
    expect(created).toHaveLength(0)
  })

  it("lets the controlled recovery retry through the same guard (Batch는 원본 직후 재시도한다)", async () => {
    // Given: 원본 생성 직후 — 최근 preview 가드는 여전히 참.
    const { runPlaceAiGeneration } = await import("@/lib/ai/generation-runner")

    // When: 복구 재시도 컨텍스트로 호출하면
    const result = await runPlaceAiGeneration({ placeId: PLACE.id, retry: { ...RETRY, bannedFaqPairs: [] } })

    // Then: 가드를 조회하지 않고 진행해 재시도 generation이 실제로 생성된다 (원본은 건드리지 않는다).
    expect(hasRecentPreview).not.toHaveBeenCalled()
    expect(result.kind).toBe("generated")
    expect(created).toHaveLength(1)
    expect(created[0]?.retry).toEqual({ of: RETRY.of, reason: RETRY.reason })
  })

  it("does not consume the retry when the provider call never started (misconfigured)", async () => {
    // Given: OpenAI 선택인데 키가 없어 호출 전 차단되는 재시도.
    process.env["AI_PROVIDER"] = "openai"
    const { runPlaceAiGeneration } = await import("@/lib/ai/generation-runner")

    const result = await runPlaceAiGeneration({ placeId: PLACE.id, retry: { ...RETRY, bannedFaqPairs: [] } })

    // Then: 부작용이 없으므로 실패 레코드에 retry 감사 기록을 붙이지 않는다 — 재시도 1회는 남는다.
    expect(result.kind).toBe("misconfigured")
    expect(created).toHaveLength(0)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.retry).toBeNull()
  })

  it("records the retry audit when the provider call failed after starting", async () => {
    // Given: provider 호출이 시작된 뒤 실패하는 재시도 (fake provider가 예외를 던지도록 대역 교체).
    const { runPlaceAiGeneration } = await import("@/lib/ai/generation-runner")
    const { FakeDeterministicAiProvider } = await import("@/lib/ai/fake-provider")
    const spy = vi.spyOn(FakeDeterministicAiProvider.prototype, "generateSeoContent").mockRejectedValue(new Error("provider exploded"))

    const result = await runPlaceAiGeneration({ placeId: PLACE.id, retry: { ...RETRY, bannedFaqPairs: [] } })

    // Then: generation은 남지 않지만 실패 레코드가 원본을 참조해 "1회 소진"이 DB에 남는다.
    expect(result.kind).toBe("failed")
    expect(created).toHaveLength(0)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.retry).toEqual({ of: RETRY.of, reason: RETRY.reason })
    spy.mockRestore()
  })

  it("does not attach a retry audit when an ordinary generation fails", async () => {
    process.env["AI_PROVIDER"] = "openai"
    const { runPlaceAiGeneration } = await import("@/lib/ai/generation-runner")

    await runPlaceAiGeneration({ placeId: PLACE.id })

    expect(failures).toHaveLength(1)
    expect(failures[0]?.retry).toBeNull()
  })
})
