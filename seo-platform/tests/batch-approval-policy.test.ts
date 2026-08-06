import { describe, expect, it } from "vitest"

import {
  APPROVAL_DEFAULT_EXPIRY_MINUTES,
  APPROVAL_MAX_EXPIRY_MINUTES,
  APPROVAL_MAX_PLACES,
  APPROVAL_MIN_EXPIRY_MINUTES,
  APPROVAL_MIN_PLACES,
  buildApprovalPlaceSnapshot,
  canTransitionApproval,
  CHAIN_SECRET_MIN_LENGTH,
  computeApprovalSnapshotHash,
  decideApprovalRequest,
  deriveChainTickToken,
  hashActivationToken,
  isApprovalExpired,
  isTerminalApprovalStatus,
  mintActivationToken,
  tokenHashPrefix,
  verifyActivationToken,
  verifyChainTickToken,
  type ApprovalCandidateInput,
} from "@/lib/batch/approval-policy"
import { BATCH_MAX_ITEMS } from "@/lib/batch/types"
import type { BatchApprovalStatus } from "@/types/database"

const ALL_STATUSES: readonly BatchApprovalStatus[] = ["approved", "queued", "running", "completed", "failed", "expired", "cancelled"]

function candidate(overrides: Partial<ApprovalCandidateInput["place"]> = {}, extra: Partial<ApprovalCandidateInput> = {}): ApprovalCandidateInput {
  return {
    place: {
      id: overrides.id ?? "11111111-1111-1111-1111-111111111111",
      name: "예시병원 장례식장",
      address: "경남 예시시 예시로 1",
      phone: "055-000-0000",
      slug: "funeral-gyeongnam-yesisi-yesibyeongwon-jangryesikjang",
      status: "draft",
      category: "funeral",
      official_verification_status: "verified",
      verification_source_urls: ["http://example.com/funeral"],
      ...overrides,
    },
    generationCount: 0,
    seoPageExists: false,
    estimatedTokens: 1250,
    estimatedCostUsd: 0.001,
    ...extra,
  }
}

describe("승인 상태 전이표", () => {
  it("allows exactly the designed transitions and nothing else", () => {
    const allowed: readonly [BatchApprovalStatus, BatchApprovalStatus][] = [
      ["approved", "queued"],
      ["approved", "running"],
      ["approved", "expired"],
      ["approved", "cancelled"],
      ["queued", "running"],
      ["queued", "expired"],
      ["queued", "cancelled"],
      ["queued", "failed"],
      ["running", "completed"],
      ["running", "failed"],
      ["running", "cancelled"],
    ]
    const allowedSet = new Set(allowed.map(([from, to]) => `${from}->${to}`))
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        expect(canTransitionApproval(from, to), `${from}->${to}`).toBe(allowedSet.has(`${from}->${to}`))
      }
    }
  })

  it("treats completed/failed/expired/cancelled as terminal", () => {
    for (const status of ["completed", "failed", "expired", "cancelled"] as const) {
      expect(isTerminalApprovalStatus(status)).toBe(true)
    }
    for (const status of ["approved", "queued", "running"] as const) {
      expect(isTerminalApprovalStatus(status)).toBe(false)
    }
  })
})

