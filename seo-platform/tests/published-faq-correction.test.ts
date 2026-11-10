// 게시된 페이지의 FAQ 답변 보정 계약.
// 이미 공개된 글을 관리자 세션 없이 고치는 경로이므로: 답변 한 개만, 호출자가 본 콘텐츠와 지금 콘텐츠가 같을 때만,
// 게시 상태·게시 시각·질문·다른 필드는 그대로 두고, 중간에 멈추면 같은 요청으로만 이어서 끝낸다.
import { beforeEach, describe, expect, it, vi } from "vitest"

import { computePlaceContentHash } from "@/lib/batch/content-hash"
import { parseOpsTask } from "@/lib/batch/ops-task"
import { editFaqAnswer, newIssueCodes, PUBLISHED_FAQ_ANSWER_MAX_LENGTH, parsePublishedFaqCorrectionStep } from "@/lib/batch/published-faq-correction"
import { sameInstant } from "@/lib/batch/published-faq-correction-service"

vi.mock("server-only", () => ({}))

// ── Supabase 대역 (메모리 테이블, JSON 경로 필터 지원) ──────────────
type Row = Record<string, unknown>
type Filter = { op: "eq" | "is"; column: string; value: unknown }
const tables: Record<string, Row[]> = {}
let clock = 0
let failWriteWhen: ((table: string, patch: Row) => boolean) | null = null
let afterWrite: ((table: string, patch: Row) => void) | null = null
let beforeWrite: ((table: string) => void) | null = null
let failReadWhen: ((table: string) => boolean) | null = null
const writes: { table: string; patch: Row }[] = []

// "output->a->>b" 같은 PostgREST JSON 경로를 읽는다. 없는 키는 null (SQL NULL).
function readColumn(row: Row, column: string): unknown {
  const parts = column.split(/->>?/)
  let value: unknown = row
  for (const part of parts) {
    value = typeof value === "object" && value !== null ? (value as Row)[part] : undefined
  }
  return value ?? null
}

// timestamptz 컬럼에 쓴 값은 DB가 자기 표기("…+00:00")로 돌려준다 — 코드가 쓴 "…Z" 문자열 그대로 돌아오지 않는다.
const TIMESTAMP_COLUMNS = ["last_modified_at", "published_at"]
function asStored(patch: Row): Row {
  for (const column of TIMESTAMP_COLUMNS) {
    const value = patch[column]
    if (typeof value === "string" && value.endsWith("Z")) {
      patch[column] = `${value.slice(0, -1)}+00:00`
    }
  }
  return patch
}

function builder(table: string) {
  const filters: Filter[] = []
  let patch: Row | null = null
  let remove = false
  const matchesFilter = (row: Row, filter: Filter): boolean => {
    const [column, prefix] = filter.column.split("^")
    return prefix === undefined ? readColumn(row, filter.column) === filter.value : String(row[column ?? ""]).startsWith(prefix)
  }
  const rows = (): Row[] => (tables[table] ?? []).filter((row) => filters.every((filter) => matchesFilter(row, filter)))
  const run = (): { data: Row[] | null; error: { message: string } | null } => {
    if (remove) {
      const targets = rows()
      tables[table] = (tables[table] ?? []).filter((row) => !targets.includes(row))
      return { data: targets, error: null }
    }
    if (patch !== null) {
      beforeWrite?.(table)
      if (failWriteWhen?.(table, patch) === true) {
        return { data: null, error: { message: "write failed" } }
      }
      const targets = rows()
      for (const row of targets) {
        clock += 1
        // places·seo_pages·settings에는 updated_at 트리거가 있다. ai_generations에는 없다.
        Object.assign(row, asStored(structuredClone(patch)), table === "ai_generations" ? {} : { updated_at: `t${String(clock)}` })
      }
      if (targets.length > 0) {
        writes.push({ table, patch })
        afterWrite?.(table, patch)
      }
      return { data: targets.map((row) => structuredClone(row)), error: null }
    }
    if (failReadWhen?.(table) === true) {
      return { data: null, error: { message: "read failed" } }
    }
    return { data: rows().map((row) => structuredClone(row)), error: null }
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
    in: () => api,
    like: (column: string, pattern: string) => {
      const prefix = pattern.replace(/%$/, "")
      filters.push({ op: "eq", column: `${column}^${prefix}`, value: true })
      return api
    },
    order: () => api,
    limit: () => api,
    delete: () => {
      remove = true
      return api
    },
    update: (next: Row) => {
      patch = next
      return api
    },
    insert: (row: Row) => {
      if ((tables[table] ?? []).some((existing) => existing["key"] === row["key"])) {
        return Promise.resolve({ error: { message: "duplicate key", code: "23505" } })
      }
      ;(tables[table] ??= []).push({ ...row, updated_at: "t0" })
      return Promise.resolve({ error: null })
    },
    maybeSingle: () => {
      const result = run()
      return Promise.resolve({ data: result.data?.[0] ?? null, error: result.error })
    },
    then: (onFulfilled: (value: { data: Row[] | null; error: { message: string } | null; count?: number }) => unknown) => {
      const result = run()
      return Promise.resolve({ ...result, count: result.data?.length ?? 0 }).then(onFulfilled)
    },
  }
  return api
}
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceRoleClient: () => ({ from: (table: string) => builder(table) }) }))

