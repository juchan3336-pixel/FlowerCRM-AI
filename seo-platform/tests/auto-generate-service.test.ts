// 자동 생성 캠페인 실행 계약 — allowlist 밖 장소를 승인하지 않고, 조회가 불확실하면 승인하지 않으며,
// 판정·승인 준비·활성화는 기존 경로(prepareApproval·executeActivate)만 쓴다.
// 승인 행을 만든 뒤의 실패(예외·중간 종료·순서 뒤집힘)가 전역 승인 슬롯을 영구 점유하지 않는지도 여기서 고정한다.
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

// ── Supabase 대역 ────────────────────────────────────────────────
// 체이닝을 기록만 하고, await 시점에 테이블별 resolver가 결과를 만든다.
type Query = { table: string; filters: { op: string; column: string; value: unknown }[]; range: readonly [number, number] | null }
type QueryResult = { data: unknown; error: { message: string } | null }
let resolveQuery: (query: Query) => QueryResult

function builder(table: string) {
  const query: Query = { table, filters: [], range: null }
  const api = {
    select: () => api,
    order: () => api,
    eq: (column: string, value: unknown) => {
      query.filters.push({ op: "eq", column, value })
      return api
    },
    in: (column: string, value: unknown) => {
      query.filters.push({ op: "in", column, value })
      return api
    },
    range: (from: number, to: number) => {
      query.range = [from, to]
      return api
    },
    then: (onFulfilled: (value: QueryResult) => unknown, onRejected?: (reason: unknown) => unknown) => Promise.resolve(resolveQuery(query)).then(onFulfilled, onRejected),
  }
  return api
}
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceRoleClient: () => ({ from: (table: string) => builder(table) }) }))

