// 운영 작업(ops task)과 ready 보정 계약.
// 관리자 세션 없이 도는 경로이므로: 설정이 조금이라도 어긋나면 아무것도 하지 않고, 작업 ID당 한 번만 시작하며,
// 보정은 호출자가 본 콘텐츠(해시)와 지금 콘텐츠가 같을 때만, 품질 평가를 통과한 뒤에만,
// 그리고 평가하는 사이 아무도 그 장소를 고치지 않았을 때만 저장한다.
import { beforeEach, describe, expect, it, vi } from "vitest"

import { computePlaceContentHash } from "@/lib/batch/content-hash"
import { isOpsTaskExpired, OPS_TASK_MAX_STEPS, opsTaskResultKey, parseOpsTask } from "@/lib/batch/ops-task"

vi.mock("server-only", () => ({}))

// ── Supabase 대역 (메모리 테이블) ────────────────────────────────
type Row = Record<string, unknown>
type Filter = { op: "eq" | "is" | "in"; column: string; value: unknown }
const tables: Record<string, Row[]> = {}
let failWrite: string | null = null
let failRead: string | null = null
let insertErrorCode: string | null = null
let clock = 0
const writes: { table: string; kind: "update" | "insert"; patch: Row }[] = []

function matches(row: Row, filters: readonly Filter[]): boolean {
  return filters.every((filter) => (filter.op === "in" ? Array.isArray(filter.value) && filter.value.includes(row[filter.column]) : row[filter.column] === filter.value))
}

type Result = { data: Row[] | null; error: { message: string; code?: string } | null; count?: number | null }

function builder(table: string) {
  const filters: Filter[] = []
  let patch: Row | null = null
  let head = false
  const rows = (): Row[] => (tables[table] ?? []).filter((row) => matches(row, filters))
  const run = (): Result => {
    if (patch !== null) {
      if (failWrite === table) {
        return { data: null, error: { message: "write failed" } }
      }
      const targets = rows()
      for (const row of targets) {
        // places·seo_pages의 updated_at 트리거 — 모든 수정마다 값이 바뀐다.
        clock += 1
        Object.assign(row, patch, { updated_at: `t${String(clock)}` })
      }
      if (targets.length > 0) {
        writes.push({ table, kind: "update", patch })
      }
      return { data: targets, error: null }
    }
    if (failRead === table) {
      return { data: null, error: { message: "read failed" }, count: null }
    }
    // 읽기는 스냅샷을 돌려준다 — 실제 DB처럼, 읽은 뒤의 수정이 읽은 값에 비치지 않게.
    return head ? { data: null, error: null, count: rows().length } : { data: rows().map((row) => structuredClone(row)), error: null }
  }
  const api = {
    select: (_columns?: string, options?: { head?: boolean }) => {
      head = options?.head === true
      return api
    },
    eq: (column: string, value: unknown) => {
      filters.push({ op: "eq", column, value })
      return api
    },
    is: (column: string, value: unknown) => {
      filters.push({ op: "is", column, value })
      return api
    },
    in: (column: string, value: unknown) => {
      filters.push({ op: "in", column, value })
      return api
    },
    update: (next: Row) => {
      patch = next
      return api
    },
    insert: (row: Row) => {
      if (insertErrorCode !== null) {
        return Promise.resolve({ error: { message: "insert failed", code: insertErrorCode } })
      }
      if ((tables[table] ?? []).some((existing) => existing["key"] === row["key"])) {
        return Promise.resolve({ error: { message: "duplicate key", code: "23505" } })
      }
      ;(tables[table] ??= []).push({ ...row })
      writes.push({ table, kind: "insert", patch: row })
      return Promise.resolve({ error: null })
    },
    maybeSingle: () => {
      const result = run()
      return Promise.resolve({ data: result.data?.[0] ?? null, error: result.error })
    },
    then: (onFulfilled: (value: Result) => unknown, onRejected?: (reason: unknown) => unknown) => Promise.resolve(run()).then(onFulfilled, onRejected),
  }
  return api
}
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceRoleClient: () => ({ from: (table: string) => builder(table) }) }))