const holdLog: string[] = []
vi.mock("@/lib/seo-pages/publish-hold", () => ({
  setPublishFreeze: () => {
    holdLog.push("freeze")
    return Promise.resolve("set")
  },
  clearPublishFreeze: () => {
    holdLog.push("unfreeze")
    return Promise.resolve(true)
  },
  acquirePublishLock: () => {
    holdLog.push("lock")
    return Promise.resolve(true)
  },
  releasePublishLock: () => {
    holdLog.push("unlock")
    return Promise.resolve()
  },
}))

const PLACE = "00000000-0000-4000-8000-000000000005"
const GEN = "11111111-0000-4000-8000-000000000005"
const SEO = "33333333-0000-4000-8000-000000000005"
const PUBLISHED_AT = "2026-11-10T08:33:00.123456+00:00"
const QUESTION = "웨딩그룹위더스 영등포 행사장 내 반입 위치는 어떻게 확인하나요?"
const OLD_ANSWER = "행사장 내 화환 수령 위치는 주문 과정에서 확인할 수 있으며, 행사장 담당자와도 사전에 확인하는 것이 좋습니다."
const NEW_ANSWER = "화환 반입 가능 여부와 위치는 예식장에 직접 확인해 주세요. 제작·배송 가능 여부는 주문 과정에서 별도로 확인됩니다."

const content = {
  meta_title: "서울 영등포구 웨딩그룹위더스 영등포 축하화환 보내는 방법",
  meta_description: "웨딩그룹위더스 영등포 축하화환 주문은 수령 위치 확인 후 페이지에서 진행하세요.",
  description: "서울 영등포구 웨딩그룹위더스 영등포에 축하화환을 보내실 때는 행사장 내 수령 위치를 반드시 확인하세요.",
  faq: [
    { question: QUESTION, answer: OLD_ANSWER },
    { question: "축하화환 리본 문구는 어떻게 작성하면 되나요?", answer: "리본 문구 작성은 주문 시 입력란을 통해 가능합니다." },
  ],
  keywords: ["웨딩그룹위더스 영등포", "서울 축하화환"],
  internal_links: [],
}
const HASH = computePlaceContentHash(content)
const NEXT = { ...content, faq: [{ question: QUESTION, answer: NEW_ANSWER }, content.faq[1]] }
const NEXT_HASH = computePlaceContentHash(NEXT)
const ORIGINAL_OUTPUT = {
  generated: content,
  after: content,
  provider: "openai",
  model: "gpt-4.1-mini",
  usage: { input_tokens: 1000, output_tokens: 300, total_tokens: 1300 },
  estimated_cost: 0.0009,
  audit: { title_pattern_id: "celebration-how-to", faq_topic_keys: ["venue-access", "ribbon-message"] },
  quality: { status: "pass", issues: [] },
  ready_corrections: [{ correction_id: "earlier", changed_fields: ["body"] }],
}

function seed(): void {
  for (const key of Object.keys(tables)) {
    Reflect.deleteProperty(tables, key)
  }
  tables["places"] = [
    { id: PLACE, name: "웨딩그룹위더스 영등포", status: "published", category: "숙박/행사", city: "서울", district: "영등포구", address: "서울 영등포구 영중로 100", phone: "02-000-0000", normalized_phone: "020000000", email: null, homepage: null, updated_at: "t0", ...structuredClone(content) },
  ]
  tables["ai_generations"] = [{ id: GEN, place_id: PLACE, status: "applied", output: structuredClone(ORIGINAL_OUTPUT) }]
  tables["seo_pages"] = [{ id: SEO, page_type: "place", place_id: PLACE, status: "published", published_at: PUBLISHED_AT, path: "/places/area-seoul-test", slug: "area-seoul-test", last_modified_at: PUBLISHED_AT, updated_at: "t0" }]
  tables["batch_run_items"] = [{ id: "item-5", place_id: PLACE, status: "ready", generation_id: GEN, retry_generation_id: null }]
  tables["settings"] = []
  tables["batch_approvals"] = []
  tables["batch_runs"] = []
}

beforeEach(() => {
  seed()
  clock = 0
  failWriteWhen = null
  afterWrite = null
  beforeWrite = null
  failReadWhen = null
  vi.unstubAllEnvs()
  writes.length = 0
  holdLog.length = 0
})

const place = (): Row => tables["places"]?.[0] ?? {}
const seo = (): Row => tables["seo_pages"]?.[0] ?? {}
const generationRow = (): Row => tables["ai_generations"]?.[0] ?? {}
const itemRow = (): Row => tables["batch_run_items"]?.[0] ?? {}
const output = (): Row => (generationRow()["output"] ?? {}) as Row

