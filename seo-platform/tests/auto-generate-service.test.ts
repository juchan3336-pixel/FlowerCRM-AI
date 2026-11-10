// 자동 생성 캠페인 실행 계약 — allowlist 밖 장소를 승인하지 않고, 조회가 불확실하면 승인하지 않으며,
// 판정·승인 준비·활성화는 기존 경로(prepareApproval·executeActivate)만 쓴다.
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

// ── Supabase 대역 ────────────────────────────────────────────────
// 체이닝을 기록만 하고, await 시점에 테이블별 resolver가 결과를 만든다.
type Query = { table: string; filters: { op: string; column: string; value: unknown }[]; head: boolean }
type QueryResult = { data: unknown; error: { message: string } | null; count?: number | null }
let resolveQuery: (query: Query) => QueryResult

function builder(table: string) {
  const query: Query = { table, filters: [], head: false }
  const api = {
    select: (_columns?: string, options?: { head?: boolean }) => {
      query.head = options?.head === true
      return api
    },
    eq: (column: string, value: unknown) => {
      query.filters.push({ op: "eq", column, value })
      return api
    },
    in: (column: string, value: unknown) => {
      query.filters.push({ op: "in", column, value })
      return api
    },
    maybeSingle: () => {
      const result = resolveQuery(query)
      const rows: readonly unknown[] = Array.isArray(result.data) ? (result.data as readonly unknown[]) : []
      return Promise.resolve({ data: rows[0] ?? null, error: result.error })
    },
    then: (onFulfilled: (value: QueryResult) => unknown, onRejected?: (reason: unknown) => unknown) => Promise.resolve(resolveQuery(query)).then(onFulfilled, onRejected),
  }
  return api
}
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceRoleClient: () => ({ from: (table: string) => builder(table) }) }))

// ── 기존 경로 대역 ───────────────────────────────────────────────
const prepareApproval = vi.fn<(input: { placeIds: readonly string[]; approvedBy: string; maxCostUsd: number; nowIso: string }) => Promise<unknown>>()
vi.mock("@/lib/batch/approval-request-service", () => ({ prepareApproval: (input: never) => prepareApproval(input) }))
const executeActivate = vi.fn<(input: { activationToken: string; nowIso: string; previewDeploymentSha: string | null }) => Promise<unknown>>()
vi.mock("@/lib/batch/approval-execution-service", () => ({ executeActivate: (input: never) => executeActivate(input) }))
const findApprovalById = vi.fn<(id: string) => Promise<unknown>>()
const cancelApprovalWithError = vi.fn<(id: string, failure: { code: string; message: string }) => Promise<unknown>>()
vi.mock("@/lib/batch/supabase-approval-repository", () => ({
  createSupabaseApprovalRepository: () => ({ findApprovalById: (id: string) => findApprovalById(id), cancelApprovalWithError: (id: string, failure: never) => cancelApprovalWithError(id, failure) }),
}))

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const NOW = "2026-11-10T06:00:00.000Z"
const TOKEN = "activation-token-plaintext"

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

type World = {
  autoGenerate: unknown
  campaign: unknown
  activeApprovals: number | null
  history: { status: string; approved_at: string; approved_place_ids: string[] }[]
  places: PlaceFixture[]
  generations: string[]
  seoPagePlaceIds: string[]
  failTable: string | null
}
let world: World

function campaignJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "pilot-1", expiresAt: "2026-12-10T00:00:00.000Z", batchSize: 20, dailyLimit: 100, totalLimit: 969, allowPlaceIds: world.places.map((entry) => entry.id), ...overrides }
}

function inValues(query: Query, column: string): readonly unknown[] {
  const filter = query.filters.find((entry) => entry.op === "in" && entry.column === column)
  return Array.isArray(filter?.value) ? filter.value : []
}