// ── 코어 대역 ────────────────────────────────────────────────────
type QualityOptions = { contentOverride?: { description: string }; pendingBodies?: readonly unknown[]; persist?: boolean }
const evaluateGenerationQuality = vi.fn<(generationId: string, options?: QualityOptions) => Promise<unknown>>()
vi.mock("@/lib/ai/generation-runner", () => ({ evaluateGenerationQuality: (generationId: string, options?: QualityOptions) => evaluateGenerationQuality(generationId, options) }))
const loadBatchAvoidanceForItem = vi.fn<(item: unknown) => Promise<unknown>>()
vi.mock("@/lib/batch/generation-batch-service", () => ({ loadBatchAvoidanceForItem: (item: unknown) => loadBatchAvoidanceForItem(item) }))
const resolveNeedsReviewItem = vi.fn<(input: unknown) => Promise<unknown>>()
vi.mock("@/lib/batch/needs-review-service", () => ({ resolveNeedsReviewItem: (input: unknown) => resolveNeedsReviewItem(input) }))
// 게시 보류 — 획득·해제 계약은 publish-hold.test.ts. 여기서는 작업이 보류를 어떻게 쓰는지만 본다.
const holdLog: string[] = []
type HoldInput = { by: string; until: string; nowIso: string }
const acquirePublishHold = vi.fn<(input: HoldInput) => Promise<boolean>>()
const releasePublishHold = vi.fn<(by: string) => Promise<void>>()
vi.mock("@/lib/seo-pages/publish-hold", () => ({
  acquirePublishHold: (input: HoldInput) => acquirePublishHold(input),
  releasePublishHold: (by: string) => releasePublishHold(by),
}))

const PLACE = "00000000-0000-4000-8000-000000000014"
const GEN = "11111111-0000-4000-8000-000000000014"
const ITEM = "22222222-0000-4000-8000-000000000014"
const NOW = "2026-11-10T07:00:00.000Z"
const PRIOR_BODY = { placeName: "건국대학교병원 장례식장", region: null, description: "앞선 본문입니다." }

const content = {
  meta_title: "남양주시 장례식장 화환 주문 — 원병원 장례식장",
  meta_description: "원병원 장례식장 근조화환 주문은 빈소 정보 입력 후 주문 과정에서 확인하세요.",
  description: "원병원 장례식장에 근조화환을 보내실 때는 빈소 정보를 정확히 입력해 주셔야 합니다. 주문 과정에서 배송 가능 여부와 세부 사항을 확인할 수 있습니다.",
  faq: [
    { question: "화환 주문 전에 어떤 정보를 확인해야 하나요?", answer: "빈소 위치와 상주 정보를 주문 과정에서 확인합니다." },
    { question: "받는 분 정보를 어떻게 입력해야 하나요?", answer: "주문 과정 안내에 따라 입력합니다." },
  ],
  keywords: ["원병원 장례식장", "남양주 근조화환", "원병원 화환", "받는 분 정보 입력", "남양주 꽃배달"],
  internal_links: [],
}
const HASH = computePlaceContentHash(content)
const NEW_BODY = "원병원 장례식장으로 근조화환을 보내기 전에 상주 성함과 빈소 호실을 먼저 확인해 두세요. 주문 과정에서 배송 가능 여부와 세부 사항을 확인할 수 있습니다."
const NEW_HASH = computePlaceContentHash({ ...content, description: NEW_BODY })
const NEW_TITLE = "원병원 장례식장 근조화환 주문 안내"

function seed(): void {
  for (const key of Object.keys(tables)) {
    Reflect.deleteProperty(tables, key)
  }
  tables["places"] = [
    { id: PLACE, name: "원병원 장례식장", status: "draft", category: "funeral", city: "경기", district: "남양주시", address: "경기 남양주시 화도읍 경춘로 1943-16", phone: "031-511-9944", normalized_phone: "0315119944", email: null, homepage: null, updated_at: "t0", ...content },
  ]
  tables["ai_generations"] = [{ id: GEN, place_id: PLACE, status: "applied", output: { generated: content, after: content, provider: "openai", model: "gpt-4.1-mini", usage: { input_tokens: 900, output_tokens: 300, total_tokens: 1200 }, estimated_cost: 0.0009, audit: { title_pattern_id: "region-dash" } } }]
  tables["seo_pages"] = [{ id: "seo-1", page_type: "place", place_id: PLACE, status: "ready", published_at: null, title: content.meta_title, description: content.meta_description }]
  tables["batch_run_items"] = [{ id: ITEM, batch_id: "batch-1", sequence: 14, place_id: PLACE, status: "ready", generation_id: GEN, retry_generation_id: null }]
  tables["settings"] = []
  tables["batch_approvals"] = []
  tables["batch_runs"] = []
}