async function correct(overrides: Record<string, unknown> = {}) {
  const { correctPublishedFaq } = await import("@/lib/batch/published-faq-correction-service")
  return correctPublishedFaq({
    taskId: "faq-fix-1",
    stepIndex: 0,
    placeId: PLACE,
    generationId: GEN,
    expectedContentHash: HASH,
    faqIndex: 0,
    expectedQuestion: QUESTION,
    answer: NEW_ANSWER,
    actor: "ops:faq-fix",
    reason: "주문 과정이 시설 반입 위치를 확인해 주는 것으로 읽힘",
    ...overrides,
  })
}

const STEP = { kind: "correct-published-faq", placeId: PLACE, generationId: GEN, expectedContentHash: HASH, faqIndex: 0, expectedQuestion: QUESTION, answer: NEW_ANSWER, reason: "사유" }

describe("step 해석 (answer-only)", () => {
  it("정해진 형식의 step을 받는다", () => {
    expect(parsePublishedFaqCorrectionStep(STEP)).toEqual(STEP)
  })

  it.each([
    ["질문을 바꾸려는 키", { ...STEP, question: "다른 질문" }],
    ["다른 필드 입력", { ...STEP, edits: { title: "x" } }],
    ["키 누락", Object.fromEntries(Object.entries(STEP).filter(([key]) => key !== "expectedQuestion"))],
    ["음수 index", { ...STEP, faqIndex: -1 }],
    ["정수가 아닌 index", { ...STEP, faqIndex: 0.5 }],
    ["문자열 index", { ...STEP, faqIndex: "0" }],
    ["빈 답변", { ...STEP, answer: "  " }],
    ["앞뒤 공백이 있는 답변", { ...STEP, answer: ` ${NEW_ANSWER}` }],
    ["너무 긴 답변", { ...STEP, answer: "가".repeat(PUBLISHED_FAQ_ANSWER_MAX_LENGTH + 1) }],
    ["빈 질문", { ...STEP, expectedQuestion: "" }],
    ["빈 사유", { ...STEP, reason: " " }],
    ["해시 형식 오류", { ...STEP, expectedContentHash: "abc" }],
    ["장소 ID 형식 오류", { ...STEP, placeId: "x" }],
  ])("거절: %s", (_label, raw) => {
    expect(parsePublishedFaqCorrectionStep(raw as Record<string, unknown>)).toBeNull()
  })

  it("ops_task는 이 step을 받고, 어긋난 step이 하나라도 있으면 작업 전체를 버린다", () => {
    const task = { id: "faq-fix-1", expiresAt: "2026-11-11T00:00:00.000Z", actor: "ops:faq-fix", inheritFreezeFrom: null, steps: [STEP] }
    expect(parseOpsTask(task)?.steps[0]).toEqual(STEP)
    expect(parseOpsTask({ ...task, steps: [STEP, { ...STEP, question: "다른 질문" }] })).toBeNull()
  })
})

describe("시각 비교 (같은 순간, 마이크로초까지)", () => {
  it.each([
    ["2026-11-10T09:46:05.882Z", "2026-11-10T09:46:05.882+00:00"],
    ["2026-11-10T09:46:05.882Z", "2026-11-10T09:46:05.882000+00:00"],
    ["2026-11-10T09:46:05Z", "2026-11-10T09:46:05.000000+00:00"],
    ["2026-11-10T18:46:05.882+09:00", "2026-11-10T09:46:05.882Z"],
    ["2026-11-10T08:33:00.123456+00:00", "2026-11-10T08:33:00.123456+00:00"],
  ])("같다: %s = %s", (a, b) => {
    expect(sameInstant(a, b)).toBe(true)
    expect(sameInstant(b, a)).toBe(true)
  })

  it.each([
    ["2026-11-10T08:33:00.123456+00:00", "2026-11-10T08:33:00.123999+00:00"],
    ["2026-11-10T09:46:05.882000+00:00", "2026-11-10T09:46:05.882001+00:00"],
    ["2026-11-10T09:46:05.882Z", "2026-11-10T09:46:05.883Z"],
    ["2026-11-10T09:46:05.882Z", "2026-11-10T09:46:05.882+09:00"],
    ["2026-11-10T09:46:05.882Z", "not a time"],
    ["not a time", "not a time"],
    ["2026-11-10 09:46:05.882+00", "2026-11-10 09:46:05.882+00"],
    ["2026-13-40T09:46:05Z", "2026-13-40T09:46:05Z"],
    ["2026-11-10T09:46:05.882Z", null],
    [null, null],
    [1, 1],
  ])("다르다: %s ≠ %s", (a, b) => {
    expect(sameInstant(a, b)).toBe(false)
  })
})

