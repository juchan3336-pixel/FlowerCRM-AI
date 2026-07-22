import { describe, expect, it } from "vitest"

import { decideBatchCandidate } from "@/lib/batch/candidate-policy"
import { computePlaceContentHash, isApprovalStillValid } from "@/lib/batch/content-hash"
import { DEFAULT_MAX_COST_USD, estimateBatchCost, isEstimateOverLimit, shouldSkipRemainingForCost } from "@/lib/batch/cost-policy"
import { buildBatchIdempotencyKey, buildBatchStepKey } from "@/lib/batch/idempotency"
import { decideBatchItemOutcome } from "@/lib/batch/quality-policy"
import { canTransitionItem, claimableStatusesFor, isStaleProcessing, isTerminalItemStatus } from "@/lib/batch/state-machine"
import { BATCH_MAX_ITEMS, BATCH_STALE_PROCESSING_MS } from "@/lib/batch/types"

describe("Batch 후보 하드 조건", () => {
  const base = {
    place: { id: "p1", status: "draft" as const, slug: "funeral-x", official_verification_status: "verified" as const, exclusion_reason: null },
    generationCount: 0,
    seoPagePathExists: false,
    slugDuplicateCount: 0,
  }

  it("accepts a verified draft place without generations or conflicts", () => {
    expect(decideBatchCandidate(base)).toEqual({ eligible: true })
  })

  it("rejects each hard condition with a specific reason", () => {
    expect(decideBatchCandidate({ ...base, place: { ...base.place, status: "published" } })).toEqual({ eligible: false, reason: "not-draft" })
    expect(decideBatchCandidate({ ...base, generationCount: 1 })).toEqual({ eligible: false, reason: "has-generation" })
    expect(decideBatchCandidate({ ...base, place: { ...base.place, official_verification_status: null } })).toEqual({ eligible: false, reason: "not-verified" })
    expect(decideBatchCandidate({ ...base, place: { ...base.place, official_verification_status: "excluded", exclusion_reason: "화환 반입 제한" } })).toEqual({
      eligible: false,
      reason: "excluded",
    })
    expect(decideBatchCandidate({ ...base, place: { ...base.place, slug: null } })).toEqual({ eligible: false, reason: "missing-slug" })
    expect(decideBatchCandidate({ ...base, slugDuplicateCount: 1 })).toEqual({ eligible: false, reason: "slug-conflict" })
    expect(decideBatchCandidate({ ...base, seoPagePathExists: true })).toEqual({ eligible: false, reason: "seo-page-exists" })
  })

  it("keeps the batch size cap at five", () => {
    expect(BATCH_MAX_ITEMS).toBe(5)
  })
})

describe("Batch WARN v1 품질 분기", () => {
  const warn = (code: string) => ({ level: "warn" as const, code, message: code })
  const fail = (code: string) => ({ level: "fail" as const, code, message: code })

  it("maps PASS to ready and repeat:title-only WARN to warn_ready (auto-ready)", () => {
    expect(decideBatchItemOutcome({ status: "pass", issues: [] })).toEqual({ kind: "auto-ready", targetStatus: "ready" })
    expect(decideBatchItemOutcome({ status: "warn", issues: [warn("repeat:title")] })).toEqual({ kind: "auto-ready", targetStatus: "warn_ready" })
  })

  it("routes other single WARN and two-plus WARN to needs_review", () => {
    expect(decideBatchItemOutcome({ status: "warn", issues: [warn("repeat:keywords")] })).toEqual({ kind: "needs-review", reason: "warn-other" })
    expect(decideBatchItemOutcome({ status: "warn", issues: [warn("repeat:title"), warn("faq:pool-exhausted")] })).toEqual({ kind: "needs-review", reason: "warn-count" })
  })

  it("honors hold policy even for repeat:title", () => {
    expect(decideBatchItemOutcome({ status: "warn", issues: [warn("repeat:title")] }, "hold")).toEqual({ kind: "needs-review", reason: "warn-other" })
  })

  it("retries only pure repeat:faq FAIL and fails everything else without retry", () => {
    expect(decideBatchItemOutcome({ status: "fail", issues: [fail("repeat:faq")] })).toEqual({ kind: "retry-faq", reason: "quality-fail-repeat-faq" })
    expect(decideBatchItemOutcome({ status: "fail", issues: [fail("banned:price")] })).toEqual({ kind: "failed", reason: "quality-fail:banned:price" })
    expect(decideBatchItemOutcome({ status: "fail", issues: [fail("repeat:faq"), fail("banned:phone")] })).toEqual({
      kind: "failed",
      reason: "quality-fail:repeat:faq,banned:phone",
    })
  })
})