describe("Activation token", () => {
  it("mints a 256-bit token whose plaintext is never equal to the stored hash", () => {
    const minted = mintActivationToken()
    // base64url 인코딩된 32바이트 = 43자
    expect(minted.token).toHaveLength(43)
    expect(minted.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(minted.tokenHash).not.toContain(minted.token)
    expect(hashActivationToken(minted.token)).toBe(minted.tokenHash)
    // 매 발급마다 다른 토큰
    expect(mintActivationToken().token).not.toBe(minted.token)
  })

  it("verifies only the matching token and rejects wrong or malformed input", () => {
    const minted = mintActivationToken()
    expect(verifyActivationToken(minted.token, minted.tokenHash)).toBe(true)
    expect(verifyActivationToken("wrong-token", minted.tokenHash)).toBe(false)
    expect(verifyActivationToken(minted.token, hashActivationToken("other"))).toBe(false)
    expect(verifyActivationToken(minted.token, "")).toBe(false)
    expect(verifyActivationToken(minted.token, "zz-not-hex")).toBe(false)
  })

  it("exposes only an 8-character hash prefix for diagnostics", () => {
    const minted = mintActivationToken()
    const prefix = tokenHashPrefix(minted.tokenHash)
    expect(prefix).toHaveLength(8)
    expect(minted.tokenHash.startsWith(prefix)).toBe(true)
    expect(minted.token).not.toContain(prefix)
  })
})

describe("Chain tick token — Activation token과 분리된 후속 tick 인증", () => {
  const CHAIN_SECRET = "chain-secret-0123456789abcdef0123456789abcdef"
  const APPROVAL_ID = "22222222-2222-2222-2222-222222222222"

  it("derives a deterministic per-tick token distinct from the activation token", () => {
    const activation = mintActivationToken()
    const tick0 = deriveChainTickToken(CHAIN_SECRET, APPROVAL_ID, 0)
    const tick1 = deriveChainTickToken(CHAIN_SECRET, APPROVAL_ID, 1)
    expect(tick0).toBe(deriveChainTickToken(CHAIN_SECRET, APPROVAL_ID, 0))
    expect(tick0).not.toBe(tick1)
    expect(tick0).not.toBe(activation.token)
    expect(tick0).not.toBe(activation.tokenHash)
  })

  it("verifies only the exact secret + approval + tick combination", () => {
    const token = deriveChainTickToken(CHAIN_SECRET, APPROVAL_ID, 3)
    expect(verifyChainTickToken({ chainSecret: CHAIN_SECRET, approvalId: APPROVAL_ID, tick: 3, candidateToken: token })).toBe(true)
    expect(verifyChainTickToken({ chainSecret: CHAIN_SECRET, approvalId: APPROVAL_ID, tick: 4, candidateToken: token })).toBe(false)
    expect(verifyChainTickToken({ chainSecret: CHAIN_SECRET, approvalId: "33333333-3333-3333-3333-333333333333", tick: 3, candidateToken: token })).toBe(false)
    expect(verifyChainTickToken({ chainSecret: `${CHAIN_SECRET}-other`, approvalId: APPROVAL_ID, tick: 3, candidateToken: token })).toBe(false)
    expect(verifyChainTickToken({ chainSecret: CHAIN_SECRET, approvalId: APPROVAL_ID, tick: 3, candidateToken: "forged" })).toBe(false)
  })

  it("refuses short secrets and invalid ticks (fail closed)", () => {
    expect(() => deriveChainTickToken("short", APPROVAL_ID, 0)).toThrow()
    expect(() => deriveChainTickToken(CHAIN_SECRET, APPROVAL_ID, -1)).toThrow()
    expect(() => deriveChainTickToken(CHAIN_SECRET, APPROVAL_ID, 1.5)).toThrow()
    expect(verifyChainTickToken({ chainSecret: "short", approvalId: APPROVAL_ID, tick: 0, candidateToken: "x" })).toBe(false)
    expect(verifyChainTickToken({ chainSecret: CHAIN_SECRET, approvalId: APPROVAL_ID, tick: -1, candidateToken: "x" })).toBe(false)
    expect(CHAIN_SECRET_MIN_LENGTH).toBe(32)
  })
})

describe("승인 만료", () => {
  it("expires exactly at or after the deadline and fails closed on bad timestamps", () => {
    expect(isApprovalExpired("2026-07-24T02:00:00Z", "2026-07-24T01:59:59Z")).toBe(false)
    expect(isApprovalExpired("2026-07-24T02:00:00Z", "2026-07-24T02:00:00Z")).toBe(true)
    expect(isApprovalExpired("2026-07-24T02:00:00Z", "2026-07-24T02:00:01Z")).toBe(true)
    expect(isApprovalExpired("not-a-date", "2026-07-24T02:00:00Z")).toBe(true)
    expect(isApprovalExpired("2026-07-24T02:00:00Z", "not-a-date")).toBe(true)
  })
})

describe("승인 후보 판정", () => {
  const BASE = { maxCostUsd: 0.05, expiresInMinutes: APPROVAL_DEFAULT_EXPIRY_MINUTES }

  it("approves 1 to the cap and rejects 0 or cap+1", () => {
    expect(APPROVAL_MIN_PLACES).toBe(1)
    expect(APPROVAL_MAX_PLACES).toBe(BATCH_MAX_ITEMS)
    const five = Array.from({ length: APPROVAL_MAX_PLACES }, (_, index) => candidate({ id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}` }))
    const ok = decideApprovalRequest({ candidates: five, ...BASE })
    expect(ok.ok).toBe(true)
    expect(ok.ok && ok.snapshot).toHaveLength(APPROVAL_MAX_PLACES)

    expect(decideApprovalRequest({ candidates: [], ...BASE })).toEqual({ ok: false, blockedBy: "no-places" })
    const six = Array.from({ length: APPROVAL_MAX_PLACES + 1 }, (_, index) => candidate({ id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}` }))
    expect(decideApprovalRequest({ candidates: six, ...BASE })).toEqual({ ok: false, blockedBy: "too-many-places" })
  })

  // 0/1/상한/상한+1 경계를 개별 케이스로 고정한다 — DB의 coalesce CHECK와 짝을 이루는 애플리케이션 방어선.
  it.each([
    [0, false, "no-places"],
    [1, true, null],
    [APPROVAL_MAX_PLACES, true, null],
    [APPROVAL_MAX_PLACES + 1, false, "too-many-places"],
  ])("place count %i → allowed=%s", (count, allowed, blockedBy) => {
    const candidates = Array.from({ length: count }, (_, index) => candidate({ id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}` }))
    const decision = decideApprovalRequest({ candidates, ...BASE })
    expect(decision.ok).toBe(allowed)
    if (!decision.ok) {
      expect(decision.blockedBy).toBe(blockedBy)
    } else {
      expect(decision.snapshot).toHaveLength(count)
    }
  })

  it("rejects unverified, excluded, published, generation-bearing and seo-page-bearing places", () => {
    expect(decideApprovalRequest({ candidates: [candidate({ official_verification_status: null })], ...BASE })).toMatchObject({ ok: false, blockedBy: "not-verified" })
    expect(decideApprovalRequest({ candidates: [candidate({ official_verification_status: "excluded" })], ...BASE })).toMatchObject({ ok: false, blockedBy: "excluded" })
    expect(decideApprovalRequest({ candidates: [candidate({ status: "published" })], ...BASE })).toMatchObject({ ok: false, blockedBy: "not-draft" })
    expect(decideApprovalRequest({ candidates: [candidate({}, { generationCount: 1 })], ...BASE })).toMatchObject({ ok: false, blockedBy: "has-generation" })
    expect(decideApprovalRequest({ candidates: [candidate({}, { seoPageExists: true })], ...BASE })).toMatchObject({ ok: false, blockedBy: "has-seo-page" })
    expect(decideApprovalRequest({ candidates: [candidate({ slug: null })], ...BASE })).toMatchObject({ ok: false, blockedBy: "missing-slug" })
    expect(decideApprovalRequest({ candidates: [candidate(), candidate()], ...BASE })).toMatchObject({ ok: false, blockedBy: "duplicate-place" })
  })

  it("rejects invalid cost caps and expiry windows", () => {
    expect(decideApprovalRequest({ candidates: [candidate()], maxCostUsd: 0, expiresInMinutes: 30 })).toEqual({ ok: false, blockedBy: "invalid-max-cost" })
    expect(decideApprovalRequest({ candidates: [candidate()], maxCostUsd: -1, expiresInMinutes: 30 })).toEqual({ ok: false, blockedBy: "invalid-max-cost" })
    expect(decideApprovalRequest({ candidates: [candidate()], maxCostUsd: Number.NaN, expiresInMinutes: 30 })).toEqual({ ok: false, blockedBy: "invalid-max-cost" })
    expect(decideApprovalRequest({ candidates: [candidate()], maxCostUsd: 0.05, expiresInMinutes: APPROVAL_MIN_EXPIRY_MINUTES - 1 })).toEqual({ ok: false, blockedBy: "invalid-expiry" })
    expect(decideApprovalRequest({ candidates: [candidate()], maxCostUsd: 0.05, expiresInMinutes: APPROVAL_MAX_EXPIRY_MINUTES + 1 })).toEqual({ ok: false, blockedBy: "invalid-expiry" })
    expect(decideApprovalRequest({ candidates: [candidate()], maxCostUsd: 0.05, expiresInMinutes: 30.5 })).toEqual({ ok: false, blockedBy: "invalid-expiry" })
  })
})

describe("승인 스냅샷", () => {
  it("freezes identity fields with a deterministic per-place hash", () => {
    const snapshot = buildApprovalPlaceSnapshot(candidate())
    expect(snapshot.had_generation).toBe(false)
    expect(snapshot.had_seo_page).toBe(false)
    expect(snapshot.estimated_tokens).toBe(1250)
    expect(snapshot.estimated_cost_usd).toBe(0.001)
    expect(snapshot.snapshot_hash).toMatch(/^[0-9a-f]{64}$/)
    // 동일 입력 → 동일 해시 (결정성)
    expect(buildApprovalPlaceSnapshot(candidate()).snapshot_hash).toBe(snapshot.snapshot_hash)
  })

  it("changes the hash when any identity field changes (승인 후 변경 감지)", () => {
    const base = buildApprovalPlaceSnapshot(candidate())
    expect(buildApprovalPlaceSnapshot(candidate({ address: "경남 예시시 다른로 2" })).snapshot_hash).not.toBe(base.snapshot_hash)
    expect(buildApprovalPlaceSnapshot(candidate({ phone: "055-999-9999" })).snapshot_hash).not.toBe(base.snapshot_hash)
    expect(buildApprovalPlaceSnapshot(candidate({ name: "다른병원 장례식장" })).snapshot_hash).not.toBe(base.snapshot_hash)
    expect(buildApprovalPlaceSnapshot(candidate({ slug: "funeral-other" })).snapshot_hash).not.toBe(base.snapshot_hash)
  })

  it("computes the hash over canonical identity fields only", () => {
    const entry = {
      place_id: "p1",
      name: "n",
      address: null,
      phone: null,
      slug: "s",
      official_verification_status: "verified",
    }
    expect(computeApprovalSnapshotHash(entry)).toBe(computeApprovalSnapshotHash({ ...entry }))
    expect(computeApprovalSnapshotHash(entry)).not.toBe(computeApprovalSnapshotHash({ ...entry, name: "n2" }))
  })
})
