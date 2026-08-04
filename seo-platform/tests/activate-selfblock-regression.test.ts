// active-approval 자기차단 회귀 (2026-08-04 KPX 승인 b33b4097 start-failed:invalid-ineligible).
//
// executeActivate는 승인을 running으로 올린 뒤 startGenerationBatch로 후보를 재검증한다.
// 이때 자기 자신의 승인이 active-approval로 집계되면 모든 승인이 활성화 직후 실패한다.
// 이 파일은 mock 없이 실제 startGenerationBatch + decideCandidateWithContext 경로를 돌려
// excludeApprovalId의 정확한 적용 범위를 검증한다 (자기 승인만 제외, 남의 승인·목록 조회는 그대로).
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const PLACE_1 = "11111111-1111-1111-1111-111111111111"
const PLACE_2 = "22222222-2222-2222-2222-222222222222"
const SELF_APPROVAL = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const OTHER_APPROVAL = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

type FakeApproval = { id: string; status: string; approved_place_ids: string[] }
const state = {
  places: [] as { id: string; name: string; address: string; phone: string; slug: string; status: string; official_verification_status: string; category: string; verification_source_urls: string[] }[],
  approvals: [] as FakeApproval[],
}

function makePlace(id: string, slug: string) {
  return {
    id,
    name: `장소-${slug}`,
    address: "울산 남구 납도로 103",
    phone: "052-279-0200",
    slug,
    status: "draft",
    official_verification_status: "verified",
    category: "제조",
    verification_source_urls: ["http://example.test/location"],
  }
}

// 체이너블 쿼리 대역 — batch_approvals는 contains/in/neq 필터를 실제 의미대로 적용한다.
function makeQuery(table: string) {
  let isCount = false
  let containsPlaceId: string | null = null
  let inStatuses: string[] | null = null
  let neqId: string | null = null
  const q = {
    select(_cols: string, opts?: { count?: string; head?: boolean }) {
      isCount = opts?.count !== undefined
      return q
    },
    in(col: string, values: string[]) {
      if (col === "status") inStatuses = values
      return q
    },
    eq() {
      return q
    },
    neq(col: string, value: string) {
      if (col === "id") neqId = value
      return q
    },
    contains(col: string, values: string[]) {
      if (col === "approved_place_ids") containsPlaceId = values[0] ?? null
      return q
    },
    order() {
      return q
    },
    limit() {
      return q
    },
    maybeSingle() {
      return Promise.resolve({ data: null, error: null })
    },
    then(resolve: (v: unknown) => void) {
      if (table === "batch_approvals" && isCount) {
        const matched = state.approvals.filter(
          (a) =>
            (containsPlaceId === null || a.approved_place_ids.includes(containsPlaceId)) &&
            (inStatuses === null || inStatuses.includes(a.status)) &&
            (neqId === null || a.id !== neqId),
        )
        resolve({ count: matched.length, error: null })
        return
      }
      if (isCount) {
        resolve({ count: 0, error: null })
        return
      }
      resolve({ data: table === "places" ? state.places : [], error: null })
    },
  }
  return q
}
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceRoleClient: () => ({ from: (table: string) => makeQuery(table) }),
}))

const createdRuns: { placeIds: string[] }[] = []
vi.mock("@/lib/batch/supabase-batch-repository", () => ({
  createSupabaseBatchRepository: () => ({
    createRun: (input: { items: { placeId: string }[] }) => {
      createdRuns.push({ placeIds: input.items.map((item) => item.placeId) })
      return Promise.resolve({ kind: "created", run: { id: "run-regression" } })
    },
  }),
}))

async function start(placeIds: readonly string[], excludeApprovalId?: string) {
  const { startGenerationBatch } = await import("@/lib/batch/generation-batch-service")
  return startGenerationBatch({
    placeIds,
    createdBy: "tester",
    officialCheckApproved: true,
    maxCostUsd: 0.05,
    ...(excludeApprovalId === undefined ? {} : { excludeApprovalId }),
  })
}

beforeEach(() => {
  state.places = []
  state.approvals = []
  createdRuns.length = 0
})

describe("activate 자기차단 회귀 — 실제 startGenerationBatch 경로", () => {
  it("자기 approval(running)만 active여도 excludeApprovalId로 시작에 성공한다", async () => {
    state.places = [makePlace(PLACE_1, "slug-p1")]
    state.approvals = [{ id: SELF_APPROVAL, status: "running", approved_place_ids: [PLACE_1] }]
    const result = await start([PLACE_1], SELF_APPROVAL)
    expect(result.kind).toBe("started")
    expect(createdRuns).toHaveLength(1)
  })

  it("exclude 없이 부르면(목록 조회와 같은 의미) 자기 승인도 active-approval로 차단된다", async () => {
    state.places = [makePlace(PLACE_1, "slug-p1")]
    state.approvals = [{ id: SELF_APPROVAL, status: "running", approved_place_ids: [PLACE_1] }]
    const result = await start([PLACE_1])
    expect(result).toMatchObject({ kind: "invalid", plan: { reason: "ineligible" } })
    expect(createdRuns).toHaveLength(0)
  })

  it("같은 place를 문 다른 active approval은 exclude와 무관하게 계속 차단한다", async () => {
    state.places = [makePlace(PLACE_1, "slug-p1")]
    state.approvals = [
      { id: SELF_APPROVAL, status: "running", approved_place_ids: [PLACE_1] },
      { id: OTHER_APPROVAL, status: "approved", approved_place_ids: [PLACE_1] },
    ]
    const result = await start([PLACE_1], SELF_APPROVAL)
    expect(result).toMatchObject({ kind: "invalid", plan: { reason: "ineligible" } })
    expect(createdRuns).toHaveLength(0)
  })

  it("종료 상태(failed/completed/expired/cancelled) 승인은 active로 오인하지 않는다", async () => {
    state.places = [makePlace(PLACE_1, "slug-p1")]
    state.approvals = [
      { id: SELF_APPROVAL, status: "running", approved_place_ids: [PLACE_1] },
      { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", status: "failed", approved_place_ids: [PLACE_1] },
      { id: "dddddddd-dddd-dddd-dddd-dddddddddddd", status: "completed", approved_place_ids: [PLACE_1] },
      { id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", status: "expired", approved_place_ids: [PLACE_1] },
      { id: "ffffffff-ffff-ffff-ffff-ffffffffffff", status: "cancelled", approved_place_ids: [PLACE_1] },
    ]
    const result = await start([PLACE_1], SELF_APPROVAL)
    expect(result.kind).toBe("started")
  })

  it("여러 place 승인: exclude는 자기 승인 전체 place에 적용되고, 남의 승인 충돌은 그대로 잡는다", async () => {
    state.places = [makePlace(PLACE_1, "slug-p1"), makePlace(PLACE_2, "slug-p2")]
    // 자기 승인이 두 place를 모두 물고 있어도 시작에 성공해야 한다.
    state.approvals = [{ id: SELF_APPROVAL, status: "running", approved_place_ids: [PLACE_1, PLACE_2] }]
    expect((await start([PLACE_1, PLACE_2], SELF_APPROVAL)).kind).toBe("started")

    // 남의 active 승인이 그중 한 place를 물면 차단된다.
    state.approvals.push({ id: OTHER_APPROVAL, status: "queued", approved_place_ids: [PLACE_2] })
    const blocked = await start([PLACE_1, PLACE_2], SELF_APPROVAL)
    expect(blocked).toMatchObject({ kind: "invalid", plan: { reason: "ineligible" } })
  })
})