describe("답변 편집 (순수)", () => {
  it("그 항목의 답변만 바꾸고 입력은 건드리지 않는다", () => {
    const snapshot = structuredClone(content)
    const edited = editFaqAnswer(content, { faqIndex: 0, expectedQuestion: QUESTION, answer: NEW_ANSWER })
    expect(edited).toEqual({ kind: "edited", content: NEXT, before: OLD_ANSWER })
    expect(content).toEqual(snapshot)
  })

  it("index가 범위 밖이거나 질문이 다르거나 답이 같으면 편집하지 않는다", () => {
    expect(editFaqAnswer(content, { faqIndex: 2, expectedQuestion: QUESTION, answer: NEW_ANSWER }).kind).toBe("index-out-of-range")
    expect(editFaqAnswer(content, { faqIndex: 1, expectedQuestion: QUESTION, answer: NEW_ANSWER }).kind).toBe("question-mismatch")
    expect(editFaqAnswer(content, { faqIndex: 0, expectedQuestion: QUESTION, answer: OLD_ANSWER }).kind).toBe("no-changes")
  })

  it("보정 전부터 있던 문제는 새 문제로 세지 않는다", () => {
    expect(newIssueCodes(["a", "b"], ["a", "b"])).toEqual([])
    expect(newIssueCodes(["a"], ["a", "c"])).toEqual(["c"])
  })
})

describe("게시 FAQ 보정 — 정상 경로", () => {
  it("FAQ 답변만 바꾸고 게시 상태·시각·다른 필드는 그대로 둔다", async () => {
    const before = structuredClone(place())
    const result = await correct()

    expect(result).toEqual({ kind: "corrected", contentHash: NEXT_HASH, resumed: false, path: "/places/area-seoul-test" })
    expect(place()["faq"]).toEqual(NEXT.faq)
    for (const key of ["status", "meta_title", "meta_description", "description", "keywords", "internal_links", "name", "category", "address"]) {
      expect(place()[key], key).toEqual(before[key])
    }
    // places에는 faq 말고 아무것도 쓰지 않았다.
    expect(writes.filter((write) => write.table === "places").map((write) => Object.keys(write.patch))).toEqual([["faq"]])
    // seo_pages는 수정 시각만.
    expect(writes.filter((write) => write.table === "seo_pages").map((write) => Object.keys(write.patch))).toEqual([["last_modified_at"]])
    expect(seo()["status"]).toBe("published")
    expect(seo()["published_at"]).toBe(PUBLISHED_AT)
    expect(seo()["path"]).toBe("/places/area-seoul-test")
  })

  it("generation은 현행 FAQ에 맞추고 이력을 한 번 남기며, 최초 기록은 보존한다", async () => {
    await correct()

    const out = output()
    expect(out["generated"]).toEqual(NEXT)
    expect(out["after"]).toEqual(NEXT)
    expect(out["pending_published_faq_correction"]).toBeUndefined()
    for (const key of ["provider", "model", "usage", "estimated_cost", "audit", "quality", "ready_corrections"]) {
      expect(out[key], key).toEqual((ORIGINAL_OUTPUT as Row)[key])
    }
    const history = out["published_faq_corrections"] as Row[]
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ task_id: "faq-fix-1", step_index: 0, place_id: PLACE, faq_index: 0, question: QUESTION, answer_before: OLD_ANSWER, answer_after: NEW_ANSWER, corrected_by: "ops:faq-fix", before_hash: HASH, after_hash: NEXT_HASH, path: "/places/area-seoul-test" })
    // 이력에는 전체 콘텐츠 사본을 두지 않는다.
    expect(history[0]?.["content"]).toBeUndefined()
  })

  // 2026-11-10 첫 실행: 세 곳이 모두 보정됐는데 재확인이 "…Z" ≠ "…+00:00" 문자열 비교로 실패했다.
  it("DB가 시각을 다른 표기로 돌려줘도 같은 순간이면 완료로 본다", async () => {
    expect((await correct()).kind).toBe("corrected")
    expect(String(seo()["last_modified_at"])).toMatch(/\+00:00$/)
    const record = (output()["published_faq_corrections"] as Row[])[0] ?? {}
    expect(String(record["corrected_at"])).toMatch(/Z$/)
    expect(Date.parse(String(record["corrected_at"]))).toBe(Date.parse(String(seo()["last_modified_at"])))
  })

  it("의도 기록 → 장소 → SEO → generation 순서로 쓴다", async () => {
    await correct()
    expect(writes.map((write) => write.table)).toEqual(["ai_generations", "places", "seo_pages", "ai_generations"])
    expect((writes[0]?.patch["output"] as Row)["pending_published_faq_correction"]).toMatchObject({ before_hash: HASH, after_hash: NEXT_HASH })
    // 의도를 기록하는 시점에는 generated가 아직 옛 값이다.
    expect((writes[0]?.patch["output"] as Row)["generated"]).toEqual(content)
  })
})

