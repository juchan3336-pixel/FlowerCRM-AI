import { createHash } from "node:crypto"

import { beforeEach, describe, expect, it, vi } from "vitest"

import { addressResolutionRecordOf, resolveVerifiedAddress, VERIFIED_ADDRESSES, type AddressResolutionRecord, type VerifiedAddressEntry } from "@/lib/domain/verified-address"

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

// jsonb 흉내 — 실제 DB는 객체 키를 (바이트 길이, 바이트 순)으로 다시 정렬해 저장한다. 운영 코드와 독립적으로 구현한다.
function jsonb<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => jsonb(entry)) as unknown as T
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).filter((key) => record[key] !== undefined)
    keys.sort((left, right) => new TextEncoder().encode(left).length - new TextEncoder().encode(right).length || (left < right ? -1 : left > right ? 1 : 0))
    return Object.fromEntries(keys.map((key) => [key, jsonb(record[key])])) as T
  }
  return value
}

// 저장된 generated의 해시 — 운영 해시 함수와 독립적으로, 같은 정의(6개 필드 배열의 SHA-256)를 jsonb 모양에서 계산한다.
function storedHash(content: AiGeneratedSeoContent): string {
  const shaped = jsonb(content)
  return createHash("sha256")
    .update(JSON.stringify([shaped.meta_title, shaped.meta_description, shaped.description, shaped.faq, shaped.keywords, shaped.internal_links]), "utf8")
    .digest("hex")
}

// 수동 보정 저장 직전에 끼어드는 훅 — "검토 뒤 ~ 저장 전" 사이에 다른 경로가 글을 바꾼 상황을 만든다.
let beforeManualEdit: (() => void) | null = null

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

// 검수 주소 가드 검증용 — 등록 장소로 바꿔 끼우거나 생성 입력의 주소 기록을 넣는다.
let placeOverride: Record<string, unknown> = {}
let generationInput: unknown = null

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

const qualityCalls: { generationId: string; options: unknown }[] = []
vi.mock("@/lib/ai/generation-runner", () => ({
  evaluateGenerationQuality: (generationId: string, options?: unknown) => {
    qualityCalls.push({ generationId, options })
    return quality()
  },
}))
// 같은 배치의 앞선 본문 — 해소 재평가도 최초 평가와 같은 문맥을 써야 한다.
const PRIOR_BODIES = [{ placeName: "앞선 장례식장", region: null, description: "앞선 item의 본문입니다." }]
const loadBatchAvoidanceForItem = vi.fn(() => Promise.resolve({ titlePatterns: [], faqPairs: [], keywordSets: [], bodies: PRIOR_BODIES }))
vi.mock("@/lib/batch/generation-batch-service", () => ({ loadBatchAvoidanceForItem: () => loadBatchAvoidanceForItem() }))