beforeEach(() => {
  seed()
  failWrite = null
  failRead = null
  insertErrorCode = null
  clock = 0
  writes.length = 0
  holdLog.length = 0
  evaluateGenerationQuality.mockReset()
  evaluateGenerationQuality.mockResolvedValue({ status: "pass", issues: [] })
  loadBatchAvoidanceForItem.mockReset()
  loadBatchAvoidanceForItem.mockResolvedValue({ titlePatterns: [], faqPairs: [], keywordSets: [], bodies: [PRIOR_BODY] })
  resolveNeedsReviewItem.mockReset()
  resolveNeedsReviewItem.mockImplementation(() => {
    holdLog.push("step")
    return Promise.resolve({ kind: "resolved", path: "/places/x", changedFields: [], itemStatus: "warn_ready" })
  })
  acquirePublishHold.mockReset()
  acquirePublishHold.mockImplementation(() => {
    holdLog.push("acquire")
    return Promise.resolve(true)
  })
  releasePublishHold.mockReset()
  releasePublishHold.mockImplementation(() => {
    holdLog.push("release")
    return Promise.resolve()
  })
})

async function correct(overrides: Record<string, unknown> = {}) {
  const { correctReadyContent } = await import("@/lib/batch/ready-correction-service")
  return correctReadyContent({ placeId: PLACE, generationId: GEN, expectedContentHash: HASH, edits: { body: NEW_BODY }, actor: "ops:pilot-review", reason: "배치 내 첫 문장 중복", ...overrides })
}
const place = (): Row => tables["places"]?.[0] ?? {}
const generationRow = (): Row => tables["ai_generations"]?.[0] ?? {}
const generationOutput = (): Row => (generationRow()["output"] as Row | undefined) ?? {}
const generated = (): Row => (generationOutput()["generated"] as Row | undefined) ?? {}
const seoPage = (): Row => tables["seo_pages"]?.[0] ?? {}
const itemRow = (): Row => tables["batch_run_items"]?.[0] ?? {}

describe("ready 보정 — 정상 경로", () => {
  it("본문을 고치면 places·seo_pages·generation이 같은 콘텐츠로 맞춰진다", async () => {
    const result = await correct()

    expect(result).toEqual({ kind: "corrected", changedFields: ["body"], contentHash: NEW_HASH })
    expect(place()["description"]).toBe(NEW_BODY)
    expect(generated()["description"]).toBe(NEW_BODY)
    expect((generationOutput()["after"] as Row)["description"]).toBe(NEW_BODY)
    // 결과 해시는 실제 저장된 places 콘텐츠의 해시다.
    expect(computePlaceContentHash(place() as never)).toBe(NEW_HASH)
  })

  it("제목·메타 설명을 고치면 seo_pages의 title/description도 함께 바뀐다 (재적용은 seo_pages를 갱신하지 않는다)", async () => {
    await correct({ edits: { title: NEW_TITLE, meta_description: "원병원 장례식장 근조화환 주문 전 확인 사항 안내입니다." } })

    expect(seoPage()["title"]).toBe(NEW_TITLE)
    expect(seoPage()["description"]).toBe("원병원 장례식장 근조화환 주문 전 확인 사항 안내입니다.")
    expect(place()["meta_title"]).toBe(NEW_TITLE)
  })

  it("원본·사용량·비용·다양화 감사를 보존하고 보정 이력을 남긴다", async () => {
    await correct()

    const output = generationOutput()
    expect(output["estimated_cost"]).toBe(0.0009)
    expect(output["usage"]).toEqual({ input_tokens: 900, output_tokens: 300, total_tokens: 1200 })
    expect(output["audit"]).toEqual({ title_pattern_id: "region-dash" })
    expect(output["ready_corrections"]).toHaveLength(1)
    expect((output["ready_corrections"] as Row[])[0]).toMatchObject({
      corrected_by: "ops:pilot-review",
      reason: "배치 내 첫 문장 중복",
      changed_fields: ["body"],
      before: { description: content.description },
      before_hash: HASH,
      after_hash: NEW_HASH,
    })
    // applied 상태를 preview로 되돌려 우회하지 않는다.
    expect(generationRow()["status"]).toBe("applied")
  })

  it("두 번째 보정이 첫 번째 보정의 이력을 지우지 않는다", async () => {
    await correct()
    await correct({ expectedContentHash: NEW_HASH, edits: { title: NEW_TITLE }, reason: "제목 정리" })

    const history = generationOutput()["ready_corrections"] as Row[]
    expect(history.map((entry) => entry["reason"])).toEqual(["배치 내 첫 문장 중복", "제목 정리"])
    expect(history[0]?.["before"]).toEqual({ description: content.description })
  })

  it("보정안은 저장 전에, 같은 배치의 앞선 본문과 함께, 기록을 남기지 않는 방식으로 평가한다", async () => {
    await correct()

    const [generationId, options] = evaluateGenerationQuality.mock.calls[0] ?? []
    expect(generationId).toBe(GEN)
    expect(options?.contentOverride?.description).toBe(NEW_BODY)
    expect(options?.pendingBodies).toEqual([PRIOR_BODY])
    expect(options?.persist).toBe(false)
    expect(loadBatchAvoidanceForItem).toHaveBeenCalledWith(expect.objectContaining({ batch_id: "batch-1", sequence: 14 }))
  })

  it("places를 먼저(compare-and-swap으로) 쓰고, 이긴 뒤에만 나머지를 맞춘다", async () => {
    await correct()
    expect(writes.map((write) => write.table)).toEqual(["places", "seo_pages", "ai_generations"])
  })
})

