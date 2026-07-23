import { beforeEach, describe, expect, it, vi } from "vitest"

import type { BatchItemResultPatch } from "@/lib/batch/supabase-batch-repository"
import type { BatchRunItemRow, BatchRunRow } from "@/types/database"

// Batch 오케스트레이션은 server-only + supabase 의존 — 경계 모듈을 전부 대역으로 바꿔
// "복구 재시도가 단건 액션과 같은 guard를 거치는가"만 검증한다.
vi.mock("server-only", () => ({}))
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceRoleClient: () => ({}) }))

const FAIL_QUALITY = { status: "fail", issues: [{ level: "fail", code: "repeat:faq", message: "FAQ 질문 2개가 모두 기존 페이지와 동일" }] } as const

const results: { itemId: string; patch: BatchItemResultPatch }[] = []
const runPlaceAiGeneration = vi.fn<(input: unknown) => Promise<unknown>>()
const consumedRetryCount = vi.fn(() => Promise.resolve(0))

const ITEM = {
  id: "item-1",
  batch_id: "batch-1",
  place_id: "place-1",
  sequence: 1,
  status: "processing",
  generation_id: "gen-original",
  retry_generation_id: null,
  tokens_input: 900,
  tokens_output: 300,
  cost_usd: 0.0008,
  input_snapshot: { name: "대구병원 장례식장" },
} as unknown as BatchRunItemRow

vi.mock("@/lib/batch/supabase-batch-repository", () => ({
  createSupabaseBatchRepository: () => ({
    getRun: () => Promise.resolve({ id: "batch-1", kind: "generate", status: "running", settings: { max_cost_usd: 0.05, warn_policy: "auto-ready" } } as unknown as BatchRunRow),
    listItems: () => Promise.resolve([]),
    claimNextItem: () => Promise.resolve(ITEM),
    touchItemStep: () => Promise.resolve(),
    recordItemResult: (itemId: string, patch: BatchItemResultPatch) => {
      results.push({ itemId, patch })
      return Promise.resolve(true)
    },
  }),
}))

vi.mock("@/lib/ai/generation-runner", () => ({
  runPlaceAiGeneration: (input: unknown) => runPlaceAiGeneration(input),
  evaluateGenerationQuality: () => Promise.resolve(FAIL_QUALITY),
}))

vi.mock("@/lib/ai/supabase-repository", () => ({
  getAiGenerationRetryLookup: () => Promise.resolve({ id: "gen-original", placeId: "place-1", quality: FAIL_QUALITY, contentPlanFaqKeys: ["unknown-room", "recipient-input"], faqQuestions: [], isRetryGeneration: false }),
  countConsumedQualityFailRetriesOf: () => consumedRetryCount(),
  listGenerationAvoidanceSources: () => Promise.resolve(new Map()),
}))

describe("Batch 복구 재시도 — 단건 액션과 같은 guard", () => {
  beforeEach(() => {
    results.length = 0
    runPlaceAiGeneration.mockReset()
    consumedRetryCount.mockReset()
  })

  it("runs the controlled retry when the recovery attempt is still available", async () => {
    // Given: 소진 0회 — repeat:faq FAIL 원본.
    consumedRetryCount.mockResolvedValue(0)
    runPlaceAiGeneration.mockResolvedValue({ kind: "generated", generationId: "gen-retry", quality: { status: "pass", issues: [] }, provider: "openai", model: "gpt-4.1-mini", usage: null, estimatedCostUsd: null })
    const { processNextGenerationItem } = await import("@/lib/batch/generation-batch-service")

    await processNextGenerationItem("batch-1")

    // Then: 원본을 참조하는 재시도 컨텍스트로 실행된다.
    expect(runPlaceAiGeneration).toHaveBeenCalledTimes(1)
    expect(runPlaceAiGeneration.mock.calls[0]?.[0]).toMatchObject({ placeId: "place-1", retry: { of: "gen-original", reason: "quality-fail-repeat-faq" } })
  })

  it("skips the retry entirely when the recovery attempt is already consumed", async () => {
    // Given: 소진 1회 — generation이 남지 않은 과거 시도까지 포함한 내구적 판정값.
    consumedRetryCount.mockResolvedValue(1)
    const { processNextGenerationItem } = await import("@/lib/batch/generation-batch-service")

    const outcome = await processNextGenerationItem("batch-1")

    // Then: AI를 다시 호출하지 않고, preview를 보존한 채 검토 대기로 남긴다.
    expect(runPlaceAiGeneration).not.toHaveBeenCalled()
    expect(outcome.processed).toMatchObject({ status: "needs_review", reason: "quality-fail-retry-blocked" })
    expect(results).toHaveLength(1)
    expect(results[0]?.patch).toMatchObject({ status: "needs_review", generationId: "gen-original", lastErrorCode: "quality-fail-retry-blocked" })
    // 차단은 소진이 아니므로 retry- 접두 코드를 남기지 않는다 (다시 소진으로 읽히면 안 된다).
    expect(results[0]?.patch.lastErrorCode?.startsWith("retry-")).toBe(false)
  })

  it("does not burn the attempt when the retry could not start (misconfigured)", async () => {
    // Given: 재시도가 provider 호출 전 차단됨.
    consumedRetryCount.mockResolvedValue(0)
    runPlaceAiGeneration.mockResolvedValue({ kind: "misconfigured", errorCode: "api_key_missing" })
    const { processNextGenerationItem } = await import("@/lib/batch/generation-batch-service")

    await processNextGenerationItem("batch-1")

    // Then: 소진 흔적(retry- 접두·소진 메시지)을 남기지 않아 재시도 1회가 유지된다.
    const patch = results[0]?.patch
    expect(patch?.status).toBe("failed")
    expect(patch?.lastErrorCode).toBe("api_key_missing")
    expect(patch?.lastErrorMessage).toBe("복구 재시도 시작 불가: api_key_missing")
  })

  it("burns the attempt when the retry failed after the provider call started", async () => {
    consumedRetryCount.mockResolvedValue(0)
    runPlaceAiGeneration.mockResolvedValue({ kind: "failed", errorCode: "timeout" })
    const { processNextGenerationItem } = await import("@/lib/batch/generation-batch-service")

    await processNextGenerationItem("batch-1")

    const patch = results[0]?.patch
    expect(patch?.status).toBe("failed")
    expect(patch?.lastErrorCode).toBe("retry-timeout")
    expect(patch?.lastErrorMessage).toBe("복구 재시도 실패: timeout")
  })
})