// ── 기존 경로 대역 ───────────────────────────────────────────────
type PrepareInput = { placeIds: readonly string[]; approvedBy: string; maxCostUsd: number; nowIso: string }
const prepareApproval = vi.fn<(input: PrepareInput) => Promise<unknown>>()
vi.mock("@/lib/batch/approval-request-service", () => ({ prepareApproval: (input: PrepareInput) => prepareApproval(input) }))
type ActivateInput = { activationToken: string; nowIso: string; previewDeploymentSha: string | null }
const executeActivate = vi.fn<(input: ActivateInput) => Promise<unknown>>()
vi.mock("@/lib/batch/approval-execution-service", () => ({ executeActivate: (input: ActivateInput) => executeActivate(input) }))
type Failure = { code: string; message: string }
const cancelUnactivatedApproval = vi.fn<(id: string, failure: Failure) => Promise<unknown>>()
const cancelApprovalWithError = vi.fn<(id: string, failure: Failure) => Promise<unknown>>()
vi.mock("@/lib/batch/supabase-approval-repository", () => ({
  createSupabaseApprovalRepository: () => ({
    cancelUnactivatedApproval: (id: string, failure: Failure) => cancelUnactivatedApproval(id, failure),
    cancelApprovalWithError: (id: string, failure: Failure) => cancelApprovalWithError(id, failure),
  }),
}))
const cancelGenerationBatch = vi.fn<(batchId: string, actor: string | null) => Promise<void>>()
vi.mock("@/lib/batch/generation-batch-service", () => ({ cancelGenerationBatch: (batchId: string, actor: string | null) => cancelGenerationBatch(batchId, actor) }))

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const approvalId = (n: number): string => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`
const NOW = "2026-11-10T06:00:00.000Z"
const TOKEN = "activation-token-plaintext"
const APPROVER = "auto-generate:pilot-1"
const NEW_APPROVAL = approvalId(100)

type PlaceFixture = { id: string; name: string; status: string; slug: string | null; category: string; official_verification_status: string | null; exclusion_reason: string | null; verification_source_urls: unknown }
function place(n: number, overrides: Partial<PlaceFixture> = {}): PlaceFixture {
  return {
    id: id(n),
    name: `테스트병원 장례식장 ${String(n)}`,
    status: "draft",
    slug: `place-${String(n)}`,
    category: "funeral",
    official_verification_status: "verified",
    exclusion_reason: null,
    verification_source_urls: ["https://example.com/"],
    ...overrides,
  }
}

type ApprovalFixture = {
  id: string
  status: string
  approved_by: string
  approved_at: string
  approved_place_ids: string[]
  activation_consumed_at: string | null
  batch_run_id: string | null
  approved_max_cost_usd: number
}
function approvalRow(n: number, overrides: Partial<ApprovalFixture> = {}): ApprovalFixture {
  return {
    id: approvalId(n),
    status: "completed",
    approved_by: APPROVER,
    approved_at: "2026-11-09T01:00:00.000Z",
    approved_place_ids: [id(1)],
    activation_consumed_at: "2026-11-09T01:00:05.000Z",
    batch_run_id: `run-${String(n)}`,
    approved_max_cost_usd: 0.04,
    ...overrides,
  }
}

type ItemFixture = { batch_id: string; status: string; cost_usd: number | null; generation_id: string | null; retry_generation_id?: string | null }
type World = {
  autoGenerate: unknown
  campaign: unknown
  approvals: ApprovalFixture[]
  items: ItemFixture[]
  places: PlaceFixture[]
  generations: string[]
  // 생성 기록 id → output (추정 비용은 output.estimated_cost)
  generationOutputs: Record<string, unknown>
  seoPagePlaceIds: string[]
  failTable: string | null
}
let world: World

function campaignJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "pilot-1",
    expiresAt: "2026-12-10T00:00:00.000Z",
    batchSize: 20,
    dailyLimit: 100,
    totalLimit: 969,
    allowPlaceIds: world.places.map((entry) => entry.id),
    requireReviewEachBatch: false,
    maxNeedsReviewRatio: 0.1,
    acknowledgedApprovalIds: [],
    ...overrides,
  }
}

function okItems(batchId: string, count = 1): ItemFixture[] {
  return Array.from({ length: count }, () => ({ batch_id: batchId, status: "ready", cost_usd: 0.0009, generation_id: "gen" }))
}

// 실제 prepareApproval처럼 승인 행을 만들어 전역 슬롯을 쥔다.
function insertNewApproval(input: PrepareInput): { kind: "created"; approval: { id: string }; activationToken: string } {
  world.approvals.push(
    approvalRow(100, { id: NEW_APPROVAL, status: "approved", approved_by: input.approvedBy, approved_at: input.nowIso, approved_place_ids: [...input.placeIds], activation_consumed_at: null, batch_run_id: null }),
  )
  return { kind: "created", approval: { id: NEW_APPROVAL }, activationToken: TOKEN }
}

function filterValue(query: Query, op: string, column: string): unknown {
  return query.filters.find((entry) => entry.op === op && entry.column === column)?.value
}
function inValues(query: Query, column: string): readonly unknown[] {
  const value = filterValue(query, "in", column)
  return Array.isArray(value) ? (value as readonly unknown[]) : []
}

beforeEach(() => {
  world = { autoGenerate: "on", campaign: null, approvals: [], items: [], places: [place(1), place(2), place(3)], generations: [], generationOutputs: { gen: { estimated_cost: 0.0009 } }, seoPagePlaceIds: [], failTable: null }
  world.campaign = campaignJson()
  resolveQuery = (query) => {
    if (world.failTable === query.table) {
      return { data: null, error: { message: "db unavailable" } }
    }
    switch (query.table) {
      case "settings":
        return {
          data: [
            { key: "auto_generate", value: world.autoGenerate },
            { key: "auto_generate_campaign", value: world.campaign },
          ],
          error: null,
        }
      case "batch_approvals": {
        const statuses = inValues(query, "status")
        if (statuses.length > 0) {
          return { data: world.approvals.filter((row) => statuses.includes(row.status)), error: null }
        }
        const approver = filterValue(query, "eq", "approved_by")
        const rows = world.approvals.filter((row) => row.approved_by === approver).sort((left, right) => left.approved_at.localeCompare(right.approved_at))
        const [from, to] = query.range ?? [0, rows.length]
        return { data: rows.slice(from, to + 1), error: null }
      }
      case "batch_run_items":
        return { data: world.items.filter((item) => item.batch_id === filterValue(query, "eq", "batch_id")), error: null }
      case "places": {
        const ids = inValues(query, "id")
        const slugs = inValues(query, "slug")
        return { data: world.places.filter((entry) => (ids.length > 0 ? ids.includes(entry.id) : slugs.includes(entry.slug))), error: null }
      }
      case "ai_generations": {
        const generationIds = inValues(query, "id")
        if (generationIds.length > 0) {
          return { data: generationIds.filter((key) => typeof key === "string" && key in world.generationOutputs).map((key) => ({ id: key, output: world.generationOutputs[key as string] })), error: null }
        }
        return { data: world.generations.filter((placeId) => inValues(query, "place_id").includes(placeId)).map((placeId) => ({ place_id: placeId })), error: null }
      }
      case "seo_pages": {
        if (inValues(query, "path").length > 0) {
          return { data: [], error: null }
        }
        return { data: world.seoPagePlaceIds.filter((placeId) => inValues(query, "place_id").includes(placeId)).map((placeId) => ({ place_id: placeId })), error: null }
      }
      default:
        throw new Error(`unexpected table ${query.table}`)
    }
  }
  prepareApproval.mockReset()
  prepareApproval.mockImplementation((input) => Promise.resolve(insertNewApproval(input)))
  executeActivate.mockReset()
  executeActivate.mockResolvedValue({ outcome: { kind: "accepted", approvalStatus: "running" } })
  cancelUnactivatedApproval.mockReset()
  // 실제 조건부 UPDATE처럼: 미활성(approved/queued·미소진·미연결)일 때만 닫는다.
  cancelUnactivatedApproval.mockImplementation((targetId) => {
    const row = world.approvals.find((entry) => entry.id === targetId)
    if (row === undefined || !["approved", "queued"].includes(row.status) || row.activation_consumed_at !== null || row.batch_run_id !== null) {
      return Promise.resolve(null)
    }
    row.status = "cancelled"
    return Promise.resolve(row)
  })
  cancelApprovalWithError.mockReset()
  cancelApprovalWithError.mockResolvedValue(null)
  cancelGenerationBatch.mockReset()
  cancelGenerationBatch.mockResolvedValue(undefined)
})

async function run(clock?: () => number) {
  const { runAutoGenerateStep } = await import("@/lib/batch/auto-generate-service")
  return runAutoGenerateStep({ nowIso: NOW, previewDeploymentSha: "abc123", ...(clock === undefined ? {} : { clock }) })
}
const preparedPlaceIds = (): readonly string[] | undefined => prepareApproval.mock.calls[0]?.[0].placeIds
const newApprovalStatus = (): string | undefined => world.approvals.find((row) => row.id === NEW_APPROVAL)?.status

describe("꺼져 있거나 설정이 없을 때", () => {
  it.each(["off", "cancel", undefined])("스위치가 %s면 승인하지 않는다", async (value) => {
    world.autoGenerate = value
    expect(await run()).toEqual({ kind: "skipped", reason: "disabled" })
    expect(prepareApproval).not.toHaveBeenCalled()
  })

  it("캠페인 설정이 어긋나면 승인하지 않는다", async () => {
    world.campaign = campaignJson({ batchSize: 500 })
    expect(await run()).toEqual({ kind: "skipped", reason: "no-campaign" })
    expect(prepareApproval).not.toHaveBeenCalled()
  })

  it("안전 설정을 빠뜨린 캠페인은 승인하지 않는다", async () => {
    world.campaign = campaignJson({ maxNeedsReviewRatio: undefined })
    expect(await run()).toEqual({ kind: "skipped", reason: "no-campaign" })
  })
})

describe("정상 진행", () => {
  it("allowlist의 적격 장소로 승인을 만들고 같은 배포에서 바로 활성화한다", async () => {
    expect(await run()).toEqual({ kind: "started", approvalId: NEW_APPROVAL, placeCount: 3 })

    const prepared = prepareApproval.mock.calls[0]?.[0]
    expect(prepared?.placeIds).toEqual([id(1), id(2), id(3)])
    // 사용자 이메일을 가장하지 않는다 — 캠페인 표식으로 남는다.
    expect(prepared?.approvedBy).toBe(APPROVER)
    expect(prepared?.maxCostUsd).toBeGreaterThan(0)
    expect(executeActivate).toHaveBeenCalledWith({ activationToken: TOKEN, nowIso: NOW, previewDeploymentSha: "abc123" })
    expect(cancelUnactivatedApproval).not.toHaveBeenCalled()
  })

  it("결과에 Activation token 원문을 싣지 않는다", async () => {
    expect(JSON.stringify(await run())).not.toContain(TOKEN)
  })

  it("batchSize만큼만 승인한다", async () => {
    world.places = Array.from({ length: 30 }, (_, index) => place(index + 1))
    world.campaign = campaignJson({ batchSize: 20 })
    await run()
    expect(preparedPlaceIds()).toHaveLength(20)
  })

  it("allowlist 밖의 verified 장소는 절대 승인하지 않는다", async () => {
    world.campaign = campaignJson({ allowPlaceIds: [id(2)] })
    await run()
    expect(preparedPlaceIds()).toEqual([id(2)])
  })

  it("이전 캠페인 승인에 들어갔던 장소는 건너뛴다", async () => {
    world.approvals = [approvalRow(1, { approved_place_ids: [id(1)] })]
    world.items = okItems("run-1")
    await run()
    expect(preparedPlaceIds()).toEqual([id(2), id(3)])
  })
})

describe("부적격 장소 걸러내기 — 관리자 후보 화면과 같은 판정", () => {
  it("제외·미확인·게시됨·생성 이력·SEO 페이지 보유 장소는 빠진다", async () => {
    world.places = [
      place(1, { official_verification_status: "excluded", exclusion_reason: "memorial-facility" }),
      place(2, { official_verification_status: null }),
      place(3, { status: "published" }),
      place(4),
      place(5),
      place(6),
    ]
    world.campaign = campaignJson()
    world.generations = [id(4)]
    world.seoPagePlaceIds = [id(5)]
    await run()
    expect(preparedPlaceIds()).toEqual([id(6)])
  })

  it("빈소 없는 안치 전용 시설 명칭은 allowlist에 있어도 빠진다", async () => {
    world.places = [place(1, { name: "하늘추모공원" }), place(2, { name: "재단법인 송파공원" }), place(3)]
    world.campaign = campaignJson()
    await run()
    expect(preparedPlaceIds()).toEqual([id(3)])
  })

  it("남은 장소가 전부 부적격이면 승인을 만들지 않는다", async () => {
    world.places = [place(1, { official_verification_status: "excluded" })]
    world.campaign = campaignJson()
    expect(await run()).toEqual({ kind: "skipped", reason: "no-eligible" })
    expect(prepareApproval).not.toHaveBeenCalled()
  })
})

describe("멈춤 조건", () => {
  it("관리자 승인이 진행 중이면 기다린다", async () => {
    world.approvals = [approvalRow(1, { status: "running", approved_by: "admin@example.com", approved_at: "2026-11-10T05:59:00.000Z" })]
    expect(await run()).toEqual({ kind: "skipped", reason: "busy" })
    expect(prepareApproval).not.toHaveBeenCalled()
  })

  it("직전 캠페인 승인이 실패했으면 멈춘다", async () => {
    world.approvals = [approvalRow(1, { status: "failed", batch_run_id: null })]
    expect(await run()).toEqual({ kind: "skipped", reason: "halted-approval-failed" })
    expect(prepareApproval).not.toHaveBeenCalled()
  })

  // 배치는 item 결과와 무관하게 completed로 닫힌다 — 승인 상태만 보면 전부 실패한 배치 뒤에도 다음 20곳을 승인한다.
  it.each([
    ["전부 실패", { status: "failed", cost_usd: 0, generation_id: null }, "halted-items-failed"],
    ["전부 검수 대기", { status: "needs_review", cost_usd: 0.0009, generation_id: "gen" }, "halted-needs-review-ratio"],
    ["비용 상한으로 건너뜀", { status: "skipped", cost_usd: null, generation_id: null }, "halted-items-skipped"],
    ["비용 미기록", { status: "ready", cost_usd: null, generation_id: "gen" }, "halted-cost-unknown"],
  ])("직전 배치가 completed여도 item이 %s이면 멈춘다", async (_label, item, reason) => {
    world.approvals = [approvalRow(1)]
    world.items = Array.from({ length: 20 }, () => ({ batch_id: "run-1", ...item }))
    expect(await run()).toEqual({ kind: "skipped", reason })
    expect(prepareApproval).not.toHaveBeenCalled()
  })

  // item.cost_usd는 계산 못 한 비용도 0으로 저장된다 — 생성 기록의 추정 비용을 직접 봐야 "모름"이 드러난다.
  it("생성 기록에 추정 비용이 없으면 item 비용이 0으로 저장돼 있어도 비용 미상으로 멈춘다", async () => {
    world.approvals = [approvalRow(1)]
    world.items = [{ batch_id: "run-1", status: "ready", cost_usd: 0, generation_id: "gen-nocost" }]
    world.generationOutputs = { "gen-nocost": { estimated_cost: null } }
    expect(await run()).toEqual({ kind: "skipped", reason: "halted-cost-unknown" })
  })

  it("재시도 생성의 비용만 없어도 비용 미상이다", async () => {
    world.approvals = [approvalRow(1)]
    world.items = [{ batch_id: "run-1", status: "ready", cost_usd: 0.0009, generation_id: "gen", retry_generation_id: "gen-retry" }]
    world.generationOutputs = { gen: { estimated_cost: 0.0009 }, "gen-retry": {} }
    expect(await run()).toEqual({ kind: "skipped", reason: "halted-cost-unknown" })
  })

  it("생성 기록 자체를 찾지 못해도 비용 미상이다", async () => {
    world.approvals = [approvalRow(1)]
    world.items = [{ batch_id: "run-1", status: "ready", cost_usd: 0.0009, generation_id: "gen-missing" }]
    expect(await run()).toEqual({ kind: "skipped", reason: "halted-cost-unknown" })
  })

  it("직전 배치 결과를 읽지 못하면 멈춘다", async () => {
    world.approvals = [approvalRow(1)]
    world.failTable = "batch_run_items"
    expect(await run()).toEqual({ kind: "skipped", reason: "halted-run-unknown" })
  })

  it("파일럿은 정상 완료여도 확인 전까지 멈추고, 확인 목록에 오르면 진행한다", async () => {
    world.approvals = [approvalRow(1)]
    world.items = okItems("run-1")
    world.campaign = campaignJson({ requireReviewEachBatch: true })
    expect(await run()).toEqual({ kind: "skipped", reason: "halted-awaiting-review" })

    world.campaign = campaignJson({ requireReviewEachBatch: true, acknowledgedApprovalIds: [approvalId(1)] })
    expect(await run()).toMatchObject({ kind: "started" })
  })

  it("하루 한도에 닿으면 멈춘다", async () => {
    world.campaign = campaignJson({ dailyLimit: 1 })
    world.approvals = [approvalRow(1, { approved_at: "2026-11-10T01:00:00.000Z" })]
    world.items = okItems("run-1")
    expect(await run()).toEqual({ kind: "skipped", reason: "daily-limit" })
  })

  it.each(["settings", "batch_approvals", "places", "ai_generations", "seo_pages"])("%s 조회가 실패하면 승인하지 않고 던진다", async (table) => {
    world.failTable = table
    await expect(run()).rejects.toThrow()
    expect(prepareApproval).not.toHaveBeenCalled()
  })

  it("다른 요청이 먼저 승인을 만들었으면 양보한다", async () => {
    prepareApproval.mockResolvedValue({ kind: "already-active" })
    expect(await run()).toEqual({ kind: "skipped", reason: "busy" })
    expect(executeActivate).not.toHaveBeenCalled()
  })

  it("승인 판정에서 막히면 활성화하지 않는다", async () => {
    prepareApproval.mockResolvedValue({ kind: "blocked", reason: "has-generation" })
    expect(await run()).toEqual({ kind: "skipped", reason: "blocked-has-generation" })
    expect(executeActivate).not.toHaveBeenCalled()
  })

  it("후보 탐색에 시간 예산을 다 쓰면 승인 행을 만들기 전에 물러난다", async () => {
    let now = 0
    const clock = (): number => {
      now += 12_000
      return now
    }
    expect(await run(clock)).toEqual({ kind: "skipped", reason: "slow-step" })
    expect(prepareApproval).not.toHaveBeenCalled()
  })
})

describe("이력 전체 읽기", () => {
  it("응답 한 쪽을 넘는 이력도 끝까지 읽어 전체 한도를 지킨다", async () => {
    // 1건짜리 승인 1,200개 — 첫 쪽(500행)만 읽으면 총량에 여유가 있다고 오판한다.
    world.places = [place(5000)]
    world.approvals = Array.from({ length: 1200 }, (_, index) =>
      approvalRow(index + 1, { approved_at: new Date(Date.parse("2026-10-01T00:00:00.000Z") + index * 60_000).toISOString(), approved_place_ids: [id(index + 1)] }),
    )
    world.items = okItems("run-1200")
    world.campaign = campaignJson({ batchSize: 1, totalLimit: 1200, allowPlaceIds: [id(5000)] })

    expect(await run()).toEqual({ kind: "skipped", reason: "total-limit" })
    expect(prepareApproval).not.toHaveBeenCalled()
  })
})

describe("승인 행을 만든 뒤의 재검증 — 오래된 집계로 한도를 넘기지 않는다", () => {
  // 느린 요청 X가 이력을 읽은 뒤, 빠른 요청 Y가 승인→완료까지 끝낸 경우.
  // unique index는 Y가 종료 상태라 X의 INSERT를 허용한다 — 슬롯을 쥔 뒤 원장을 다시 읽어야만 걸린다.
  it("처음 읽은 뒤 다른 승인이 생기고 끝났으면 자기 승인을 닫고 활성화하지 않는다", async () => {
    world.campaign = campaignJson({ batchSize: 1, dailyLimit: 1 })
    prepareApproval.mockImplementation((input) => {
      world.approvals.push(approvalRow(50, { approved_at: "2026-11-10T05:59:00.000Z", approved_place_ids: [id(1)], batch_run_id: "run-50" }))
      world.items = okItems("run-50")
      return Promise.resolve(insertNewApproval(input))
    })

    expect(await run()).toEqual({ kind: "activation-rejected", approvalId: NEW_APPROVAL, reason: "recheck-daily-limit" })
    expect(executeActivate).not.toHaveBeenCalled()
    expect(newApprovalStatus()).toBe("cancelled")
  })

  it("승인 준비 중에 스위치가 꺼졌으면 활성화하지 않는다", async () => {
    prepareApproval.mockImplementation((input) => {
      world.autoGenerate = "off"
      return Promise.resolve(insertNewApproval(input))
    })

    expect(await run()).toEqual({ kind: "activation-rejected", approvalId: NEW_APPROVAL, reason: "recheck-disabled" })
    expect(executeActivate).not.toHaveBeenCalled()
    expect(newApprovalStatus()).toBe("cancelled")
  })

  it("승인 준비 중에 장소가 allowlist에서 빠졌으면 활성화하지 않는다", async () => {
    prepareApproval.mockImplementation((input) => {
      world.campaign = campaignJson({ allowPlaceIds: [id(1), id(2)] })
      return Promise.resolve(insertNewApproval(input))
    })

    expect(await run()).toMatchObject({ kind: "activation-rejected", reason: "recheck-ready" })
    expect(executeActivate).not.toHaveBeenCalled()
    expect(newApprovalStatus()).toBe("cancelled")
  })
})

describe("활성화 실패 — 전역 승인 슬롯을 영구 점유하지 않는다", () => {
  it("활성화가 거부되면 실행 흔적 없는 승인을 조건부로 닫는다", async () => {
    executeActivate.mockResolvedValue({ outcome: { kind: "unauthorized", reason: "invalid-token" } })

    expect(await run()).toEqual({ kind: "activation-rejected", approvalId: NEW_APPROVAL, reason: "invalid-token" })
    expect(cancelUnactivatedApproval).toHaveBeenCalledWith(NEW_APPROVAL, { code: "auto-activate-failed", message: "auto-activate-failed:invalid-token" })
    // running까지 닫을 수 있는 무조건 취소는 쓰지 않는다.
    expect(cancelApprovalWithError).not.toHaveBeenCalled()
  })

  it("활성화가 예외로 죽어도(승인 INSERT 직후 DB timeout) 승인을 approved로 남기지 않는다", async () => {
    executeActivate.mockRejectedValue(new Error("db timeout"))

    expect(await run()).toEqual({ kind: "activation-rejected", approvalId: NEW_APPROVAL, reason: "threw" })
    expect(newApprovalStatus()).toBe("cancelled")
  })

  it("running 전이 뒤에 예외가 나면 그 승인을 취소하지 않는다 (실행 흔적 보존)", async () => {
    executeActivate.mockImplementation(() => {
      const row = world.approvals.find((entry) => entry.id === NEW_APPROVAL)
      if (row !== undefined) {
        row.status = "running"
        row.activation_consumed_at = NOW
      }
      return Promise.reject(new Error("link failed"))
    })

    expect(await run()).toEqual({ kind: "activation-rejected", approvalId: NEW_APPROVAL, reason: "threw" })
    expect(newApprovalStatus()).toBe("running")
    expect(cancelApprovalWithError).not.toHaveBeenCalled()
  })

  it("정리 자체가 실패해도 던지지 않는다 — 다음 걸음의 복구가 맡는다", async () => {
    executeActivate.mockRejectedValue(new Error("db timeout"))
    cancelUnactivatedApproval.mockRejectedValue(new Error("db unavailable"))

    expect(await run()).toEqual({ kind: "activation-rejected", approvalId: NEW_APPROVAL, reason: "threw" })
  })
})

describe("고아 승인 복구 — 함수가 중간에 죽은 다음 걸음", () => {
  const stale = "2026-11-10T05:50:00.000Z"
  const orphan = (overrides: Partial<ApprovalFixture> = {}): ApprovalFixture =>
    approvalRow(7, { status: "approved", approved_at: stale, activation_consumed_at: null, batch_run_id: null, ...overrides })

  it("토큰을 잃은 미활성 캠페인 승인을 닫는다", async () => {
    world.approvals = [orphan()]

    expect(await run()).toEqual({ kind: "recovered", approvalId: approvalId(7) })
    expect(world.approvals[0]?.status).toBe("cancelled")
    expect(prepareApproval).not.toHaveBeenCalled()
  })

  it("닫은 다음 걸음에서는 그 승인 때문에 멈춘다 (자동으로 새 승인을 이어 만들지 않는다)", async () => {
    world.approvals = [orphan()]
    await run()

    expect(await run()).toEqual({ kind: "skipped", reason: "halted-approval-cancelled" })
    expect(prepareApproval).not.toHaveBeenCalled()
  })

  it("닫으려는 순간 활성화가 끼어들었으면 건드리지 않는다", async () => {
    world.approvals = [orphan()]
    cancelUnactivatedApproval.mockResolvedValue(null)

    expect(await run()).toEqual({ kind: "skipped", reason: "busy" })
  })

  it("running인데 배치가 없는 승인은 닫지 않고 조사 대상으로 알린다", async () => {
    world.approvals = [orphan({ status: "running", activation_consumed_at: stale })]

    expect(await run()).toEqual({ kind: "stuck", approvalId: approvalId(7), reason: "running-without-batch" })
    expect(cancelUnactivatedApproval).not.toHaveBeenCalled()
    expect(cancelApprovalWithError).not.toHaveBeenCalled()
  })

  // 멈추려고 스위치를 끄거나 캠페인을 지운 바로 그때 고아가 슬롯을 쥐고 있으면 관리자 승인까지 막힌다.
  it.each([
    ["스위치 off", "off", true],
    ["스위치 cancel", "cancel", true],
    ["캠페인 설정 없음", "on", false],
    ["스위치 off + 캠페인 없음", "off", false],
  ])("%s 상태에서도 미활성 고아 승인을 닫는다", async (_label, mode, keepCampaign) => {
    world.autoGenerate = mode
    if (!keepCampaign) {
      world.campaign = null
    }
    world.approvals = [orphan({ status: "queued" })]

    expect(await run()).toEqual({ kind: "recovered", approvalId: approvalId(7) })
    expect(world.approvals[0]?.status).toBe("cancelled")
  })

  it.each(["off", "cancel"])("스위치 %s 상태에서도 배치 없는 running은 조사 대상으로 알린다", async (mode) => {
    world.autoGenerate = mode
    world.approvals = [orphan({ status: "running", activation_consumed_at: stale })]

    expect(await run()).toEqual({ kind: "stuck", approvalId: approvalId(7), reason: "running-without-batch" })
    expect(cancelUnactivatedApproval).not.toHaveBeenCalled()
  })

  it("관리자 승인은 오래 approved로 남아 있어도 건드리지 않는다", async () => {
    world.approvals = [orphan({ approved_by: "admin@example.com" })]

    expect(await run()).toEqual({ kind: "skipped", reason: "busy" })
    expect(cancelUnactivatedApproval).not.toHaveBeenCalled()
  })

  it("배치가 연결된 실행은 정상 진행으로 본다", async () => {
    world.approvals = [approvalRow(7, { status: "running", approved_at: stale })]
    expect(await run()).toEqual({ kind: "skipped", reason: "busy" })
    expect(cancelUnactivatedApproval).not.toHaveBeenCalled()
  })
})

describe("진행 중 캠페인 승인의 item 실행 허가", () => {
  const claimed = { approved_by: APPROVER, approved_place_ids: [id(1), id(2)] }
  async function gate() {
    const { decideClaimedAutoApproval } = await import("@/lib/batch/auto-generate-service")
    return decideClaimedAutoApproval(claimed, NOW)
  }

  it("현재 캠페인의 승인이고 대상이 유효하면 실행한다", async () => {
    expect(await gate()).toEqual({ kind: "run" })
  })

  it("스위치만 켜져 있고 캠페인 설정이 없으면 실행하지 않는다", async () => {
    world.campaign = null
    expect(await gate()).toEqual({ kind: "pause", reason: "no-campaign" })
  })

  it("다른 캠페인으로 교체됐으면 실행하지 않는다", async () => {
    world.campaign = campaignJson({ id: "wave-2" })
    expect(await gate()).toEqual({ kind: "pause", reason: "other-campaign" })
  })

  it("대상 장소가 allowlist에서 빠졌으면 실행하지 않는다", async () => {
    world.campaign = campaignJson({ allowPlaceIds: [id(1)] })
    expect(await gate()).toEqual({ kind: "pause", reason: "place-not-allowed" })
  })

  it("설정을 읽지 못하면 실행하지 않는다", async () => {
    world.failTable = "settings"
    expect(await gate()).toEqual({ kind: "pause", reason: "switch-off" })
  })

  it('스위치가 "cancel"이면 취소를 지시한다', async () => {
    world.autoGenerate = "cancel"
    expect(await gate()).toEqual({ kind: "cancel" })
  })
})

describe("명시적 취소 — 승인과 배치를 함께 닫는다", () => {
  it("배치를 먼저 닫고 승인을 닫는다 (승인만 닫으면 running 배치가 고아로 남는다)", async () => {
    const { cancelClaimedAutoApproval } = await import("@/lib/batch/auto-generate-service")
    const order: string[] = []
    cancelGenerationBatch.mockImplementation(() => {
      order.push("batch")
      return Promise.resolve()
    })
    cancelApprovalWithError.mockImplementation(() => {
      order.push("approval")
      return Promise.resolve(null)
    })

    await cancelClaimedAutoApproval({ id: approvalId(7), approved_by: APPROVER, batch_run_id: "run-7" })

    expect(order).toEqual(["batch", "approval"])
    expect(cancelGenerationBatch).toHaveBeenCalledWith("run-7", APPROVER)
    expect(cancelApprovalWithError).toHaveBeenCalledWith(approvalId(7), { code: "auto-cancelled", message: "auto-cancelled:switch" })
  })

  it("배치 취소가 실패하면 승인을 닫지 않는다", async () => {
    const { cancelClaimedAutoApproval } = await import("@/lib/batch/auto-generate-service")
    cancelGenerationBatch.mockRejectedValue(new Error("db unavailable"))

    await expect(cancelClaimedAutoApproval({ id: approvalId(7), approved_by: APPROVER, batch_run_id: "run-7" })).rejects.toThrow()
    expect(cancelApprovalWithError).not.toHaveBeenCalled()
  })
})