describe("ready 보정 — 동시 수정 (쓰기 시점 compare-and-swap)", () => {
  // 해시는 읽을 때 한 번 비교할 뿐이다. 평가하는 사이 다른 쓰기가 끼면, 쓰기 조건에 버전이 없을 때 그 쓰기를 덮는다.
  it("평가하는 사이 다른 주체가 장소 본문을 고쳤으면 덮어쓰지 않고 충돌로 끝난다", async () => {
    const external = "다른 주체가 방금 저장한 최신 본문입니다. 주문 과정에서 확인할 수 있습니다."
    evaluateGenerationQuality.mockImplementation(() => {
      Object.assign(place(), { description: external, updated_at: "t-external" })
      return Promise.resolve({ status: "pass", issues: [] })
    })

    expect(await correct()).toEqual({ kind: "blocked", reason: "write-conflict" })
    expect(place()["description"]).toBe(external)
    // 지지 않은 쪽의 seo_pages·generation도 건드리지 않는다.
    expect(seoPage()["title"]).toBe(content.meta_title)
    expect(generated()["description"]).toBe(content.description)
    expect(generationOutput()["ready_corrections"]).toBeUndefined()
  })

  it("같은 콘텐츠를 본 두 보정이 겹치면 하나만 적용되고, 진 쪽은 성공으로 보고하지 않는다", async () => {
    const bodyA = NEW_BODY
    const bodyB = "부고에 적힌 발인 일시를 먼저 확인한 뒤 원병원 장례식장으로 근조화환을 주문하세요. 주문 과정에서 배송 가능 여부와 세부 사항을 확인할 수 있습니다."
    // 둘 다 같은 해시(H0)를 읽고 평가에 들어간 뒤 차례로 쓴다.
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    evaluateGenerationQuality.mockImplementation(async () => {
      await gate
      return { status: "pass", issues: [] }
    })
    const first = correct({ edits: { body: bodyA } })
    const second = correct({ edits: { body: bodyB } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    release?.()
    const outcomes = await Promise.all([first, second])

    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["blocked", "corrected"])
    expect(outcomes.find((outcome) => outcome.kind === "blocked")).toEqual({ kind: "blocked", reason: "write-conflict" })
    // 저장된 본문은 이긴 쪽 하나이고, 세 곳이 서로 일치한다.
    const stored = place()["description"]
    expect([bodyA, bodyB]).toContain(stored)
    expect(generated()["description"]).toBe(stored)
    expect(generationOutput()["ready_corrections"]).toHaveLength(1)
  })

  it("그 사이 게시됐으면(draft 아님) 아무것도 쓰지 않는다 — 공개본과 생성 기록이 갈라지지 않는다", async () => {
    evaluateGenerationQuality.mockImplementation(() => {
      Object.assign(place(), { status: "published", updated_at: "t-published" })
      Object.assign(seoPage(), { status: "published", published_at: NOW })
      return Promise.resolve({ status: "pass", issues: [] })
    })

    expect(await correct()).toEqual({ kind: "blocked", reason: "write-conflict" })
    expect(place()["description"]).toBe(content.description)
    expect(generated()["description"]).toBe(content.description)
    expect(writes).toHaveLength(0)
  })
})

describe("ready 보정 — 차단", () => {
  it("호출자가 본 콘텐츠와 지금 콘텐츠가 다르면 아무것도 쓰지 않는다", async () => {
    expect(await correct({ expectedContentHash: "0".repeat(64) })).toEqual({ kind: "blocked", reason: "content-changed" })
    expect(writes).toHaveLength(0)
  })

  it.each([
    ["이미 게시된 장소", () => (place()["status"] = "published"), "place-not-draft"],
    ["preview generation", () => (generationRow()["status"] = "preview"), "generation-not-applied"],
    ["다른 장소의 generation", () => (generationRow()["place_id"] = "other"), "generation-mismatch"],
    ["공개된 seo_page", () => (seoPage()["status"] = "published"), "seo-page-not-ready"],
    ["published_at이 찍힌 seo_page", () => (seoPage()["published_at"] = NOW), "seo-page-not-ready"],
    ["seo_page 없음", () => (tables["seo_pages"] = []), "seo-page-not-ready"],
    ["needs_review item", () => (itemRow()["status"] = "needs_review"), "item-not-ready"],
    ["재시도 generation이 최종인데 원본을 지정", () => (itemRow()["retry_generation_id"] = "newer"), "item-not-ready"],
    ["없는 장소", () => (tables["places"] = []), "place-not-found"],
  ])("%s → 차단, 쓰기 0건", async (_label, mutate, reason) => {
    mutate()
    expect(await correct()).toEqual({ kind: "blocked", reason })
    expect(writes).toHaveLength(0)
  })

  it("세 곳이 이미 일치하고 바뀌는 것도 없으면 차단한다", async () => {
    expect(await correct({ edits: { body: content.description } })).toEqual({ kind: "blocked", reason: "no-changes" })
    expect(writes).toHaveLength(0)
  })

  it("문장 필드 밖(FAQ·키워드)은 넘겨도 무시된다", async () => {
    expect(await correct({ edits: { faq: "질문 | 답" } })).toEqual({ kind: "blocked", reason: "no-changes" })
    expect(place()["faq"]).toEqual(content.faq)
  })

  it("가드레일 위반(전화번호 노출)은 저장하지 않는다", async () => {
    const result = await correct({ edits: { body: `${NEW_BODY} 문의는 031-511-9944로 주세요.` } })
    expect(result.kind).toBe("invalid-field")
    expect(writes).toHaveLength(0)
  })

  it.each([
    ["fail", { status: "fail", issues: [{ level: "fail", code: "repeat:first-sentence", message: "" }] }],
    ["warn 판정 안의 fail 항목", { status: "warn", issues: [{ level: "fail", code: "banned:price", message: "" }] }],
    ["평가 불가", null],
  ])("품질 평가가 %s이면 저장하지 않는다", async (_label, quality) => {
    evaluateGenerationQuality.mockResolvedValue(quality)
    expect((await correct()).kind).toBe("quality-not-pass")
    expect(writes).toHaveLength(0)
    expect(place()["description"]).toBe(content.description)
  })

  it("warn만 있는 보정안은 저장한다 (검토자가 확인한 경로)", async () => {
    evaluateGenerationQuality.mockResolvedValue({ status: "warn", issues: [{ level: "warn", code: "repeat:title", message: "" }] })
    expect((await correct()).kind).toBe("corrected")
  })
})

describe("ready 보정 — 중간 실패와 동기화", () => {
  it("seo_pages 쓰기가 실패하면 실패로 보고하고, 새 해시로 같은 edits를 다시 실행하면 어긋난 쪽을 맞춘다", async () => {
    failWrite = "seo_pages"
    expect(await correct({ edits: { title: NEW_TITLE } })).toEqual({ kind: "failed", step: "seo-page" })
    // 장소는 보정됐고 seo_pages·generation은 옛 값 — 이 상태로 게시되면 안 되므로 호출자가 보류를 유지한다.
    expect(place()["meta_title"]).toBe(NEW_TITLE)
    expect(seoPage()["title"]).toBe(content.meta_title)

    failWrite = null
    const titleHash = computePlaceContentHash(place() as never)
    expect(await correct({ expectedContentHash: titleHash, edits: { title: NEW_TITLE } })).toEqual({ kind: "synced", contentHash: titleHash })
    expect(seoPage()["title"]).toBe(NEW_TITLE)
    expect(generated()["meta_title"]).toBe(NEW_TITLE)
  })

  it("generation 쓰기가 실패한 경우도 같은 방식으로 수렴한다", async () => {
    failWrite = "ai_generations"
    expect(await correct()).toEqual({ kind: "failed", step: "generation" })

    failWrite = null
    expect(await correct({ expectedContentHash: NEW_HASH })).toEqual({ kind: "synced", contentHash: NEW_HASH })
    expect(generated()["description"]).toBe(NEW_BODY)
  })

  it("옛 해시로는 다시 실행할 수 없다 (이중 적용 방지)", async () => {
    await correct()
    writes.length = 0
    expect(await correct()).toEqual({ kind: "blocked", reason: "content-changed" })
    expect(writes).toHaveLength(0)
  })
})

// ── 작업 설정 해석 ───────────────────────────────────────────────
const validTask = {
  id: "pilot-review-20261110",
  expiresAt: "2026-11-11T00:00:00.000Z",
  actor: "ops:pilot-review",
  steps: [
    { kind: "correct-ready", placeId: PLACE, generationId: GEN, expectedContentHash: HASH, edits: { body: NEW_BODY }, reason: "배치 내 첫 문장 중복" },
    { kind: "resolve-needs-review", itemId: ITEM, generationId: GEN },
  ],
}

describe("운영 작업 설정 해석", () => {
  it("올바른 설정을 읽는다", () => {
    expect(parseOpsTask(validTask)).toEqual(validTask)
    expect(opsTaskResultKey("pilot-review-20261110")).toBe("ops_task_result:pilot-review-20261110")
  })

  it.each([
    ["객체가 아님", "run"],
    ["id 형식 위반", { ...validTask, id: "Pilot Review" }],
    ["만료 시각 해석 불가", { ...validTask, expiresAt: "tomorrow" }],
    ["actor가 사용자 이메일", { ...validTask, actor: "admin@example.com" }],
    ["steps 비어 있음", { ...validTask, steps: [] }],
    ["steps 상한 초과", { ...validTask, steps: Array.from({ length: OPS_TASK_MAX_STEPS + 1 }, () => validTask.steps[1]) }],
    ["모르는 step 종류", { ...validTask, steps: [{ kind: "publish", placeId: PLACE }] }],
    ["UUID 아닌 대상", { ...validTask, steps: [{ kind: "resolve-needs-review", itemId: "all", generationId: GEN }] }],
    ["해시 형식 위반", { ...validTask, steps: [{ ...validTask.steps[0], expectedContentHash: "abc" }] }],
    ["사유 없음", { ...validTask, steps: [{ ...validTask.steps[0], reason: " " }] }],
    ["허용 밖 필드(faq)", { ...validTask, steps: [{ ...validTask.steps[0], edits: { faq: "질문 | 답" } }] }],
    ["빈 edits", { ...validTask, steps: [{ ...validTask.steps[0], edits: {} }] }],
    ["빈 문자열 값", { ...validTask, steps: [{ ...validTask.steps[0], edits: { body: "  " } }] }],
    // 일부 step만 골라 실행하지 않는다 — 하나라도 어긋나면 작업 전체가 없다.
    ["정상 step + 잘못된 step", { ...validTask, steps: [validTask.steps[1], { kind: "resolve-needs-review", itemId: "x", generationId: GEN }] }],
  ])("%s → 작업 없음", (_label, value) => {
    expect(parseOpsTask(value)).toBeNull()
  })

  it("만료 판정", () => {
    const task = parseOpsTask(validTask)
    expect(task).not.toBeNull()
    if (task !== null) {
      expect(isOpsTaskExpired(task, "2026-11-10T23:59:59.000Z")).toBe(false)
      expect(isOpsTaskExpired(task, "2026-11-11T00:00:00.000Z")).toBe(true)
    }
  })
})

// ── 작업 실행 ────────────────────────────────────────────────────
const sleeps: number[] = []
async function runTask() {
  const { runOpsTask } = await import("@/lib/batch/ops-task-service")
  return runOpsTask({
    nowIso: NOW,
    sleep: (ms) => {
      sleeps.push(ms)
      holdLog.push("settle")
      return Promise.resolve()
    },
  })
}
const RESULT_KEY = "ops_task_result:pilot-review-20261110"
const resultValue = (): Row | undefined => tables["settings"]?.find((row) => row["key"] === RESULT_KEY)?.["value"] as Row | undefined
const setTask = (value: unknown): void => {
  tables["settings"] = [{ key: "ops_task", value }]
}

describe("운영 작업 실행 — 캠페인이 진행해도 되는 경우(clear)", () => {
  it("설정이 없으면 아무것도 하지 않고 통과시킨다", async () => {
    expect(await runTask()).toEqual({ kind: "clear", reason: "no-task" })
    expect(writes).toHaveLength(0)
    expect(acquirePublishHold).not.toHaveBeenCalled()
  })

  it("이미 정상 완료된 작업은 다시 실행하지 않고 통과시킨다", async () => {
    setTask(validTask)
    tables["settings"]?.push({ key: RESULT_KEY, value: { status: "done", results: [] } })

    expect(await runTask()).toEqual({ kind: "clear", reason: "already-done" })
    expect(resolveNeedsReviewItem).not.toHaveBeenCalled()
  })
})

describe("운영 작업 실행 — 캠페인까지 멈추는 경우(blocked)", () => {
  // 결과 행 INSERT는 "최대 한 번 시작"만 보장한다. 실행 중·중단된 작업을 그냥 '이미 처리됨'으로 넘기면
  // 보정이 끝나지 않은 채로 다음 승인이 만들어진다.
  it.each([
    ["running", "previous-running"],
    ["stopped", "previous-stopped"],
    ["weird", "previous-unknown"],
  ])("같은 작업의 결과가 %s이면 실행도 통과도 하지 않는다", async (status, reason) => {
    setTask(validTask)
    tables["settings"]?.push({ key: RESULT_KEY, value: { status, results: [] } })

    expect(await runTask()).toEqual({ kind: "blocked", reason })
    expect(resolveNeedsReviewItem).not.toHaveBeenCalled()
    expect(place()["description"]).toBe(content.description)
  })

  it("해석되지 않는 설정은 실행하지 않고 멈춘다", async () => {
    setTask({ ...validTask, actor: "admin@example.com" })
    expect(await runTask()).toEqual({ kind: "blocked", reason: "previous-unknown" })
    expect(resultValue()).toBeUndefined()
  })

  it("만료된 작업은 실행하지 않는다", async () => {
    setTask({ ...validTask, expiresAt: "2026-11-10T06:00:00.000Z" })
    expect(await runTask()).toEqual({ kind: "blocked", reason: "expired" })
    expect(resultValue()).toBeUndefined()
  })

  // pump의 idle은 다른 pump가 lease를 쥐고 item을 처리 중인 경우도 포함한다.
  it.each([
    ["승인", () => (tables["batch_approvals"] = [{ id: "a1", status: "running" }])],
    ["생성 배치", () => (tables["batch_runs"] = [{ id: "r1", status: "running" }])],
  ])("진행 중 %s가 있으면 claim하지 않고 기다린다", async (_label, activate) => {
    setTask(validTask)
    activate()

    expect(await runTask()).toEqual({ kind: "blocked", reason: "active-run" })
    // claim하지 않았으므로 생성이 끝난 다음 주기에 실행될 수 있다.
    expect(resultValue()).toBeUndefined()
    expect(acquirePublishHold).not.toHaveBeenCalled()
  })

  it("진행 상태를 읽지 못하면 실행하지 않고 던진다", async () => {
    setTask(validTask)
    failRead = "batch_approvals"
    await expect(runTask()).rejects.toThrow()
    expect(resultValue()).toBeUndefined()
  })

  it("다른 주체가 게시 보류를 쥐고 있으면 step을 실행하지 않고 중단으로 남긴다", async () => {
    setTask(validTask)
    acquirePublishHold.mockResolvedValue(false)

    expect(await runTask()).toEqual({ kind: "blocked", reason: "publish-hold-busy" })
    expect(place()["description"]).toBe(content.description)
    expect(resultValue()).toMatchObject({ status: "stopped", note: "publish-hold-busy" })
  })

  it("claim에 실패하면(중복이 아닌 오류) 실행하지 않고 던진다", async () => {
    setTask(validTask)
    insertErrorCode = "08006"
    await expect(runTask()).rejects.toThrow()
    expect(acquirePublishHold).not.toHaveBeenCalled()
    expect(place()["description"]).toBe(content.description)
  })
})

describe("운영 작업 실행 — 실행", () => {
  it("게시 보류를 잡고, 진입 중이던 게시가 끝나길 기다린 뒤, step을 순서대로 실행하고, 전부 성공하면 보류를 푼다", async () => {
    setTask({ ...validTask, steps: [validTask.steps[1], validTask.steps[1]] })

    const outcome = await runTask()

    expect(outcome).toMatchObject({ kind: "finished", status: "done" })
    expect(holdLog).toEqual(["acquire", "settle", "step", "step", "release"])
    expect(sleeps.at(-1)).toBeGreaterThanOrEqual(5000)
    expect(acquirePublishHold.mock.calls[0]?.[0].by).toBe("ops-task:pilot-review-20261110")
    expect(releasePublishHold).toHaveBeenCalledWith("ops-task:pilot-review-20261110")
  })

  it("보정과 검토 해소를 순서대로 실행하고 결과를 남긴다", async () => {
    setTask(validTask)

    const outcome = await runTask()

    expect(outcome.kind === "finished" && outcome.results.map((result) => `${result.kind}:${result.outcome}`)).toEqual(["correct-ready:corrected", "resolve-needs-review:warn_ready"])
    expect(place()["description"]).toBe(NEW_BODY)
    expect(resolveNeedsReviewItem).toHaveBeenCalledWith({ itemId: ITEM, generationId: GEN, edits: {}, confirmed: true, actor: "ops:pilot-review" })
    expect(resultValue()).toMatchObject({ status: "done" })
    expect((resultValue()?.["results"] as unknown[]).length).toBe(2)
  })

  it("step이 실패하면 거기서 멈추고, 뒤 step은 실행하지 않으며, 게시 보류를 풀지 않는다", async () => {
    setTask({ ...validTask, steps: [{ ...validTask.steps[0], expectedContentHash: "0".repeat(64) }, validTask.steps[1]] })

    const outcome = await runTask()

    expect(outcome).toMatchObject({ kind: "finished", status: "stopped" })
    expect(outcome.kind === "finished" && outcome.results).toEqual([{ index: 0, kind: "correct-ready", ok: false, outcome: "blocked", detail: "content-changed" }])
    expect(resolveNeedsReviewItem).not.toHaveBeenCalled()
    expect(resultValue()).toMatchObject({ status: "stopped" })
    // 콘텐츠가 중간 상태일 수 있다 — 사람이 확인하기 전에 게시가 풀리면 안 된다.
    expect(releasePublishHold).not.toHaveBeenCalled()
  })

  it("중단된 작업은 다음 호출에서 다시 실행되지 않고 계속 막는다", async () => {
    resolveNeedsReviewItem.mockResolvedValue({ kind: "quality-not-pass", status: "fail" })
    setTask({ ...validTask, steps: [validTask.steps[1]] })
    expect(await runTask()).toMatchObject({ kind: "finished", status: "stopped", results: [{ ok: false, outcome: "quality-not-pass", detail: "fail" }] })
    resolveNeedsReviewItem.mockClear()

    expect(await runTask()).toEqual({ kind: "blocked", reason: "previous-stopped" })
    expect(resolveNeedsReviewItem).not.toHaveBeenCalled()
  })

  it("step이 던져도 결과를 남기고 중단으로 끝난다", async () => {
    resolveNeedsReviewItem.mockRejectedValue(new Error("db unavailable"))
    setTask({ ...validTask, steps: [validTask.steps[1]] })

    expect(await runTask()).toMatchObject({ kind: "finished", status: "stopped", results: [{ ok: false, outcome: "threw" }] })
    expect(resultValue()).toMatchObject({ status: "stopped" })
  })

  it("step마다 결과를 저장한다 — 함수가 중간에 죽어도 어디까지 끝났는지 남는다", async () => {
    setTask({ ...validTask, steps: [validTask.steps[1], validTask.steps[1]] })
    let afterFirst: Row | undefined
    let calls = 0
    resolveNeedsReviewItem.mockImplementation(() => {
      calls += 1
      if (calls === 2) {
        afterFirst = JSON.parse(JSON.stringify(resultValue())) as Row
      }
      return Promise.resolve({ kind: "resolved", path: "/places/x", changedFields: [], itemStatus: "ready" })
    })

    await runTask()

    expect(afterFirst).toMatchObject({ status: "running" })
    expect((afterFirst?.["results"] as unknown[]).length).toBe(1)
  })

  it("결과 저장이 실패해 running으로 남아도, 다음 호출은 통과시키지 않는다", async () => {
    setTask({ ...validTask, steps: [validTask.steps[1]] })
    failWrite = "settings"
    await runTask()
    failWrite = null

    expect(resultValue()).toMatchObject({ status: "running" })
    expect(await runTask()).toEqual({ kind: "blocked", reason: "previous-running" })
  })
})