describe("게시 FAQ 보정 — 차단 (무변경)", () => {
  const expectUntouched = (): void => {
    expect(writes).toEqual([])
    expect(place()["faq"]).toEqual(content.faq)
  }

  it.each([
    ["place-not-published", () => (place()["status"] = "draft")],
    ["generation-not-applied", () => (generationRow()["status"] = "preview")],
    ["generation-mismatch", () => (generationRow()["place_id"] = "other")],
    ["seo-page-not-published", () => (seo()["status"] = "ready")],
    ["seo-page-not-published", () => (seo()["published_at"] = null)],
    ["seo-page-not-published", () => tables["seo_pages"]?.push({ ...seo(), id: "dup" })],
    ["item-not-linked", () => (itemRow()["generation_id"] = "other")],
    ["mode-unsupported", () => (place()["category"] = "hospital")],
    ["content-changed", () => (place()["description"] = "누가 본문을 바꿨다")],
  ])("%s", async (reason, mutate) => {
    mutate()
    expect(await correct()).toEqual({ kind: "blocked", reason })
    expectUntouched()
  })

  it("장소가 없으면 place-not-found", async () => {
    tables["places"] = []
    expect(await correct()).toEqual({ kind: "blocked", reason: "place-not-found" })
  })

  it("index·질문이 어긋나거나 답이 같으면 쓰지 않는다", async () => {
    expect(await correct({ faqIndex: 5 })).toEqual({ kind: "blocked", reason: "index-out-of-range" })
    expect(await correct({ expectedQuestion: "다른 질문" })).toEqual({ kind: "blocked", reason: "question-mismatch" })
    expect(await correct({ answer: OLD_ANSWER })).toEqual({ kind: "blocked", reason: "no-changes" })
    expectUntouched()
  })

  it.each([
    ["전화번호 누출", "문의는 02-000-0000으로 주세요.", "schema"],
    ["가격", "축하화환은 50,000원부터 주문할 수 있습니다.", "banned"],
    ["배송 확정 표현", "당일 배송을 보장합니다. 주문 과정에서 확인됩니다.", "banned"],
    ["다른 모드 어휘", "빈소 위치는 예식장에 직접 확인해 주세요.", "vocabulary"],
  ])("금지: %s", async (_label, answer, check) => {
    const result = await correct({ answer })
    expect(result).toMatchObject({ kind: "rejected", check })
    expectUntouched()
  })

  it("바꾸지 않는 본문에 예전부터 있던 금지 표현 때문에 FAQ 보정이 막히지 않는다", async () => {
    place()["description"] = "당일 배송을 보장합니다."
    const result = await correct({ expectedContentHash: computePlaceContentHash({ ...content, description: "당일 배송을 보장합니다." }) })
    expect(result.kind).toBe("corrected")
  })
})

