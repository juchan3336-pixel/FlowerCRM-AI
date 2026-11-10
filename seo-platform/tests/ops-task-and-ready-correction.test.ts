// 운영 작업(ops task)과 ready 보정 계약.
// 관리자 세션 없이 도는 경로이므로: 설정이 조금이라도 어긋나면 아무것도 하지 않고, 작업 ID당 한 번만 실행하며,
// 보정은 호출자가 본 콘텐츠(해시)와 지금 콘텐츠가 같을 때만, 품질 평가를 통과한 뒤에만 저장한다.
import { beforeEach, describe, expect, it, vi } from "vitest"

import { computePlaceContentHash } from "@/lib/batch/content-hash"
import { isOpsTaskExpired, OPS_TASK_MAX_STEPS, opsTaskResultKey, parseOpsTask } from "@/lib/batch/ops-task"

vi.mock("server-only", () => ({}))

// ── Supabase 대역 (메모리 테이블) ────────────────────────────────
type Row = Record<string, unknown>
type Filter = { op: "eq" | "is" | "in"; column: string; value: unknown }
const tables: Record<string, Row[]> = {}
let failWrite: string | null = null
let insertErrorCode: string | null = null
const writes: { table: string; kind: "update" | "insert"; patch: Row }[] = []

function matches(row: Row, filters: readonly Filter[]): boolean {
  return filters.every((filter) => (filter.op === "in" ? Array.isArray(filter.value) && filter.value.includes(row[filter.column]) : row[filter.column] === filter.value))
}

