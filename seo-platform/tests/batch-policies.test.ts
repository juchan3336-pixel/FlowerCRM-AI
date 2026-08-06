import { describe, expect, it } from "vitest"

import { decideBatchCandidate } from "@/lib/batch/candidate-policy"
import { computePlaceContentHash, isApprovalStillValid } from "@/lib/batch/content-hash"
import { APPROVAL_DEFAULT_EXPIRY_MINUTES, APPROVAL_MAX_PLACES } from "@/lib/batch/approval-policy"
import { approvalMaxCostUsd, DEFAULT_MAX_COST_USD, estimateBatchCost, isEstimateOverLimit, shouldSkipRemainingForCost } from "@/lib/batch/cost-policy"
import { buildBatchIdempotencyKey, buildBatchStepKey } from "@/lib/batch/idempotency"
import { decideBatchItemOutcome } from "@/lib/batch/quality-policy"
import { canTransitionItem, claimableStatusesFor, isStaleProcessing, isTerminalItemStatus } from "@/lib/batch/state-machine"
import { BATCH_MAX_ITEMS, BATCH_STALE_PROCESSING_MS } from "@/lib/batch/types"

describe("Batch 후보 하드 조건", () => {
  const base = {
    place: {
      id: "p1",
      status: "draft" as const,
      slug: "funeral-x",
      official_verification_status: "verified" as const,
      exclusion_reason: null,
      category: "funeral",
    },
    generationCount: 0,
    seoPagePathExists: false,
    slugDuplicateCount: 0,
  }

  it("accepts a verified draft place without generations or conflicts", () => {
    expect(decideBatchCandidate(base)).toEqual({ eligible: true, mode: "condolence" })
  })

  it("rejects each hard condition with a specific reason", () => {
    expect(decideBatchCandidate({ ...base, place: { ...base.place, status: "published" } })).toEqual({ eligible: false, reason: "not-draft", mode: "condolence" })
    expect(decideBatchCandidate({ ...base, generationCount: 1 })).toEqual({ eligible: false, reason: "has-generation", mode: "condolence" })
    expect(decideBatchCandidate({ ...base, activeBatchItemCount: 1 })).toEqual({ eligible: false, reason: "active-batch", mode: "condolence" })
    expect(decideBatchCandidate({ ...base, activeApprovalCount: 1 })).toEqual({ eligible: false, reason: "active-approval", mode: "condolence" })
    expect(decideBatchCandidate({ ...base, place: { ...base.place, official_verification_status: null } })).toEqual({ eligible: false, reason: "not-verified", mode: "condolence" })
    expect(decideBatchCandidate({ ...base, verificationSourceUrls: [] })).toEqual({ eligible: false, reason: "verification-source-missing", mode: "condolence" })
    expect(decideBatchCandidate({ ...base, verificationSourceUrls: null })).toEqual({ eligible: false, reason: "verification-source-missing", mode: "condolence" })
    expect(decideBatchCandidate({ ...base, place: { ...base.place, official_verification_status: "excluded", exclusion_reason: "화환 반입 제한" } })).toEqual({
      eligible: false,
      reason: "excluded",
      mode: "condolence",
    })
    expect(decideBatchCandidate({ ...base, place: { ...base.place, slug: null } })).toEqual({ eligible: false, reason: "missing-slug", mode: "condolence" })
    expect(decideBatchCandidate({ ...base, slugDuplicateCount: 1 })).toEqual({ eligible: false, reason: "slug-conflict", mode: "condolence" })
    expect(decideBatchCandidate({ ...base, seoPagePathExists: true })).toEqual({ eligible: false, reason: "seo-page-exists", mode: "condolence" })
  })

  // PR C: 후보 자격은 중앙 resolver(contentModeForCategory) 하나를 따른다 — 별도 allowlist 없음.
  it("opens every mode-mapped category and keeps unmapped ones blocked", () => {
    expect(decideBatchCandidate({ ...base, place: { ...base.place, category: "숙박/행사" } })).toEqual({ eligible: true, mode: "celebration" })
    expect(decideBatchCandidate({ ...base, place: { ...base.place, category: "호텔" } })).toEqual({ eligible: true, mode: "celebration" })
    expect(decideBatchCandidate({ ...base, place: { ...base.place, category: "제조" } })).toEqual({ eligible: true, mode: "corporate-celebration" })
    expect(decideBatchCandidate({ ...base, place: { ...base.place, category: "건설/부동산" } })).toEqual({ eligible: true, mode: "corporate-celebration" })
    // 'hospital'은 병원 본체다 — 병원 장례식장은 시트에서 funeral로 들어오므로 여기서 막혀야 한다.
    for (const category of ["hospital", "자동차", ""]) {
      expect(decideBatchCandidate({ ...base, place: { ...base.place, category } })).toEqual({ eligible: false, reason: "category-unsupported", mode: null })
    }
  })

  it("keeps the batch size cap consistent with the approval expiry and cost budget", () => {
    // 값 자체가 아니라 계약을 고정한다 — pump는 1분에 item 1건이므로 상한(곳) ≤ 승인 유효시간(분)이어야
    // 잔여 item이 만료로 잘리지 않고, 승인 비용 상한은 전역 상한을 넘지 않아야 한다.
    expect(BATCH_MAX_ITEMS).toBeGreaterThan(0)
    expect(APPROVAL_MAX_PLACES).toBe(BATCH_MAX_ITEMS)
    expect(APPROVAL_DEFAULT_EXPIRY_MINUTES).toBeGreaterThanOrEqual(BATCH_MAX_ITEMS)
    expect(approvalMaxCostUsd(BATCH_MAX_ITEMS)).toBeLessThanOrEqual(DEFAULT_MAX_COST_USD)
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

describe("DB 제약과 애플리케이션 상한 정합", () => {
  it("keeps the batch_approvals place-count CHECK in sync with BATCH_MAX_ITEMS", async () => {
    // 2026-08-06: 앱 상한만 20으로 올리고 DB CHECK가 5로 남아 20곳 승인이 INSERT 단계에서 거부됐다.
    // migration 파일의 상한 값을 직접 읽어 상수와 같은지 고정한다.
    const { readFileSync, readdirSync } = await import("node:fs")
    const dir = new URL("../supabase/migrations/", import.meta.url)
    const files = readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()
    let capInDb: number | null = null
    for (const file of files) {
      const sql = readFileSync(new URL(file, dir), "utf8")
      // 가장 마지막에 정의된 place_count CHECK가 현재 유효한 제약이다.
      for (const match of sql.matchAll(/batch_approvals_place_count_check[\s\S]{0,200}?between\s+1\s+and\s+(\d+)/g)) {
        capInDb = Number(match[1])
      }
    }
    expect(capInDb).not.toBeNull()
    expect(capInDb).toBe(BATCH_MAX_ITEMS)
  })
})
