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
let createResult: "created" | "already-active" = "created"

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
    cancelApprovalWithError: (approvalId: string, failure: { code: string; message: string }) => {
      cancelledWithError.push({ approvalId, ...failure })
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
  createResult = "created"
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
  it("closes the approval with a safe error code when the kick fails (no auto retry)", async () => {
    // Given: execute endpoint가 401을 돌려준다.
    const impl = vi.fn(() => Promise.resolve(new Response("nope", { status: 401 }))) as unknown as typeof fetch
    const { createApprovalAndKick } = await importService()

    // When: 승인 요청.
    const result = await createApprovalAndKick({
      placeIds: candidateInputs.map((c) => c.place.id),
      approvedBy: "admin@midmgroup.com",
      maxCostUsd: 0.004,
      env: { VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS },
      nowIso: NOW,
      fetchImpl: impl,
    })

    // Then: 승인은 approved/queued로 방치되지 않고 사유와 함께 닫힌다.
    expect(result).toEqual({ kind: "kick-failed", code: "unauthorized" })
    expect(cancelledWithError).toHaveLength(1)
    expect(cancelledWithError[0]?.approvalId).toBe("approval-1")
    expect(cancelledWithError[0]?.code).toBe("kick-failed")
    expect(cancelledWithError[0]?.message).toContain("unauthorized")
    expect(cancelledWithError[0]?.message).not.toContain(BYPASS)
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