vi.mock("@/lib/ai/supabase-repository", () => ({
  createSupabaseAiRepository: () => ({
    findAiGenerationById: () => Promise.resolve({ id: "gen-1", place_id: "place-1", status: state.generationStatus, output: state.generationContent, input: generationInput, created_at: "", applied_at: null, before: null, after: null }),
    findPlaceById: () => Promise.resolve({ id: "place-1", status: "draft", name: "예시 장례식장", phone: null, normalized_phone: null, email: null, ...placeOverride }),
  }),
  applyManualGenerationEdits: (input: { content: AiGeneratedSeoContent; audit: unknown; expectedGeneratedHash?: string }) => {
    beforeManualEdit?.()
    if (state.generationStatus !== "preview") return Promise.resolve(false)
    // 실제 repository처럼 저장된 generated가 검토한 글일 때만 쓴다.
    if (input.expectedGeneratedHash !== undefined && storedHash(state.generationContent) !== input.expectedGeneratedHash) return Promise.resolve(false)
    manualEdits.push(input)
    state.generationContent = jsonb(input.content)
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

function liveAddressEntry(): VerifiedAddressEntry {
  const [entry] = VERIFIED_ADDRESSES
  if (entry === undefined) {
    throw new Error("운영 맵이 비어 있습니다")
  }
  return entry
}

function liveAddressRecord(): AddressResolutionRecord {
  const entry = liveAddressEntry()
  const matched = resolveVerifiedAddress({ placeId: entry.placeId, slug: entry.expectedSlug, name: entry.expectedName, rawAddress: entry.expectedRawAddress })
  if (matched.kind !== "matched") {
    throw new Error("운영 엔트리가 matched가 아닙니다")
  }
  return addressResolutionRecordOf(matched)
}

const BASE_INPUT = { itemId: "item-1", generationId: "gen-1", edits: {}, confirmed: true, actor: "admin@midmgroup.com" }

describe("needs_review 해소 서비스 — 정식 상태 전이", () => {
  beforeEach(() => {
    state.itemStatus = "needs_review"
    state.generationStatus = "preview"
    state.seoPageStatus = null
    state.generationContent = CONTENT
    placeOverride = {}
    generationInput = null
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

    expect(result).toEqual({ kind: "resolved", path: "/places/example", changedFields: [], itemStatus: "ready" })
    expect(state.itemStatus).toBe("ready")
    expect(applyCalls).toEqual(["gen-1"])
    expect(seoCalls).toEqual(["place-1"])
    expect(steps).toEqual(["applying"])
    // 이벤트 3종: claim → 단계 전환 → 결과 기록
    expect(events.map((event) => event.eventType)).toEqual(["item_claimed", "item_step_changed", "item_result_recorded"])
    expect(results[0]?.patch).toMatchObject({ status: "ready", lastErrorCode: null, qualityStatus: "pass" })
  })

  // 검수 주소 — 적용 경로와 재개 경로(이미 적용됨, SEO만 남음) 모두 상태를 바꾸기 전에 막혀야 한다.
  it.each([
    ["apply", "preview"],
    ["resume-seo-page", "applied"],
  ] as const)("blocks the %s path without touching the item when the registered place has no address record", async (_mode, generationStatus) => {
    const entry = liveAddressEntry()
    state.generationStatus = generationStatus
    placeOverride = { id: entry.placeId, slug: entry.expectedSlug, name: entry.expectedName, address: entry.expectedRawAddress }
    generationInput = { place: {} }
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")

    expect(await resolveNeedsReviewItem(BASE_INPUT)).toEqual({ kind: "blocked", reason: "verified-address-blocked" })
    expect(state.itemStatus).toBe("needs_review")
    expect(events).toEqual([])
    expect(applyCalls).toEqual([])
    expect(seoCalls).toEqual([])
  })

  it("blocks the resume path when the raw address drifted or the record is from another revision", async () => {
    const entry = liveAddressEntry()
    const record = liveAddressRecord()
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")
    for (const [place, input] of [
      [{ address: `${entry.verifiedAddress} 9층` }, { address_resolution: record }],
      [{}, { address_resolution: { ...record, revision: 99 } }],
    ] as const) {
      state.itemStatus = "needs_review"
      state.generationStatus = "applied"
      placeOverride = { id: entry.placeId, slug: entry.expectedSlug, name: entry.expectedName, address: entry.expectedRawAddress, ...place }
      generationInput = input

      expect(await resolveNeedsReviewItem(BASE_INPUT)).toEqual({ kind: "blocked", reason: "verified-address-blocked" })
      expect(state.itemStatus).toBe("needs_review")
      expect(seoCalls).toEqual([])
    }
  })

  it("lets a registered place through when the record matches the current entry", async () => {
    const entry = liveAddressEntry()
    state.generationStatus = "applied"
    placeOverride = { id: entry.placeId, slug: entry.expectedSlug, name: entry.expectedName, address: entry.expectedRawAddress }
    generationInput = { address_resolution: liveAddressRecord() }
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")

    expect((await resolveNeedsReviewItem(BASE_INPUT)).kind).toBe("resolved")
    expect(seoCalls).toHaveLength(1)
  })

  it("resolves to warn_ready when the re-evaluation is WARN — the explicit confirmation overrides warn-level issues", async () => {
    // 자동 경로의 warn_policy=auto-ready와 같은 수준 — 사람이 확인란에 동의한 해소는 warn을 허용한다.
    quality.mockResolvedValue({ status: "warn", issues: [{ level: "warn", code: "repeat:title" }] })
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")
    const result = await resolveNeedsReviewItem(BASE_INPUT)

    expect(result).toEqual({ kind: "resolved", path: "/places/example", changedFields: [], itemStatus: "warn_ready" })
    expect(state.itemStatus).toBe("warn_ready")
    expect(applyCalls).toEqual(["gen-1"])
    expect(seoCalls).toEqual(["place-1"])
    expect(results[0]?.patch).toMatchObject({ status: "warn_ready", lastErrorCode: null, qualityStatus: "warn" })
  })

  it("keeps needs_review and never applies when the re-evaluation is FAIL or carries a fail-level issue", async () => {
    for (const evaluated of [
      { status: "fail" as const, issues: [{ level: "fail", code: "repeat:first-sentence" }] },
      // status가 warn이라도 fail 수준 issue가 섞여 있으면 사람 확인만으로는 통과할 수 없다.
      { status: "warn" as const, issues: [{ level: "fail", code: "banned:price" }] },
    ]) {
      state.itemStatus = "needs_review"
      results.length = 0
      applyCalls.length = 0
      quality.mockResolvedValue(evaluated)
      const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")
      const result = await resolveNeedsReviewItem(BASE_INPUT)

      expect(result).toEqual({ kind: "quality-not-pass", status: evaluated.status })
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

// 2026-11-10 — 배치 내 본문 비교가 생긴 뒤, 검토 해소가 그 문맥 없이 재평가하면
// 첫 문장 중복으로 needs_review가 된 item이 해소 과정에서 pass로 덮여 그대로 게시 준비된다.
describe("검토 해소의 재평가는 최초 평가와 같은 배치 문맥을 쓴다", () => {
  beforeEach(() => {
    state.itemStatus = "needs_review"
    state.generationStatus = "preview"
    state.seoPageStatus = null
    state.generationContent = CONTENT
    placeOverride = {}
    generationInput = null
    results.length = 0
    applyCalls.length = 0
    seoCalls.length = 0
    qualityCalls.length = 0
    quality.mockResolvedValue({ status: "pass", issues: [] })
    seoResult.mockResolvedValue({ kind: "created", path: "/places/example" })
    loadBatchAvoidanceForItem.mockResolvedValue({ titlePatterns: [], faqPairs: [], keywordSets: [], bodies: PRIOR_BODIES })
  })

  it("apply 전 평가와 최종 평가 모두에 앞선 item 본문을 넘긴다", async () => {
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")
    await resolveNeedsReviewItem(BASE_INPUT)

    expect(qualityCalls).toHaveLength(2)
    for (const call of qualityCalls) {
      expect(call.options).toEqual({ pendingBodies: PRIOR_BODIES })
    }
  })

  it("배치 문맥을 읽지 못하면 상태를 바꾸지 않고 실패한다 (문맥 없이 pass로 올리지 않는다)", async () => {
    loadBatchAvoidanceForItem.mockRejectedValue(new Error("db unavailable"))
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")

    expect((await resolveNeedsReviewItem(BASE_INPUT)).kind).toBe("failed")
    expect(state.itemStatus).toBe("needs_review")
    expect(applyCalls).toEqual([])
    expect(qualityCalls).toHaveLength(0)
  })

  it("앞선 본문과 겹쳐 fail이면 edits 없는 해소는 차단된다", async () => {
    quality.mockResolvedValue({ status: "fail", issues: [{ level: "fail", code: "repeat:first-sentence" }] })
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")

    expect(await resolveNeedsReviewItem(BASE_INPUT)).toEqual({ kind: "quality-not-pass", status: "fail" })
    expect(state.itemStatus).toBe("needs_review")
    expect(applyCalls).toEqual([])
    expect(seoCalls).toEqual([])
  })

  it("재개 경로(이미 적용됨)에서도 최종 평가가 fail·평가 불가면 ready로 올리지 않는다", async () => {
    state.generationStatus = "applied"
    for (const evaluated of [{ status: "fail", issues: [{ level: "fail", code: "repeat:first-sentence" }] }, null]) {
      state.itemStatus = "needs_review"
      quality.mockResolvedValue(evaluated)
      const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")

      seoCalls.length = 0
      expect((await resolveNeedsReviewItem(BASE_INPUT)).kind).toBe("quality-not-pass")
      expect(state.itemStatus).toBe("needs_review")
      // 게시 후보 판정은 item 상태를 보지 않고 seo_pages ready만 본다 — ready를 만들지 않아야 게시 후보가 되지 않는다.
      expect(seoCalls).toEqual([])
      expect(state.seoPageStatus).toBeNull()
    }
  })

  // apply 전 평가는 통과했는데 최종 평가에서 실패·조회 불가가 나는 경우 (preview 경로).
  it("apply 뒤 최종 평가가 fail·평가 불가면 seo_pages ready를 만들지 않고, 다음 해소(재개)가 가능한 상태로 남는다", async () => {
    for (const finalEvaluation of [{ status: "fail", issues: [{ level: "fail", code: "repeat:first-sentence" }] }, null]) {
      state.itemStatus = "needs_review"
      state.generationStatus = "preview"
      state.seoPageStatus = null
      applyCalls.length = 0
      seoCalls.length = 0
      quality.mockReset()
      quality.mockResolvedValueOnce({ status: "pass", issues: [] }).mockResolvedValueOnce(finalEvaluation)
      const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")

      expect((await resolveNeedsReviewItem(BASE_INPUT)).kind).toBe("quality-not-pass")
      expect(applyCalls).toEqual(["gen-1"])
      expect(seoCalls).toEqual([])
      expect(state.itemStatus).toBe("needs_review")

      // 재개: 적용은 끝났고 seo_page가 없는 상태 — 평가가 통과하면 그때 ready가 만들어진다.
      state.generationStatus = "applied"
      quality.mockReset()
      quality.mockResolvedValue({ status: "pass", issues: [] })
      expect((await resolveNeedsReviewItem(BASE_INPUT)).kind).toBe("resolved")
      expect(seoCalls).toEqual(["place-1"])
    }
  })
})

// 2026-11-17 — ops 검토 해소에 문장 편집(title/body/meta_description)을 넘긴다. 편집은 사람이 읽은 글(해시)에만 쓰여야 한다.
describe("검토 해소 제한 편집 — 검토한 글 해시에 묶인다", () => {
  const NEW_TITLE = "대구 북구 예시 장례식장 근조화환 보내는 방법"
  const NEW_BODY = "예시 장례식장의 안내 주소를 확인한 뒤, 부고에 적힌 빈소명과 받는 분 정보를 확인해 주문해 주세요."
  const REVIEWED_HASH = storedHash(CONTENT)
  const EDIT_INPUT = { ...BASE_INPUT, edits: { title: NEW_TITLE, body: NEW_BODY }, expectedGeneratedHash: REVIEWED_HASH, actor: "ops:review-edit" }

  beforeEach(() => {
    state.itemStatus = "needs_review"
    state.generationStatus = "preview"
    state.seoPageStatus = null
    // DB에서 읽은 값처럼 jsonb 키 순서로 둔다.
    state.generationContent = jsonb(CONTENT)
    placeOverride = {}
    generationInput = null
    beforeManualEdit = null
    results.length = 0
    events.length = 0
    applyCalls.length = 0
    seoCalls.length = 0
    manualEdits.length = 0
    qualityCalls.length = 0
    quality.mockResolvedValue({ status: "pass", issues: [] })
    seoResult.mockResolvedValue({ kind: "created", path: "/places/example" })
    loadBatchAvoidanceForItem.mockResolvedValue({ titlePatterns: [], faqPairs: [], keywordSets: [], bodies: PRIOR_BODIES })
  })

  it("검토한 글이 그대로면 편집을 저장하고 적용·게시 준비까지 간다 — 감사에 주체·필드·이전 값, 같은 배치 문맥으로 재평가", async () => {
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")
    const result = await resolveNeedsReviewItem(EDIT_INPUT)

    expect(result).toEqual({ kind: "resolved", path: "/places/example", changedFields: ["title", "body"], itemStatus: "ready" })
    expect(manualEdits).toHaveLength(1)
    expect(manualEdits[0]?.audit).toEqual({ resolved_by: "ops:review-edit", changed_fields: ["title", "body"], before: { meta_title: CONTENT.meta_title, description: CONTENT.description } })
    expect(state.generationContent.meta_title).toBe(NEW_TITLE)
    expect(state.generationContent.description).toBe(NEW_BODY)
    // 고르지 않은 필드는 원문 그대로다.
    expect(state.generationContent.faq).toEqual(CONTENT.faq)
    expect(state.generationContent.meta_description).toBe(CONTENT.meta_description)
    expect(applyCalls).toEqual(["gen-1"])
    expect(seoCalls).toEqual(["place-1"])
    expect(state.itemStatus).toBe("ready")
    expect(qualityCalls.map((call) => call.options)).toEqual([{ pendingBodies: PRIOR_BODIES }, { pendingBodies: PRIOR_BODIES }])
  })

  it("해시는 저장 표현 기준이다 — 코드의 키 순서로 만든 글과 DB에서 읽은 글의 해시가 같다", async () => {
    const { computeGeneratedContentHash } = await import("@/lib/batch/content-hash")
    expect(computeGeneratedContentHash(CONTENT)).toBe(REVIEWED_HASH)
    expect(computeGeneratedContentHash(jsonb(CONTENT))).toBe(REVIEWED_HASH)
  })

  it("claim 전에 글이 이미 바뀌었으면 아무것도 바꾸지 않고 막는다", async () => {
    state.generationContent = jsonb({ ...CONTENT, description: "검토 뒤 다른 경로가 바꾼 본문입니다." })
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")

    expect(await resolveNeedsReviewItem(EDIT_INPUT)).toEqual({ kind: "blocked", reason: "generated-changed" })
    expect(state.itemStatus).toBe("needs_review")
    expect(events).toEqual([])
    expect(manualEdits).toEqual([])
    expect(applyCalls).toEqual([])
  })

  it("claim 뒤 저장 직전에 글이 바뀌면 쓰지 않고 needs_review로 되돌린다 — 적용·게시 준비 없음", async () => {
    beforeManualEdit = () => {
      state.generationContent = jsonb({ ...CONTENT, meta_title: "그 사이 바뀐 제목" })
    }
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")

    expect(await resolveNeedsReviewItem(EDIT_INPUT)).toEqual({ kind: "failed", reason: "review-unexpected" })
    expect(manualEdits).toEqual([])
    expect(state.generationContent.meta_title).toBe("그 사이 바뀐 제목")
    expect(state.itemStatus).toBe("needs_review")
    expect(results.at(-1)?.patch).toMatchObject({ status: "needs_review", lastErrorCode: "review-unexpected" })
    expect(applyCalls).toEqual([])
    expect(seoCalls).toEqual([])
  })

  it("재평가가 FAIL이면 편집은 preview에만 남고 적용하지 않는다", async () => {
    quality.mockResolvedValue({ status: "fail", issues: [{ level: "fail", code: "banned:delivery-promise" }] })
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")

    expect(await resolveNeedsReviewItem(EDIT_INPUT)).toEqual({ kind: "quality-not-pass", status: "fail" })
    expect(applyCalls).toEqual([])
    expect(seoCalls).toEqual([])
    expect(state.itemStatus).toBe("needs_review")
  })

  it("게시 준비에서 멈춘 뒤 같은 편집으로 다시 실행하면 — 이미 반영된 편집이라 다시 쓰지 않고 이어서 끝낸다", async () => {
    seoResult.mockResolvedValueOnce({ kind: "blocked" })
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")

    expect(await resolveNeedsReviewItem(EDIT_INPUT)).toEqual({ kind: "failed", reason: "review-seo-page-blocked" })
    expect(state.generationStatus).toBe("applied")
    expect(state.itemStatus).toBe("needs_review")

    const resumed = await resolveNeedsReviewItem(EDIT_INPUT)
    expect(resumed).toMatchObject({ kind: "resolved", changedFields: [] })
    expect(manualEdits).toHaveLength(1)
    expect(applyCalls).toEqual(["gen-1"])
    expect(state.itemStatus).toBe("ready")
  })

  it("이미 적용된 글에 아직 반영되지 않은 편집이 오면 조용히 무시하지 않고 막는다", async () => {
    state.generationStatus = "applied"
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")

    expect(await resolveNeedsReviewItem(EDIT_INPUT)).toEqual({ kind: "blocked", reason: "edits-not-applied" })
    expect(events).toEqual([])
    expect(seoCalls).toEqual([])
    expect(state.itemStatus).toBe("needs_review")
  })

  it("빈 값 편집은 상태를 바꾸기 전에 거절한다", async () => {
    const { resolveNeedsReviewItem } = await import("@/lib/batch/needs-review-service")

    expect(await resolveNeedsReviewItem({ ...EDIT_INPUT, edits: { title: "  " } })).toEqual({ kind: "invalid-field", field: "title" })
    expect(events).toEqual([])
    expect(manualEdits).toEqual([])
  })
})