beforeEach(() => {
  world = { autoGenerate: "on", campaign: null, activeApprovals: 0, history: [], places: [place(1), place(2), place(3)], generations: [], seoPagePlaceIds: [], failTable: null }
  world.campaign = campaignJson()
  resolveQuery = (query) => {
    if (world.failTable === query.table) {
      return { data: null, error: { message: "db unavailable" }, count: null }
    }
    switch (query.table) {
      case "settings": {
        const rows = [
          { key: "auto_generate", value: world.autoGenerate },
          { key: "auto_generate_campaign", value: world.campaign },
        ]
        const eqKey = query.filters.find((entry) => entry.op === "eq" && entry.column === "key")?.value
        return { data: eqKey === undefined ? rows : rows.filter((row) => row.key === eqKey), error: null }
      }
      case "batch_approvals":
        return query.head ? { data: null, error: null, count: world.activeApprovals } : { data: world.history, error: null }
      case "places": {
        const ids = inValues(query, "id")
        const slugs = inValues(query, "slug")
        return { data: world.places.filter((entry) => (ids.length > 0 ? ids.includes(entry.id) : slugs.includes(entry.slug))), error: null }
      }
      case "ai_generations":
        return { data: world.generations.filter((placeId) => inValues(query, "place_id").includes(placeId)).map((placeId) => ({ place_id: placeId })), error: null }
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
  prepareApproval.mockResolvedValue({ kind: "created", approval: { id: "approval-1" }, activationToken: TOKEN })
  executeActivate.mockReset()
  executeActivate.mockResolvedValue({ outcome: { kind: "accepted", approvalStatus: "running" } })
  findApprovalById.mockReset()
  findApprovalById.mockResolvedValue({ id: "approval-1", status: "approved", activation_consumed_at: null, batch_run_id: null })
  cancelApprovalWithError.mockReset()
  cancelApprovalWithError.mockResolvedValue(null)
})

async function run() {
  const { runAutoGenerateStep } = await import("@/lib/batch/auto-generate-service")
  return runAutoGenerateStep({ nowIso: NOW, previewDeploymentSha: "abc123" })
}

describe("꺼져 있거나 설정이 없을 때", () => {
  it("스위치가 꺼져 있으면 승인 상태조차 읽지 않는다", async () => {
    world.autoGenerate = "off"
    expect(await run()).toEqual({ kind: "skipped", reason: "disabled" })
    expect(prepareApproval).not.toHaveBeenCalled()
  })

  it("스위치 행이 없으면 꺼짐이다", async () => {
    world.autoGenerate = undefined
    expect(await run()).toEqual({ kind: "skipped", reason: "disabled" })
  })

  it("캠페인 설정이 어긋나면 승인하지 않는다", async () => {
    world.campaign = campaignJson({ batchSize: 500 })
    expect(await run()).toEqual({ kind: "skipped", reason: "no-campaign" })
    expect(prepareApproval).not.toHaveBeenCalled()
  })

  it("isAutoGenerateEnabled는 조회 실패를 꺼짐으로 본다", async () => {
    const { isAutoGenerateEnabled } = await import("@/lib/batch/auto-generate-service")
    expect(await isAutoGenerateEnabled()).toBe(true)
    world.failTable = "settings"
    expect(await isAutoGenerateEnabled()).toBe(false)
  })
})

describe("정상 진행", () => {
  it("allowlist의 적격 장소로 승인을 만들고 같은 배포에서 바로 활성화한다", async () => {
    expect(await run()).toEqual({ kind: "started", approvalId: "approval-1", placeCount: 3 })

    const prepared = prepareApproval.mock.calls[0]?.[0]
    expect(prepared?.placeIds).toEqual([id(1), id(2), id(3)])
    // 사용자 이메일을 가장하지 않는다 — 캠페인 표식으로 남는다.
    expect(prepared?.approvedBy).toBe("auto-generate:pilot-1")
    expect(prepared?.maxCostUsd).toBeGreaterThan(0)
    expect(executeActivate).toHaveBeenCalledWith({ activationToken: TOKEN, nowIso: NOW, previewDeploymentSha: "abc123" })
  })

  it("결과에 Activation token 원문을 싣지 않는다", async () => {
    expect(JSON.stringify(await run())).not.toContain(TOKEN)
  })

  it("batchSize만큼만 승인한다", async () => {
    world.places = Array.from({ length: 30 }, (_, index) => place(index + 1))
    world.campaign = campaignJson({ batchSize: 20 })
    await run()
    expect(prepareApproval.mock.calls[0]?.[0].placeIds).toHaveLength(20)
  })

  it("allowlist 밖의 verified 장소는 절대 승인하지 않는다", async () => {
    world.campaign = campaignJson({ allowPlaceIds: [id(2)] })
    await run()
    expect(prepareApproval.mock.calls[0]?.[0].placeIds).toEqual([id(2)])
  })

  it("이전 캠페인 승인에 들어갔던 장소는 건너뛴다", async () => {
    world.history = [{ status: "completed", approved_at: "2026-11-09T01:00:00.000Z", approved_place_ids: [id(1)] }]
    await run()
    expect(prepareApproval.mock.calls[0]?.[0].placeIds).toEqual([id(2), id(3)])
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
    expect(prepareApproval.mock.calls[0]?.[0].placeIds).toEqual([id(6)])
  })

  it("빈소 없는 추모시설 명칭은 allowlist에 있어도 빠진다", async () => {
    world.places = [place(1, { name: "하늘추모공원" }), place(2)]
    world.campaign = campaignJson()
    await run()
    expect(prepareApproval.mock.calls[0]?.[0].placeIds).toEqual([id(2)])
  })

  it("남은 장소가 전부 부적격이면 승인을 만들지 않는다", async () => {
    world.places = [place(1, { official_verification_status: "excluded" })]
    world.campaign = campaignJson()
    expect(await run()).toEqual({ kind: "skipped", reason: "no-eligible" })
    expect(prepareApproval).not.toHaveBeenCalled()
  })
})

describe("멈춤 조건", () => {
  it("진행 중 승인이 있으면 기다린다", async () => {
    world.activeApprovals = 1
    expect(await run()).toEqual({ kind: "skipped", reason: "busy" })
    expect(prepareApproval).not.toHaveBeenCalled()
  })

  it("직전 캠페인 승인이 실패했으면 멈춘다", async () => {
    world.history = [{ status: "failed", approved_at: "2026-11-10T01:00:00.000Z", approved_place_ids: [id(1)] }]
    expect(await run()).toEqual({ kind: "skipped", reason: "halted-failed" })
    expect(prepareApproval).not.toHaveBeenCalled()
  })

  it("하루 한도에 닿으면 멈춘다", async () => {
    world.campaign = campaignJson({ dailyLimit: 1 })
    world.history = [{ status: "completed", approved_at: "2026-11-10T01:00:00.000Z", approved_place_ids: [id(1)] }]
    expect(await run()).toEqual({ kind: "skipped", reason: "daily-limit" })
  })

  it.each(["batch_approvals", "places", "ai_generations", "seo_pages"])("%s 조회가 실패하면 승인하지 않고 던진다", async (table) => {
    world.failTable = table
    await expect(run()).rejects.toThrow()
    expect(prepareApproval).not.toHaveBeenCalled()
  })

  it("진행 중 승인 수를 읽지 못하면(count 없음) 0건으로 보지 않고 던진다", async () => {
    world.activeApprovals = null
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
})

describe("활성화 거부", () => {
  it("실행 증거가 없는 승인은 취소로 닫고 사유를 남긴다", async () => {
    executeActivate.mockResolvedValue({ outcome: { kind: "unauthorized", reason: "invalid-token" } })

    expect(await run()).toEqual({ kind: "activation-rejected", approvalId: "approval-1", reason: "invalid-token" })
    expect(cancelApprovalWithError).toHaveBeenCalledWith("approval-1", { code: "auto-activate-failed", message: "auto-activate-failed:invalid-token" })
  })

  it("이미 실행이 연결된 승인은 건드리지 않는다", async () => {
    executeActivate.mockResolvedValue({ outcome: { kind: "conflict", reason: "link-failed" } })
    findApprovalById.mockResolvedValue({ id: "approval-1", status: "running", activation_consumed_at: NOW, batch_run_id: "run-1" })

    expect(await run()).toMatchObject({ kind: "activation-rejected", reason: "link-failed" })
    expect(cancelApprovalWithError).not.toHaveBeenCalled()
  })

  it("정리 중 조회가 실패해도 던지지 않는다", async () => {
    executeActivate.mockResolvedValue({ outcome: { kind: "expired" } })
    findApprovalById.mockRejectedValue(new Error("db unavailable"))

    expect(await run()).toEqual({ kind: "activation-rejected", approvalId: "approval-1", reason: "expired" })
  })
})