describe("게시 FAQ 보정 — 경쟁·중단·복구", () => {
  it("평가하는 사이 장소가 수정되면 덮어쓰지 않는다 (0행 = 충돌)", async () => {
    afterWrite = (table) => {
      if (table === "ai_generations") {
        afterWrite = null
        Object.assign(place(), { updated_at: "t-other" })
      }
    }
    expect(await correct()).toEqual({ kind: "blocked", reason: "write-conflict" })
    expect(place()["faq"]).toEqual(content.faq)
    expect(writes.map((write) => write.table)).toEqual(["ai_generations"])
  })

  it("의도 기록이 실패하면 아무것도 바꾸지 않는다", async () => {
    failWriteWhen = (table) => table === "ai_generations"
    expect(await correct()).toEqual({ kind: "failed", step: "intent" })
    expect(place()["faq"]).toEqual(content.faq)
  })

  // 계약을 따르는 다른 쓰기(품질표 첨부 등)를 흉내 낸다: 키를 바꾸고 새 output_revision을 넣는다.
  const concurrentQualityWrite = (): void => {
    Object.assign(output(), { quality: { status: "fail", issues: [{ code: "x" }] }, output_revision: `other-${String(clock)}` })
  }

  it("읽은 뒤·의도 쓰기 전에 다른 경로가 output을 썼으면 덮어쓰지 않는다 (그 변경이 남는다)", async () => {
    beforeWrite = (table) => {
      if (table === "ai_generations") {
        beforeWrite = null
        concurrentQualityWrite()
      }
    }
    expect(await correct()).toEqual({ kind: "failed", step: "intent" })
    expect(place()["faq"]).toEqual(content.faq)
    expect(output()["quality"]).toEqual({ status: "fail", issues: [{ code: "x" }] })
    expect(output()["pending_published_faq_correction"]).toBeUndefined()
  })

  it("확정 쓰기 직전에 다른 경로가 output을 썼으면 덮어쓰지 않고, 다시 실행하면 그 변경 위에 이어서 끝낸다", async () => {
    let generationWrites = 0
    beforeWrite = (table) => {
      if (table === "ai_generations") {
        generationWrites += 1
        if (generationWrites === 2) {
          beforeWrite = null
          concurrentQualityWrite()
        }
      }
    }
    expect(await correct()).toEqual({ kind: "failed", step: "generation" })
    // 다른 경로의 변경은 살아 있고, 의도도 그대로 남아 있다.
    expect(output()["quality"]).toEqual({ status: "fail", issues: [{ code: "x" }] })
    expect(output()["pending_published_faq_correction"]).toMatchObject({ after_hash: NEXT_HASH })

    expect(await correct({ taskId: "faq-fix-2" })).toEqual({ kind: "corrected", contentHash: NEXT_HASH, resumed: true, path: "/places/area-seoul-test" })
    expect(output()["quality"]).toEqual({ status: "fail", issues: [{ code: "x" }] })
    expect(output()["generated"]).toEqual(NEXT)
    expect(output()["published_faq_corrections"]).toHaveLength(1)
  })

  it("쓸 때마다 새 output 버전을 남긴다", async () => {
    await correct()
    const revisions = writes.filter((write) => write.table === "ai_generations").map((write) => (write.patch["output"] as Row)["output_revision"])
    expect(revisions).toHaveLength(2)
    expect(new Set(revisions).size).toBe(2)
    expect(revisions.every((revision) => typeof revision === "string" && revision.length > 0)).toBe(true)
  })

  it.each([
    ["seo-page", "seo_pages"],
    ["generation", "ai_generations"],
  ])("%s 쓰기가 실패하면 실패를 알리고, 같은 요청으로 이어서 끝낸다 (이력 1회)", async (step, table) => {
    let generationWrites = 0
    failWriteWhen = (target) => {
      if (target === "ai_generations") {
        generationWrites += 1
      }
      return target === table && (table === "seo_pages" || generationWrites === 2)
    }
    expect(await correct()).toEqual({ kind: "failed", step })
    // 장소는 이미 보정본이고 의도는 남아 있다.
    expect(place()["faq"]).toEqual(NEXT.faq)
    expect(output()["pending_published_faq_correction"]).toMatchObject({ after_hash: NEXT_HASH })
    expect(output()["generated"]).toEqual(content)

    failWriteWhen = null
    writes.length = 0
    // 복구: 같은 step (expectedContentHash는 보정 전 해시 그대로).
    expect(await correct({ taskId: "faq-fix-2" })).toEqual({ kind: "corrected", contentHash: NEXT_HASH, resumed: true, path: "/places/area-seoul-test" })
    expect(writes.some((write) => write.table === "places")).toBe(false)
    expect(output()["generated"]).toEqual(NEXT)
    expect(output()["pending_published_faq_correction"]).toBeUndefined()
    expect(output()["published_faq_corrections"]).toHaveLength(1)
    expect(seo()["published_at"]).toBe(PUBLISHED_AT)
  })

  it("의도 없이 '이미 같은 답'이라는 이유로 generation을 맞추지 않는다", async () => {
    place()["faq"] = structuredClone(NEXT.faq)
    expect(await correct()).toEqual({ kind: "blocked", reason: "content-changed" })
    expect(writes).toEqual([])
    expect(output()["generated"]).toEqual(content)
  })

  it("손상된 의도(해시가 내용과 맞지 않음)로는 이어 하지 않는다", async () => {
    place()["faq"] = structuredClone(NEXT.faq)
    output()["pending_published_faq_correction"] = { correction_id: "x", place_id: PLACE, seo_page_id: SEO, seo_published_at: PUBLISHED_AT, path: "/places/area-seoul-test", faq_index: 0, question: QUESTION, answer_after: NEW_ANSWER, corrected_by: "ops:faq-fix", corrected_at: "2026-11-10T09:00:00.000Z", reason: "r", before_hash: HASH, after_hash: NEXT_HASH, content: { ...NEXT, description: "조작된 본문" } }
    expect(await correct()).toEqual({ kind: "blocked", reason: "corrupt-intent" })
    expect(writes).toEqual([])
  })

  it("다른 요청(다른 답)으로는 남의 의도를 이어 하지 않는다", async () => {
    failWriteWhen = (table) => table === "seo_pages"
    await correct()
    failWriteWhen = null
    writes.length = 0
    expect(await correct({ answer: "예식장에 직접 확인해 주세요." })).toEqual({ kind: "blocked", reason: "content-changed" })
    expect(writes).toEqual([])
  })

  it("끝나지 않은 보정 위에 새 보정을 얹지 않는다", async () => {
    failWriteWhen = (table) => table === "seo_pages"
    await correct()
    failWriteWhen = null
    writes.length = 0
    // 지금 장소(보정본)의 해시를 기준으로 다른 항목을 고치려는 새 요청.
    const result = await correct({ expectedContentHash: NEXT_HASH, faqIndex: 1, expectedQuestion: content.faq[1]?.question, answer: "예식장에 직접 확인해 주세요." })
    expect(result).toEqual({ kind: "blocked", reason: "incomplete-correction" })
    expect(writes).toEqual([])
  })

  it.each(["generated", "after"])("확정 직후 생성 기록의 %s가 장소와 다른 콘텐츠가 되면 완료로 보고하지 않는다", async (key) => {
    let generationWrites = 0
    afterWrite = (table) => {
      if (table === "ai_generations") {
        generationWrites += 1
        if (generationWrites === 2) {
          output()[key] = { ...NEXT, description: "장소와 다른 본문" }
        }
      }
    }
    expect(await correct()).toEqual({ kind: "failed", step: "verify" })
  })

  it("확정 직후 다른 경로가 output을 다시 썼으면 완료로 보고하지 않는다", async () => {
    let generationWrites = 0
    afterWrite = (table) => {
      if (table === "ai_generations") {
        generationWrites += 1
        if (generationWrites === 2) {
          concurrentQualityWrite()
        }
      }
    }
    expect(await correct()).toEqual({ kind: "failed", step: "verify" })
  })

  it("확정까지 끝난 뒤 재확인 조회가 실패했어도, 같은 요청을 다시 실행하면 쓰기 없이 완료로 답한다 (이력 1회)", async () => {
    let placeReads = 0
    failReadWhen = (table) => {
      if (table === "places") {
        placeReads += 1
        return placeReads === 2
      }
      return false
    }
    expect(await correct()).toEqual({ kind: "failed", step: "verify" })
    // 보정은 끝나 있다: 의도는 지워졌고 이력은 1건이다.
    expect(output()["pending_published_faq_correction"]).toBeUndefined()
    expect(output()["published_faq_corrections"]).toHaveLength(1)

    failReadWhen = null
    writes.length = 0
    expect(await correct({ taskId: "faq-fix-2" })).toEqual({ kind: "corrected", contentHash: NEXT_HASH, resumed: true, path: "/places/area-seoul-test" })
    expect(writes).toEqual([])
    expect(output()["published_faq_corrections"]).toHaveLength(1)
  })

  describe("완료 재확인은 기록과 지금 상태가 모두 맞을 때만", () => {
    const completeThen = async (mutate: () => void): Promise<unknown> => {
      await correct()
      writes.length = 0
      mutate()
      return correct({ taskId: "faq-fix-2" })
    }

    it.each([
      ["다른 답을 요청", () => undefined, { answer: "예식장에 직접 확인해 주세요." }],
      ["다른 보정 전 해시를 요청", () => undefined, { expectedContentHash: "0".repeat(64) }],
    ])("%s → 완료로 보지 않는다", async (_label, mutate, overrides) => {
      await correct()
      writes.length = 0
      mutate()
      expect(await correct({ taskId: "faq-fix-2", ...overrides })).toEqual({ kind: "blocked", reason: "content-changed" })
      expect(writes).toEqual([])
    })

    it.each([
      ["장소가 그 뒤 다시 바뀜", () => (place()["description"] = "그 뒤 바뀐 본문")],
      ["생성 기록의 현행 콘텐츠가 다름", () => (output()["generated"] = { ...NEXT, description: "다른 본문" })],
      ["SEO 수정 시각이 기록과 다름", () => (seo()["last_modified_at"] = "2026-11-11T00:00:00.000Z")],
      ["SEO 수정 시각이 해석되지 않음", () => (seo()["last_modified_at"] = "not a time")],
      ["SEO 경로가 기록과 다름", () => (seo()["path"] = "/places/other")],
      ["게시 시각이 기록과 다름", () => (seo()["published_at"] = "2026-11-11T00:00:00.000Z")],
      // 밀리초까지는 같고 마이크로초만 다른 게시 시각 — 다른 게시 기록이다.
      ["게시 시각이 마이크로초만 다름", () => (seo()["published_at"] = "2026-11-10T08:33:00.123999+00:00")],
      ["같은 이력이 두 건", () => (output()["published_faq_corrections"] as Row[]).push(structuredClone((output()["published_faq_corrections"] as Row[])[0] ?? {}))],
      ["이력이 없음", () => (output()["published_faq_corrections"] = [])],
    ])("%s → 완료로 보지 않는다", async (_label, mutate) => {
      expect(await completeThen(mutate)).toEqual({ kind: "blocked", reason: "content-changed" })
      expect(writes).toEqual([])
    })
  })

  describe("해석되지 않는 의도 기록", () => {
    it.each([
      ["형식이 어긋난 값", { correction_id: "broken" }],
      ["JSON null", null],
      ["문자열", "pending"],
    ])("새 보정을 시작하지 않는다: %s", async (_label, value) => {
      output()["pending_published_faq_correction"] = value
      expect(await correct()).toEqual({ kind: "blocked", reason: "corrupt-intent" })
      expect(writes).toEqual([])
      expect(place()["faq"]).toEqual(content.faq)
    })

    it("완료 이력이 있어도, 손상된 의도가 남아 있으면 완료로 답하지 않는다", async () => {
      await correct()
      writes.length = 0
      output()["pending_published_faq_correction"] = { correction_id: "broken" }

      expect(await correct({ taskId: "faq-fix-2" })).toEqual({ kind: "blocked", reason: "corrupt-intent" })
      expect(writes).toEqual([])
      // 손상된 값은 그대로 남아 사람이 확인한다.
      expect(output()["pending_published_faq_correction"]).toEqual({ correction_id: "broken" })
    })

    it("ops_task는 이 경우 stopped로 끝나고 게시 금지를 내리지 않는다", async () => {
      output()["pending_published_faq_correction"] = { correction_id: "broken" }
      tables["settings"] = [{ key: "ops_task", value: { id: "faq-fix-1", expiresAt: "2026-11-11T00:00:00.000Z", actor: "ops:faq-fix", inheritFreezeFrom: null, steps: [STEP] }, updated_at: "t0" }]
      const { runOpsTask } = await import("@/lib/batch/ops-task-service")

      expect(await runOpsTask({ nowIso: "2026-11-10T09:00:00.000Z" })).toMatchObject({ kind: "finished", status: "stopped", results: [{ ok: false, outcome: "blocked", detail: "corrupt-intent" }] })
      expect(holdLog).toEqual(["freeze", "lock", "unlock"])
    })
  })

  it("이어 하기는 기록된 대상(SEO 페이지·경로·게시 시각)이 지금 대상과 같을 때만", async () => {
    failWriteWhen = (table) => table === "seo_pages"
    await correct()
    failWriteWhen = null
    writes.length = 0
    seo()["path"] = "/places/other"
    expect(await correct({ taskId: "faq-fix-2" })).toEqual({ kind: "blocked", reason: "content-changed" })
    expect(writes).toEqual([])
  })
})