describe("Batch 상태 머신", () => {
  it("allows only the declared transitions", () => {
    expect(canTransitionItem("queued", "processing")).toBe(true)
    expect(canTransitionItem("processing", "ready")).toBe(true)
    expect(canTransitionItem("processing", "interrupted")).toBe(true)
    expect(canTransitionItem("interrupted", "processing")).toBe(true)
    expect(canTransitionItem("queued", "ready")).toBe(false)
    expect(canTransitionItem("failed", "processing")).toBe(false)
    expect(canTransitionItem("published", "processing")).toBe(false)
    // 게시 배치 전용 종료 전이
    expect(canTransitionItem("processing", "published", "publish")).toBe(true)
    expect(canTransitionItem("processing", "published", "generate")).toBe(false)
  })

  it("claims queued/interrupted for generate and ready/warn_ready/interrupted for publish", () => {
    expect(claimableStatusesFor("generate")).toEqual(["queued", "interrupted"])
    expect(claimableStatusesFor("publish")).toEqual(["ready", "warn_ready", "interrupted"])
  })

  it("marks only long-stalled processing items as stale (no auto-resume)", () => {
    const updatedAt = "2026-07-22T03:00:00.000Z"
    expect(isStaleProcessing({ status: "processing", updatedAt, now: "2026-07-22T03:05:00.000Z" })).toBe(false)
    expect(isStaleProcessing({ status: "processing", updatedAt, now: "2026-07-22T03:10:00.000Z" })).toBe(true)
    expect(isStaleProcessing({ status: "queued", updatedAt, now: "2026-07-22T04:00:00.000Z" })).toBe(false)
    expect(BATCH_STALE_PROCESSING_MS).toBe(10 * 60 * 1000)
  })

  it("identifies terminal statuses", () => {
    for (const status of ["ready", "warn_ready", "needs_review", "failed", "skipped", "published", "publish_failed"] as const) {
      expect(isTerminalItemStatus(status)).toBe(true)
    }
    expect(isTerminalItemStatus("processing")).toBe(false)
    expect(isTerminalItemStatus("interrupted")).toBe(false)
  })
})

describe("Batch 비용 정책", () => {
  it("estimates cost deterministically and blocks over-limit starts", () => {
    const estimate = estimateBatchCost(5, 1400)
    expect(estimate.estimatedTokens).toBe(6250)
    expect(estimate.estimatedCostUsd).toBeCloseTo(0.005, 10)
    expect(estimate.estimatedCostKrw).toBe(7)
    expect(isEstimateOverLimit(estimate, DEFAULT_MAX_COST_USD)).toBe(false)
    expect(isEstimateOverLimit(estimate, 0.004)).toBe(true)
  })

  it("skips remaining items once actual accumulated cost reaches the limit", () => {
    expect(shouldSkipRemainingForCost(0.049, 0.05)).toBe(false)
    expect(shouldSkipRemainingForCost(0.05, 0.05)).toBe(true)
  })
})

describe("멱등성 키·승인 스냅샷", () => {
  it("builds deterministic idempotency keys", () => {
    expect(buildBatchIdempotencyKey("b1", "p1")).toBe("batch:b1:place:p1")
    expect(buildBatchStepKey({ kind: "generate", step: "generating", batchId: "b1", placeId: "p1" })).toBe("batch:b1:place:p1:generate:generating")
    expect(buildBatchIdempotencyKey("b1", "p1")).toBe(buildBatchIdempotencyKey("b1", "p1"))
  })

  it("hashes content deterministically and detects post-approval changes", () => {
    const content = {
      meta_title: "제목",
      meta_description: "메타",
      description: "본문",
      faq: [{ question: "Q", answer: "A" }],
      keywords: ["k1"],
      internal_links: [],
    }
    const hash = computePlaceContentHash(content)
    expect(computePlaceContentHash({ ...content })).toBe(hash)
    expect(computePlaceContentHash({ ...content, meta_title: "다른 제목" })).not.toBe(hash)

    const snapshot = { generation_id: "g1", seo_page_id: "s1", content_hash: hash, approved_by: "admin", approved_at: "2026-07-22T00:00:00Z" }
    expect(isApprovalStillValid(snapshot, hash, "g1")).toBe(true)
    // 승인 후 콘텐츠가 바뀌면 해당 item만 중단 대상이 된다.
    expect(isApprovalStillValid(snapshot, computePlaceContentHash({ ...content, description: "변조" }), "g1")).toBe(false)
    expect(isApprovalStillValid(snapshot, hash, "g2")).toBe(false)
  })
})
