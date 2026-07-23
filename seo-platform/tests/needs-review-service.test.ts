import { beforeEach, describe, expect, it, vi } from "vitest"

import type { BatchItemResultPatch } from "@/lib/batch/supabase-batch-repository"
import type { AiGeneratedSeoContent } from "@/lib/ai/types"
import type { BatchRunItemRow } from "@/types/database"

// 서비스 계층은 server-only + supabase 의존 — 경계를 전부 대역으로 바꿔 상태 전이 계약만 검증한다.
vi.mock("server-only", () => ({}))

const CONTENT: AiGeneratedSeoContent = {
  meta_title: "대구 북구 장례식장 화환 주문 — 예시 장례식장",
  meta_description: "예시 장례식장 근조화환 주문 안내입니다.",
  description: "예시 장례식장에 근조화환을 보내실 때 확인할 정보를 안내합니다.",
  faq: [
    { question: "화환 주문 전에 어떤 정보를 확인해야 하나요?", answer: "빈소명과 수령 장소를 확인합니다." },
    { question: "주소는 어떻게 확인하나요?", answer: "공식 안내에서 확인하실 수 있습니다." },
  ],
  keywords: ["예시 장례식장", "대구 근조화환"],
  internal_links: [],
}

type State = {
  itemStatus: BatchRunItemRow["status"]
  generationStatus: string
  seoPageStatus: string | null
  generationContent: AiGeneratedSeoContent
}

const state: State = { itemStatus: "needs_review", generationStatus: "preview", seoPageStatus: null, generationContent: CONTENT }
const results: { itemId: string; patch: BatchItemResultPatch }[] = []
const events: { eventType: string; fromStatus?: string | null; toStatus?: string | null; step?: string | null }[] = []
const steps: string[] = []
const applyCalls: string[] = []
const seoCalls: string[] = []
const manualEdits: { content: AiGeneratedSeoContent; audit: unknown }[] = []
const quality = vi.fn(() => Promise.resolve<{ status: string; issues: readonly unknown[] } | null>({ status: "pass", issues: [] }))
const seoResult = vi.fn(() => Promise.resolve<{ kind: string; path?: string }>({ kind: "created", path: "/places/example" }))

const ITEM = { id: "item-1", batch_id: "batch-1", place_id: "place-1", generation_id: "gen-1", retry_generation_id: null } as unknown as BatchRunItemRow

vi.mock("@/lib/batch/supabase-batch-repository", () => ({
  createSupabaseBatchRepository: () => ({
    getItem: () => Promise.resolve({ ...ITEM, status: state.itemStatus }),
    // 조건부 claim 재현: needs_review일 때만 성공하고 processing으로 바꾼다.
    claimItemForReview: () => {
      if (state.itemStatus !== "needs_review") return Promise.resolve(null)
      state.itemStatus = "processing"
      events.push({ eventType: "item_claimed", fromStatus: "needs_review", toStatus: "processing", step: "checking" })
      return Promise.resolve({ ...ITEM, status: "processing" })
    },
    touchItemStep: (_itemId: string, step: string) => {
      steps.push(step)
      events.push({ eventType: "item_step_changed", step })
      return Promise.resolve()
    },
    recordItemResult: (itemId: string, patch: BatchItemResultPatch) => {
      if (state.itemStatus !== "processing") return Promise.resolve(false)
      state.itemStatus = patch.status
      results.push({ itemId, patch })
      events.push({ eventType: "item_result_recorded", fromStatus: "processing", toStatus: patch.status })
      return Promise.resolve(true)
    },
  }),
}))

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: state.seoPageStatus === null ? null : { status: state.seoPageStatus } }) }) }) }),
    }),
  }),
}))

vi.mock("@/lib/ai/generation-runner", () => ({ evaluateGenerationQuality: () => quality() }))