describe("ops_task 연결", () => {
  const TASK = { id: "faq-fix-1", expiresAt: "2026-11-11T00:00:00.000Z", actor: "ops:faq-fix", inheritFreezeFrom: null, steps: [STEP] }
  const run = async () => {
    const { runOpsTask } = await import("@/lib/batch/ops-task-service")
    return runOpsTask({ nowIso: "2026-11-10T09:00:00.000Z" })
  }
  const resultRow = (): Row => (tables["settings"]?.find((row) => row["key"] === "ops_task_result:faq-fix-1")?.["value"] ?? {}) as Row

  it("freeze → lock → 보정 → unfreeze → unlock, 결과는 done", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc1234def5678")
    tables["settings"] = [{ key: "ops_task", value: TASK, updated_at: "t0" }]
    const outcome = await run()

    expect(outcome).toMatchObject({ kind: "finished", status: "done", results: [{ index: 0, kind: "correct-published-faq", ok: true, outcome: "corrected" }] })
    expect(holdLog).toEqual(["freeze", "lock", "unfreeze", "unlock"])
    expect(place()["faq"]).toEqual(NEXT.faq)
    expect(resultRow()["status"]).toBe("done")
    // 실행한 배포의 커밋을 결과에 남긴다.
    expect(resultRow()["runtime_sha"]).toBe("abc1234")
    // Production이 처리할 캐시 갱신 요청을 남긴다.
    expect((tables["settings"] ?? []).find((row) => row["key"] === "revalidate-request:faq-fix-1-0")?.["value"]).toMatchObject({ path: "/places/area-seoul-test", by: "ops:faq-fix" })
    expect(outcome).toMatchObject({ results: [{ detail: expect.stringContaining("/places/area-seoul-test revalidate-requested") as unknown }] })
  })

  it("보정이 막히면 stopped로 끝나고 게시 금지를 내리지 않는다", async () => {
    place()["description"] = "누가 본문을 바꿨다"
    tables["settings"] = [{ key: "ops_task", value: TASK, updated_at: "t0" }]
    const outcome = await run()

    expect(outcome).toMatchObject({ kind: "finished", status: "stopped", results: [{ ok: false, outcome: "blocked", detail: "content-changed" }] })
    expect(holdLog).toEqual(["freeze", "lock", "unlock"])
  })

  it("완료 결과를 저장하지 못하면 게시 금지를 내리지 않는다", async () => {
    tables["settings"] = [{ key: "ops_task", value: TASK, updated_at: "t0" }]
    failWriteWhen = (table, patch) => table === "settings" && (patch["value"] as Row | undefined)?.["status"] === "done"
    const outcome = await run()

    expect(outcome).toMatchObject({ kind: "finished", status: "stopped" })
    expect(holdLog).toEqual(["freeze", "lock", "unlock"])
    expect(resultRow()["status"]).toBe("running")
    // 보정 자체는 끝났다 — 사람이 결과 행을 확인하고 정리한다.
    expect(place()["faq"]).toEqual(NEXT.faq)
  })
})