function builder(table: string) {
  const filters: Filter[] = []
  let patch: Row | null = null
  const rows = (): Row[] => (tables[table] ?? []).filter((row) => matches(row, filters))
  const run = (): { data: Row[] | null; error: { message: string; code?: string } | null } => {
    if (patch !== null) {
      if (failWrite === table) {
        return { data: null, error: { message: "write failed" } }
      }
      const targets = rows()
      for (const row of targets) {
        Object.assign(row, patch)
      }
      writes.push({ table, kind: "update", patch })
      return { data: targets, error: null }
    }
    return { data: rows(), error: null }
  }
  const api = {
    select: () => api,
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
    then: (onFulfilled: (value: ReturnType<typeof run>) => unknown, onRejected?: (reason: unknown) => unknown) => Promise.resolve(run()).then(onFulfilled, onRejected),
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
const NEW_BODY = "부고 문자에 적힌 장례식장명과 빈소 호실을 먼저 확인한 뒤 원병원 장례식장으로 근조화환을 주문하세요. 주문 과정에서 배송 가능 여부와 세부 사항을 확인할 수 있습니다."

function seed(): void {
  for (const key of Object.keys(tables)) {
    Reflect.deleteProperty(tables, key)
  }
  tables["places"] = [{ id: PLACE, name: "원병원 장례식장", status: "draft", category: "funeral", city: "경기", district: "남양주시", address: "경기 남양주시 화도읍 경춘로 1943-16", phone: "031-511-9944", normalized_phone: "0315119944", email: null, homepage: null, ...content }]
  tables["ai_generations"] = [{ id: GEN, place_id: PLACE, status: "applied", output: { generated: content, after: content, provider: "openai", model: "gpt-4.1-mini", usage: { input_tokens: 900, output_tokens: 300, total_tokens: 1200 }, estimated_cost: 0.0009, audit: { title_pattern_id: "region-dash" } } }]
  tables["seo_pages"] = [{ id: "seo-1", page_type: "place", place_id: PLACE, status: "ready", published_at: null, title: content.meta_title, description: content.meta_description }]
  tables["batch_run_items"] = [{ id: ITEM, batch_id: "batch-1", sequence: 14, place_id: PLACE, status: "ready", generation_id: GEN, retry_generation_id: null }]
  tables["settings"] = []
}

beforeEach(() => {
  seed()
  failWrite = null
  insertErrorCode = null
  writes.length = 0
  evaluateGenerationQuality.mockReset()
  evaluateGenerationQuality.mockResolvedValue({ status: "pass", issues: [] })
  loadBatchAvoidanceForItem.mockReset()
  loadBatchAvoidanceForItem.mockResolvedValue({ titlePatterns: [], faqPairs: [], keywordSets: [], bodies: [PRIOR_BODY] })
  resolveNeedsReviewItem.mockReset()
  resolveNeedsReviewItem.mockResolvedValue({ kind: "resolved", path: "/places/x", changedFields: [], itemStatus: "warn_ready" })
})

async function correct(overrides: Record<string, unknown> = {}) {
  const { correctReadyContent } = await import("@/lib/batch/ready-correction-service")
  return correctReadyContent({ placeId: PLACE, generationId: GEN, expectedContentHash: HASH, edits: { body: NEW_BODY }, actor: "ops:pilot-review", reason: "배치 내 첫 문장 중복", ...overrides })
}
const place = (): Row => tables["places"]?.[0] ?? {}
const generationOutput = (): Row => (tables["ai_generations"]?.[0]?.["output"] as Row | undefined) ?? {}
const seoPage = (): Row => tables["seo_pages"]?.[0] ?? {}
const generationRow = (): Row => tables["ai_generations"]?.[0] ?? {}
const itemRow = (): Row => tables["batch_run_items"]?.[0] ?? {}

describe("ready 보정 — 정상 경로", () => {
  it("본문을 고치면 generation·seo_pages·places가 같은 콘텐츠로 맞춰진다", async () => {
    const result = await correct()

    expect(result).toMatchObject({ kind: "corrected", changedFields: ["body"] })
    expect(place()["description"]).toBe(NEW_BODY)
    expect((generationOutput()["generated"] as Row)["description"]).toBe(NEW_BODY)
    expect((generationOutput()["after"] as Row)["description"]).toBe(NEW_BODY)
    // 결과 해시는 실제 저장된 places 콘텐츠의 해시다.
    expect(result.kind === "corrected" && result.contentHash).toBe(computePlaceContentHash(place() as never))
  })

  it("제목·메타 설명을 고치면 seo_pages의 title/description도 함께 바뀐다 (재적용은 seo_pages를 갱신하지 않는다)", async () => {
    await correct({ edits: { title: "원병원 장례식장 근조화환 주문 안내", meta_description: "원병원 장례식장 근조화환 주문 전 확인 사항 안내입니다." } })

    expect(seoPage()["title"]).toBe("원병원 장례식장 근조화환 주문 안내")
    expect(seoPage()["description"]).toBe("원병원 장례식장 근조화환 주문 전 확인 사항 안내입니다.")
    expect(place()["meta_title"]).toBe("원병원 장례식장 근조화환 주문 안내")
  })

  it("원본·사용량·비용·다양화 감사를 보존하고 보정 감사를 남긴다", async () => {
    await correct()

    const output = generationOutput()
    expect(output["estimated_cost"]).toBe(0.0009)
    expect(output["usage"]).toEqual({ input_tokens: 900, output_tokens: 300, total_tokens: 1200 })
    expect(output["audit"]).toEqual({ title_pattern_id: "region-dash" })
    expect(output["ready_correction"]).toMatchObject({
      corrected_by: "ops:pilot-review",
      reason: "배치 내 첫 문장 중복",
      changed_fields: ["body"],
      before: { description: content.description },
      before_hash: HASH,
    })
    // applied 상태를 preview로 되돌려 우회하지 않는다.
    expect(tables["ai_generations"]?.[0]?.["status"]).toBe("applied")
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

  it("해시 기준인 places를 마지막에 쓴다 — 중간에 실패해도 같은 입력으로 다시 실행할 수 있다", async () => {
    await correct()
    expect(writes.map((write) => write.table)).toEqual(["ai_generations", "seo_pages", "places"])
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

  it("바뀌는 것이 없으면 차단한다", async () => {
    expect(await correct({ edits: { body: content.description } })).toEqual({ kind: "blocked", reason: "no-changes" })
    expect(writes).toHaveLength(0)
  })

  it("문장 필드 밖(FAQ·키워드)은 넘겨도 무시되고, 그것만 있으면 변경 없음이다", async () => {
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

describe("ready 보정 — 중간 실패", () => {
  it("seo_pages 쓰기가 실패하면 places는 그대로이고, 같은 입력으로 다시 실행해 수렴한다", async () => {
    failWrite = "seo_pages"
    expect(await correct()).toEqual({ kind: "failed", step: "seo-page" })
    expect(place()["description"]).toBe(content.description)

    failWrite = null
    expect((await correct()).kind).toBe("corrected")
    expect(place()["description"]).toBe(NEW_BODY)
  })

  it("places까지 쓴 뒤에는 같은 해시로 다시 실행할 수 없다 (이중 적용 방지)", async () => {
    await correct()
    writes.length = 0
    expect(await correct()).toEqual({ kind: "blocked", reason: "content-changed" })
    expect(writes).toHaveLength(0)
  })

  it("그 사이 게시돼 seo_page 조건이 깨지면 쓰지 못하고 실패로 보고한다", async () => {
    evaluateGenerationQuality.mockImplementation(() => {
      seoPage()["published_at"] = NOW
      return Promise.resolve({ status: "pass", issues: [] })
    })
    expect(await correct()).toEqual({ kind: "failed", step: "seo-page" })
    expect(place()["description"]).toBe(content.description)
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
    expect(task !== null && isOpsTaskExpired(task, "2026-11-10T23:59:59.000Z")).toBe(false)
    expect(task !== null && isOpsTaskExpired(task, "2026-11-11T00:00:00.000Z")).toBe(true)
  })
})

// ── 작업 실행 ────────────────────────────────────────────────────
async function runTask() {
  const { runOpsTask } = await import("@/lib/batch/ops-task-service")
  return runOpsTask({ nowIso: NOW })
}
const resultRow = (): Row | undefined => tables["settings"]?.find((row) => row["key"] === "ops_task_result:pilot-review-20261110")

describe("운영 작업 실행", () => {
  it("설정이 없으면 아무것도 하지 않는다", async () => {
    expect(await runTask()).toEqual({ kind: "skipped", reason: "no-task" })
    expect(writes).toHaveLength(0)
  })

  it("해석되지 않는 설정은 실행하지 않는다", async () => {
    tables["settings"] = [{ key: "ops_task", value: { ...validTask, actor: "admin@example.com" } }]
    expect(await runTask()).toEqual({ kind: "skipped", reason: "no-task" })
    expect(resolveNeedsReviewItem).not.toHaveBeenCalled()
  })

  it("만료된 작업은 실행하지 않는다", async () => {
    tables["settings"] = [{ key: "ops_task", value: { ...validTask, expiresAt: "2026-11-10T06:00:00.000Z" } }]
    expect(await runTask()).toEqual({ kind: "skipped", reason: "expired" })
    expect(resultRow()).toBeUndefined()
  })

  it("step을 순서대로 실행하고 결과를 남긴다", async () => {
    tables["settings"] = [{ key: "ops_task", value: validTask }]

    const outcome = await runTask()

    expect(outcome).toMatchObject({ kind: "finished", status: "done" })
    expect(outcome.kind === "finished" && outcome.results.map((result) => `${result.kind}:${result.outcome}`)).toEqual(["correct-ready:corrected", "resolve-needs-review:warn_ready"])
    expect(place()["description"]).toBe(NEW_BODY)
    expect(resolveNeedsReviewItem).toHaveBeenCalledWith({ itemId: ITEM, generationId: GEN, edits: {}, confirmed: true, actor: "ops:pilot-review" })
    expect(resultRow()?.["value"]).toMatchObject({ status: "done" })
  })

  it("같은 작업 ID는 두 번 실행되지 않는다", async () => {
    tables["settings"] = [{ key: "ops_task", value: validTask }]
    await runTask()
    resolveNeedsReviewItem.mockClear()

    expect(await runTask()).toEqual({ kind: "skipped", reason: "already-claimed" })
    expect(resolveNeedsReviewItem).not.toHaveBeenCalled()
  })

  it("step이 실패하면 거기서 멈추고 뒤 step은 실행하지 않는다", async () => {
    tables["settings"] = [{ key: "ops_task", value: { ...validTask, steps: [{ ...validTask.steps[0], expectedContentHash: "0".repeat(64) }, validTask.steps[1]] } }]

    const outcome = await runTask()

    expect(outcome).toMatchObject({ kind: "finished", status: "stopped" })
    expect(outcome.kind === "finished" && outcome.results).toEqual([{ index: 0, kind: "correct-ready", ok: false, outcome: "blocked", detail: "content-changed" }])
    expect(resolveNeedsReviewItem).not.toHaveBeenCalled()
    expect(resultRow()?.["value"]).toMatchObject({ status: "stopped" })
  })

  it("검토 해소가 품질 미통과면 멈춘다", async () => {
    resolveNeedsReviewItem.mockResolvedValue({ kind: "quality-not-pass", status: "fail" })
    tables["settings"] = [{ key: "ops_task", value: { ...validTask, steps: [validTask.steps[1]] } }]

    expect(await runTask()).toMatchObject({ kind: "finished", status: "stopped", results: [{ ok: false, outcome: "quality-not-pass", detail: "fail" }] })
  })

  it("step이 던져도 작업은 결과를 남기고 끝난다", async () => {
    resolveNeedsReviewItem.mockRejectedValue(new Error("db unavailable"))
    tables["settings"] = [{ key: "ops_task", value: { ...validTask, steps: [validTask.steps[1]] } }]

    expect(await runTask()).toMatchObject({ kind: "finished", status: "stopped", results: [{ ok: false, outcome: "threw" }] })
    expect(resultRow()?.["value"]).toMatchObject({ status: "stopped" })
  })

  it("claim에 실패하면(중복이 아닌 오류) 실행하지 않고 던진다", async () => {
    tables["settings"] = [{ key: "ops_task", value: validTask }]
    insertErrorCode = "08006"
    await expect(runTask()).rejects.toThrow()
    expect(resolveNeedsReviewItem).not.toHaveBeenCalled()
    expect(place()["description"]).toBe(content.description)
  })
})