vi.mock("@/lib/ai/supabase-repository", () => ({
  createSupabaseAiRepository: () => ({
    findAiGenerationById: () => Promise.resolve({ id: "gen-1", place_id: "place-1", status: state.generationStatus, output: state.generationContent, input: null, created_at: "", applied_at: null, before: null, after: null }),
    findPlaceById: () => Promise.resolve({ id: "place-1", status: "draft", name: "예시 장례식장", phone: null, normalized_phone: null, email: null }),
  }),
  applyManualGenerationEdits: (input: { content: AiGeneratedSeoContent; audit: unknown }) => {
    if (state.generationStatus !== "preview") return Promise.resolve(false)
    manualEdits.push(input)
    state.generationContent = input.content
    return Promise.resolve(true)
  },
}))

vi.mock("@/lib/ai/service", () => ({
  applyAiGeneration: (input: { generationId: string }) => {
    applyCalls.push(input.generationId)
    state.generationStatus = "applied"
    return Promise.resolve({ id: input.generationId, status: "applied" })
  },
}))

vi.mock("@/lib/seo-pages/supabase-place-generation", () => ({ createSupabasePlaceSeoGenerationRepository: () => ({}) }))
vi.mock("@/lib/seo-pages/single-place-generation", () => ({
  generateSinglePlaceSeoPage: (input: { placeId: string }) => {
    seoCalls.push(input.placeId)
    return seoResult()
  },
}))

const BASE_INPUT = { itemId: "item-1", generationId: "gen-1", edits: {}, confirmed: true, actor: "admin@midmgroup.com" }

