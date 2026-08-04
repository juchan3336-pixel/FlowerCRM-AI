import { beforeEach, describe, expect, it, vi } from "vitest"

import { hashActivationToken } from "@/lib/batch/approval-policy"
import type { ApprovalCandidateInput } from "@/lib/batch/approval-policy"

vi.mock("server-only", () => ({}))

// ── 후보 로더 대역 ────────────────────────────────────────────────
const candidateInputs: ApprovalCandidateInput[] = []
vi.mock("@/lib/batch/approval-candidates", () => ({
  loadApprovalCandidateInputs: (placeIds: readonly string[]) =>
    Promise.resolve(candidateInputs.filter((candidate) => placeIds.includes(candidate.place.id))),
}))

// ── 승인 저장소 대역 ──────────────────────────────────────────────
type CreatedApproval = { id: string; executionTokenHash: string; approvedMaxCostUsd: number; approvedBy: string; approvedPlaceIds: readonly string[] }
const created: CreatedApproval[] = []
const cancelledWithError: { approvalId: string; code: string; message: string }[] = []
const chainErrors: { approvalId: string; code: string }[] = []
let createResult: "created" | "already-active" = "created"

// kick 응답을 못 받았을 때 서비스가 다시 읽는 승인 행. 실행 접수 증거 유무를 여기서 조작한다.
type ApprovalRow = {
  id: string
  status: string
  activation_consumed_at: string | null
  batch_run_id: string | null
  execution_tick: number
}
let approvalRow: ApprovalRow | null = null
let findThrows = false

vi.mock("@/lib/batch/supabase-approval-repository", () => ({
  createSupabaseApprovalRepository: () => ({
    createApproval: (input: { executionTokenHash: string; approvedMaxCostUsd: number; approvedBy: string; approvedPlaceIds: readonly string[] }) => {
      if (createResult === "already-active") {
        return Promise.resolve({ kind: "already-active" })
      }
      const row = { id: "approval-1", ...input }
      created.push(row)
      return Promise.resolve({ kind: "created", approval: { id: row.id } })
    },
    findApprovalById: () => {
      if (findThrows) return Promise.reject(new Error("db unavailable"))
      return Promise.resolve(approvalRow)
    },
    cancelApprovalWithError: (approvalId: string, failure: { code: string; message: string }) => {
      cancelledWithError.push({ approvalId, ...failure })
      return Promise.resolve(null)
    },
    recordChainDispatchError: (approvalId: string, code: string) => {
      chainErrors.push({ approvalId, code })
      return Promise.resolve(null)
    },
  }),
}))

const NOW = "2026-07-27T07:00:00.000Z"
const BYPASS = "bypass-secret-value"

function candidate(id: string, name: string): ApprovalCandidateInput {
  return {
    place: {
      id,
      name,
      address: `주소 ${name}`,
      phone: "055-000-0000",
      slug: `funeral-${id}`,
      status: "draft",
      category: "funeral",
      official_verification_status: "verified",
      verification_source_urls: ["https://example.test/source"],
    },
    generationCount: 0,
    seoPageExists: false,
    estimatedTokens: 1250,
    estimatedCostUsd: 0.001,
  }
}

function okFetch(): { impl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url, init: init ?? {} })
    return Promise.resolve(new Response("{}", { status: 200 }))
  }) as unknown as typeof fetch
  return { impl, calls }
}

async function importService() {
  return import("@/lib/batch/approval-request-service")
}

beforeEach(() => {
  candidateInputs.length = 0
  created.length = 0
  cancelledWithError.length = 0
  chainErrors.length = 0
  createResult = "created"
  findThrows = false
  // 기본값: 실행 접수 증거가 전혀 없는 상태(안전 취소 가능).
  approvalRow = { id: "approval-1", status: "approved", activation_consumed_at: null, batch_run_id: null, execution_tick: 0 }
  candidateInputs.push(candidate("11111111-1111-1111-1111-111111111111", "장소1"), candidate("22222222-2222-2222-2222-222222222222", "장소2"))
})

