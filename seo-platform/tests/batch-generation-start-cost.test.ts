import { beforeEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_MAX_COST_USD } from "@/lib/batch/cost-policy"
import type { BatchRunSettings } from "@/lib/batch/types"

// startGenerationBatch가 max_cost_usd를 어떻게 정하는지 직접 검증한다 (F1 회귀 방지).
// 외부 경계는 둘뿐이다: supabase 서비스 롤 클라이언트, batch 저장소. 나머지(정책·추정)는 실제 코드.
vi.mock("server-only", () => ({}))

type FakePlace = { id: string; name: string; address: string | null; phone: string | null; slug: string | null; status: string; official_verification_status: string | null }
const PLACES: FakePlace[] = [
  { id: "p1", name: "장소1", address: "주소1", phone: "055-000-0000", slug: "funeral-p1", status: "draft", official_verification_status: "verified" },
]

// 체이너블·thenable 쿼리 대역 — count 옵션이면 {count:0}, 아니면 places 목록을 돌려준다.
function makeQuery(table: string) {
  let isCount = false
  const q = {
    select(_cols: string, opts?: { count?: string; head?: boolean }) {
      isCount = opts?.count !== undefined
      return q
    },
    in() {
      return q
    },
    eq() {
      return q
    },
    neq() {
      return q
    },
    order() {
      return q
    },
    limit() {
      return q
    },
    then(resolve: (v: unknown) => void) {
      if (isCount) {
        resolve({ count: 0, error: null })
        return
      }
      resolve({ data: table === "places" ? PLACES : [], error: null })
    },
  }
  return q
}
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceRoleClient: () => ({ from: (table: string) => makeQuery(table) }),
}))

// createRun에 넘어온 settings를 포착한다.
let capturedSettings: BatchRunSettings | null = null
vi.mock("@/lib/batch/supabase-batch-repository", () => ({
  createSupabaseBatchRepository: () => ({
    createRun: (input: { settings: BatchRunSettings }) => {
      capturedSettings = input.settings
      return Promise.resolve({ kind: "created", run: { id: "batch-x" } })
    },
  }),
}))

async function importService() {
  return import("@/lib/batch/generation-batch-service")
}

beforeEach(() => {
  capturedSettings = null
})

describe("startGenerationBatch 비용 상한", () => {
  it("maxCostUsd 미전달 시 글로벌 기본값을 상한으로 쓴다 (브라우저 Batch 경로 무영향)", async () => {
    const { startGenerationBatch } = await importService()
    const result = await startGenerationBatch({ placeIds: ["p1"], createdBy: "admin@x", officialCheckApproved: true })

    expect(result.kind).toBe("started")
    expect(capturedSettings?.max_cost_usd).toBe(DEFAULT_MAX_COST_USD)
  })

  it("maxCostUsd 전달 시 그 값이 실행 상한(settings.max_cost_usd)이 된다 (승인 Batch 경로)", async () => {
    const { startGenerationBatch } = await importService()
    const result = await startGenerationBatch({ placeIds: ["p1"], createdBy: "admin@x", officialCheckApproved: true, maxCostUsd: 0.02 })

    expect(result.kind).toBe("started")
    expect(capturedSettings?.max_cost_usd).toBe(0.02)
    // 승인값이 기본값과 다름을 명시적으로 확인한다.
    expect(capturedSettings?.max_cost_usd).not.toBe(DEFAULT_MAX_COST_USD)
  })

  it("추정 비용이 전달된 maxCostUsd를 초과하면 계획 단계에서 cost-limit으로 거부한다 (실행 전 차단)", async () => {
    const { startGenerationBatch } = await importService()
    // 1곳 추정 0.001 > 0.0005 → 초과.
    const result = await startGenerationBatch({ placeIds: ["p1"], createdBy: "admin@x", officialCheckApproved: true, maxCostUsd: 0.0005 })

    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") {
      expect(result.plan.reason).toBe("cost-limit")
    }
    expect(capturedSettings).toBeNull()
  })
})