describe("needs_review 해소 서비스 — 정식 상태 전이", () => {
  beforeEach(() => {
    state.itemStatus = "needs_review"
    state.generationStatus = "preview"
    state.seoPageStatus = null
    state.generationContent = CONTENT
    results.length = 0
    events.length = 0
    steps.length = 0
    applyCalls.length = 0
    seoCalls.length = 0
    manualEdits.length = 0
    quality.mockResolvedValue({ status: "pass", issues: [] })
    seoResult.mockResolvedValue({ kind: "created", path: "/places/example" })
  })

  it("takes needs_review → processing → ready when the re-evaluation passes", async () => {
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")
    const result = await resolveNeedsReviewItem(BASE_INPUT)

    expect(result).toEqual({ kind: "resolved", path: "/places/example", changedFields: [] })
    expect(state.itemStatus).toBe("ready")
    expect(applyCalls).toEqual(["gen-1"])
    expect(seoCalls).toEqual(["place-1"])
    expect(steps).toEqual(["applying"])
    // 이벤트 3종: claim → 단계 전환 → 결과 기록
    expect(events.map((event) => event.eventType)).toEqual(["item_claimed", "item_step_changed", "item_result_recorded"])
    expect(results[0]?.patch).toMatchObject({ status: "ready", lastErrorCode: null, qualityStatus: "pass" })
  })

  it("keeps needs_review and never applies when the re-evaluation is WARN or FAIL", async () => {
    for (const status of ["warn", "fail"] as const) {
      state.itemStatus = "needs_review"
      results.length = 0
      applyCalls.length = 0
      quality.mockResolvedValue({ status, issues: [{ level: status, code: "repeat:keywords" }] })
      const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")
      const result = await resolveNeedsReviewItem(BASE_INPUT)

      expect(result).toEqual({ kind: "quality-not-pass", status })
      expect(state.itemStatus).toBe("needs_review")
      expect(applyCalls).toEqual([])
      expect(seoCalls).toEqual([])
      expect(results[0]?.patch).toMatchObject({ status: "needs_review", lastErrorCode: "review-quality-not-pass" })
    }
  })

  it("requires the explicit confirmation and blocks mismatched targets before touching state", async () => {
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")
    expect(await resolveNeedsReviewItem({ ...BASE_INPUT, confirmed: false })).toEqual({ kind: "blocked", reason: "not-confirmed" })
    expect(await resolveNeedsReviewItem({ ...BASE_INPUT, generationId: "gen-other" })).toEqual({ kind: "blocked", reason: "generation-mismatch" })
    expect(state.itemStatus).toBe("needs_review")
    expect(events).toEqual([])
  })

  it("is a no-op for items that are already ready or published", async () => {
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")
    for (const itemStatus of ["ready", "published"] as const) {
      state.itemStatus = itemStatus
      expect(await resolveNeedsReviewItem(BASE_INPUT)).toEqual({ kind: "blocked", reason: "item-not-needs-review" })
      expect(state.itemStatus).toBe(itemStatus)
      expect(applyCalls).toEqual([])
    }
  })

  it("blocks a repeated click and never applies twice", async () => {
    // 중복 클릭(재제출) — 두 번째 호출은 item이 더 이상 needs_review가 아니라 차단된다.
    // 진짜 동시성은 claimItemForReview의 조건부 UPDATE(.eq status='needs_review')가 DB에서 보장한다.
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")
    const first = await resolveNeedsReviewItem(BASE_INPUT)
    const second = await resolveNeedsReviewItem(BASE_INPUT)

    expect(first.kind).toBe("resolved")
    expect(second).toEqual({ kind: "blocked", reason: "item-not-needs-review" })
    expect(applyCalls).toHaveLength(1)
    expect(seoCalls).toHaveLength(1)
  })

  it("claims only once even if the guard is re-entered while processing", async () => {
    // claim 이후(processing) 재호출은 decide 단계에서 이미 차단된다 — 이벤트·apply가 두 번 나지 않는다.
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")
    state.itemStatus = "processing"
    expect(await resolveNeedsReviewItem(BASE_INPUT)).toEqual({ kind: "blocked", reason: "item-not-needs-review" })
    expect(events).toEqual([])
    expect(applyCalls).toEqual([])
  })

  it("rejects malformed field input without changing any state", async () => {
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")
    const result = await resolveNeedsReviewItem({ ...BASE_INPUT, edits: { faq: "구분자 없는 줄" } })
    expect(result).toEqual({ kind: "invalid-field", field: "faq" })
    expect(state.itemStatus).toBe("needs_review")
    expect(manualEdits).toEqual([])
    expect(events).toEqual([])
  })

  it("stores only the selected field edits with an audit of the previous values", async () => {
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")
    const result = await resolveNeedsReviewItem({ ...BASE_INPUT, edits: { keywords: "예시 장례식장\n대구 북구 근조화환" } })

    expect(result.kind === "resolved" && result.changedFields).toEqual(["keywords"])
    expect(manualEdits).toHaveLength(1)
    expect(manualEdits[0]?.content.keywords).toEqual(["예시 장례식장", "대구 북구 근조화환"])
    // 선택하지 않은 필드는 원문 그대로 저장된다.
    expect(manualEdits[0]?.content.meta_title).toBe(CONTENT.meta_title)
    expect(manualEdits[0]?.audit).toEqual({ resolved_by: "admin@midmgroup.com", changed_fields: ["keywords"], before: { keywords: CONTENT.keywords } })
  })

  it("reverts to needs_review when seo_page creation is blocked, leaving no processing item", async () => {
    seoResult.mockResolvedValue({ kind: "blocked" })
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")
    const result = await resolveNeedsReviewItem(BASE_INPUT)

    expect(result).toEqual({ kind: "failed", reason: "review-seo-page-blocked" })
    expect(state.itemStatus).toBe("needs_review")
    expect(results[0]?.patch).toMatchObject({ status: "needs_review", lastErrorCode: "review-seo-page-blocked" })
  })

  it("resumes an applied generation whose seo_page is missing, without applying twice", async () => {
    // 이전 시도에서 apply까지만 끝난 부분 상태.
    state.generationStatus = "applied"
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")
    const result = await resolveNeedsReviewItem(BASE_INPUT)

    expect(result.kind).toBe("resolved")
    expect(applyCalls).toEqual([])
    expect(seoCalls).toEqual(["place-1"])
    expect(state.itemStatus).toBe("ready")
  })

  it("reverts to needs_review when apply throws", async () => {
    const service = await import("@/lib/ai/service")
    const spy = vi.spyOn(service, "applyAiGeneration").mockRejectedValue(new Error("apply exploded"))
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")
    const result = await resolveNeedsReviewItem(BASE_INPUT)

    expect(result).toEqual({ kind: "failed", reason: "review-unexpected" })
    expect(state.itemStatus).toBe("needs_review")
    expect(seoCalls).toEqual([])
    spy.mockRestore()
  })
})