describe("승인 생성 + kick", () => {
  it("creates the approval, stores only the token hash, and kicks the preview endpoint once", async () => {
    // Given: 유효한 후보 2곳과 정상 응답.
    const { impl, calls } = okFetch()
    const { createApprovalAndKick } = await importService()

    // When: 승인하고 자동 생성을 요청한다.
    const result = await createApprovalAndKick({
      placeIds: candidateInputs.map((c) => c.place.id),
      approvedBy: "admin@midmgroup.com",
      maxCostUsd: 0.004,
      env: { VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS },
      nowIso: NOW,
      fetchImpl: impl,
    })

    // Then: 승인 1건 생성 + kick 1회, 저장된 값은 해시(64자 hex)뿐이다.
    expect(result).toEqual({ kind: "started", approvalId: "approval-1" })
    expect(created).toHaveLength(1)
    expect(created[0]?.approvedBy).toBe("admin@midmgroup.com")
    expect(created[0]?.approvedMaxCostUsd).toBe(0.004)
    expect(created[0]?.approvedPlaceIds).toHaveLength(2)
    expect(created[0]?.executionTokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(calls).toHaveLength(1)

    // 요청에 실린 activation token 원문은 DB 저장값과 다르며, 해시만 저장돼 있다.
    const auth = (calls[0]?.init as RequestInit & { headers: Record<string, string> }).headers["authorization"] ?? ""
    const rawToken = auth.replace("Bearer ", "")
    expect(rawToken.length).toBeGreaterThan(20)
    expect(created[0]?.executionTokenHash).toBe(hashActivationToken(rawToken))
    expect(created[0]?.executionTokenHash).not.toBe(rawToken)
    expect(cancelledWithError).toHaveLength(0)
  })

  it("blocks ineligible requests before creating any approval row", async () => {
    // Given: 이미 generation이 있는 후보.
    candidateInputs.length = 0
    const withGeneration = { ...candidate("33333333-3333-3333-3333-333333333333", "장소3"), generationCount: 1 }
    candidateInputs.push(withGeneration)
    const { impl, calls } = okFetch()
    const { createApprovalAndKick } = await importService()

    // When / Then: 승인 행도 kick도 발생하지 않는다.
    const result = await createApprovalAndKick({
      placeIds: [withGeneration.place.id],
      approvedBy: "admin@midmgroup.com",
      maxCostUsd: 0.002,
      env: { VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS },
      nowIso: NOW,
      fetchImpl: impl,
    })
    expect(result).toEqual({ kind: "blocked", reason: "has-generation" })
    expect(created).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it("rejects an empty selection", async () => {
    const { impl } = okFetch()
    const { createApprovalAndKick } = await importService()
    const result = await createApprovalAndKick({
      placeIds: [],
      approvedBy: "admin@midmgroup.com",
      maxCostUsd: 0.002,
      env: { VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS },
      nowIso: NOW,
      fetchImpl: impl,
    })
    expect(result).toEqual({ kind: "blocked", reason: "no-places" })
    expect(created).toHaveLength(0)
  })

  it("surfaces already-active without kicking", async () => {
    createResult = "already-active"
    const { impl, calls } = okFetch()
    const { createApprovalAndKick } = await importService()
    const result = await createApprovalAndKick({
      placeIds: candidateInputs.map((c) => c.place.id),
      approvedBy: "admin@midmgroup.com",
      maxCostUsd: 0.004,
      env: { VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS },
      nowIso: NOW,
      fetchImpl: impl,
    })
    expect(result).toEqual({ kind: "already-active" })
    expect(calls).toHaveLength(0)
  })
})

describe("kick 실패 보상", () => {
  async function kickWith(status: number | "reject") {
    const impl = (
      status === "reject"
        ? vi.fn(() => Promise.reject(new Error("timeout")))
        : vi.fn(() => Promise.resolve(new Response("nope", { status })))
    ) as unknown as typeof fetch
    const { createApprovalAndKick } = await importService()
    return createApprovalAndKick({
      placeIds: candidateInputs.map((c) => c.place.id),
      approvedBy: "admin@midmgroup.com",
      maxCostUsd: 0.004,
      env: { VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS },
      nowIso: NOW,
      fetchImpl: impl,
    })
  }

  it("closes the approval only when there is no evidence the run ever started", async () => {
    // Given: 실행 접수 증거가 전혀 없다(기본 fixture).
    const result = await kickWith(401)

    // Then: 안전 취소 + 사유 기록. secret은 남지 않는다.
    expect(result).toEqual({ kind: "kick-failed", code: "unauthorized" })
    expect(cancelledWithError).toHaveLength(1)
    expect(cancelledWithError[0]?.approvalId).toBe("approval-1")
    expect(cancelledWithError[0]?.code).toBe("kick-failed")
    expect(cancelledWithError[0]?.message).toContain("unauthorized")
    expect(cancelledWithError[0]?.message).not.toContain(BYPASS)
  })

  // PR-D 핵심 회귀: 통영 사고 재현 — 응답은 timeout이었지만 Preview는 이미 실행을 접수했다.
  it("never cancels when the activation token was already consumed (timeout, not failure)", async () => {
    approvalRow = { id: "approval-1", status: "running", activation_consumed_at: NOW, batch_run_id: null, execution_tick: 0 }

    const result = await kickWith("reject")

    expect(result).toEqual({ kind: "accepted-unconfirmed", approvalId: "approval-1" })
    expect(cancelledWithError).toHaveLength(0)
  })

  it("never cancels when a batch run is already linked", async () => {
    approvalRow = { id: "approval-1", status: "running", activation_consumed_at: null, batch_run_id: "batch-1", execution_tick: 0 }

    const result = await kickWith("reject")

    expect(result).toEqual({ kind: "accepted-unconfirmed", approvalId: "approval-1" })
    expect(cancelledWithError).toHaveLength(0)
  })

  it("never cancels when the run already completed or a tick advanced", async () => {
    approvalRow = { id: "approval-1", status: "completed", activation_consumed_at: null, batch_run_id: null, execution_tick: 0 }
    expect(await kickWith("reject")).toEqual({ kind: "accepted-unconfirmed", approvalId: "approval-1" })

    approvalRow = { id: "approval-1", status: "queued", activation_consumed_at: null, batch_run_id: null, execution_tick: 1 }
    expect(await kickWith("reject")).toEqual({ kind: "accepted-unconfirmed", approvalId: "approval-1" })

    expect(cancelledWithError).toHaveLength(0)
  })

  it("reports unknown (never cancels) when the approval cannot be re-read", async () => {
    findThrows = true

    const result = await kickWith("reject")

    expect(result).toEqual({ kind: "unknown", approvalId: "approval-1" })
    expect(cancelledWithError).toHaveLength(0)
    expect(chainErrors).toEqual([{ approvalId: "approval-1", code: "kick-status-unknown" }])
  })

  it("reports unknown for an ambiguous state instead of guessing", async () => {
    // 종료 상태인데 실행 증거 필드는 비어 있는 애매한 조합.
    approvalRow = { id: "approval-1", status: "failed", activation_consumed_at: null, batch_run_id: null, execution_tick: 0 }

    const result = await kickWith("reject")

    expect(result).toEqual({ kind: "unknown", approvalId: "approval-1" })
    expect(cancelledWithError).toHaveLength(0)
  })

  it("treats a 202 Accepted response as a successful hand-off", async () => {
    const impl = vi.fn(() => Promise.resolve(new Response("", { status: 202 }))) as unknown as typeof fetch
    const { createApprovalAndKick } = await importService()

    const result = await createApprovalAndKick({
      placeIds: candidateInputs.map((c) => c.place.id),
      approvedBy: "admin@midmgroup.com",
      maxCostUsd: 0.004,
      env: { VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS },
      nowIso: NOW,
      fetchImpl: impl,
    })

    expect(result).toEqual({ kind: "started", approvalId: "approval-1" })
    expect(cancelledWithError).toHaveLength(0)
  })

  it("does not even attempt the kick when the bypass secret is missing", async () => {
    const { impl, calls } = okFetch()
    const { createApprovalAndKick } = await importService()
    const result = await createApprovalAndKick({
      placeIds: candidateInputs.map((c) => c.place.id),
      approvedBy: "admin@midmgroup.com",
      maxCostUsd: 0.004,
      env: {},
      nowIso: NOW,
      fetchImpl: impl,
    })
    expect(result).toEqual({ kind: "kick-failed", code: "bypass-secret-missing" })
    expect(calls).toHaveLength(0)
    expect(cancelledWithError).toHaveLength(1)
  })
})
