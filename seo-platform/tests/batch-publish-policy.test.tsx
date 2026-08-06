import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { BatchPublishFormView, type BatchPublishCandidateItem } from "@/components/admin/batch-publish-form"
import { computePlaceContentHash, isApprovalStillValid, type ApprovalSnapshot } from "@/lib/batch/content-hash"
import {
  decidePublishCandidate,
  planPublishBatchStart,
  PUBLISH_INELIGIBLE_LABELS,
  type PublishCandidateDecision,
  type PublishCandidateInput,
} from "@/lib/batch/publish-candidate-policy"
import { BATCH_MAX_ITEMS } from "@/lib/batch/types"

const ELIGIBLE_INPUT: PublishCandidateInput = {
  place: { id: "p1", status: "draft", official_verification_status: "verified" },
  seoPage: { id: "s1", status: "ready", path: "/places/funeral-daegu-junggu-gwakbyeongwon-jangryesikjang" },
  latestGenerationId: "g1",
}

describe("Batch 게시 후보 하드 조건", () => {
  it("accepts a draft place with a ready seo page and an applied generation", () => {
    expect(decidePublishCandidate(ELIGIBLE_INPUT)).toEqual({ eligible: true })
  })

  it("rejects each hard condition with a specific reason", () => {
    expect(decidePublishCandidate({ ...ELIGIBLE_INPUT, place: { ...ELIGIBLE_INPUT.place, official_verification_status: "excluded" } })).toEqual({ eligible: false, reason: "excluded" })
    expect(decidePublishCandidate({ ...ELIGIBLE_INPUT, place: { ...ELIGIBLE_INPUT.place, status: "published" } })).toEqual({ eligible: false, reason: "not-draft" })
    expect(decidePublishCandidate({ ...ELIGIBLE_INPUT, seoPage: { ...ELIGIBLE_INPUT.seoPage, status: "published" } })).toEqual({ eligible: false, reason: "seo-not-ready" })
    expect(decidePublishCandidate({ ...ELIGIBLE_INPUT, latestGenerationId: null })).toEqual({ eligible: false, reason: "no-generation" })
    expect(decidePublishCandidate({ ...ELIGIBLE_INPUT, seoPage: { ...ELIGIBLE_INPUT.seoPage, path: "/area/some-path" } })).toEqual({ eligible: false, reason: "missing-path" })
  })

  it("blocks the 109 fixture shape — ready seo page without any generation", () => {
    // 109디자인: place draft + seo_page ready + generation 없음 → no-generation 차단.
    const decision = decidePublishCandidate({ ...ELIGIBLE_INPUT, latestGenerationId: null })
    expect(decision).toEqual({ eligible: false, reason: "no-generation" })
    expect(PUBLISH_INELIGIBLE_LABELS["no-generation"]).toContain("생성 이력이 없음")
  })
})

describe("Batch 게시 시작 계획", () => {
  const eligible: PublishCandidateDecision = { eligible: true }
  const decisions = new Map<string, PublishCandidateDecision>([
    ["p1", eligible],
    ["p2", eligible],
    ["p3", { eligible: false, reason: "no-generation" }],
  ])

  it("accepts an approved unique selection within the cap", () => {
    expect(planPublishBatchStart({ placeIds: ["p1", "p2"], decisions, publishApproved: true, maxItems: BATCH_MAX_ITEMS })).toEqual({ kind: "ok", placeIds: ["p1", "p2"] })
  })

  it("rejects empty, duplicate, over-cap, unapproved, and ineligible selections", () => {
    expect(planPublishBatchStart({ placeIds: [], decisions, publishApproved: true, maxItems: 5 })).toMatchObject({ kind: "invalid", reason: "empty" })
    expect(planPublishBatchStart({ placeIds: ["p1", "p1"], decisions, publishApproved: true, maxItems: 5 })).toMatchObject({ kind: "invalid", reason: "duplicate" })
    expect(planPublishBatchStart({ placeIds: ["a", "b", "c", "d", "e", "f"], decisions, publishApproved: true, maxItems: 5 })).toMatchObject({ kind: "invalid", reason: "too-many" })
    expect(planPublishBatchStart({ placeIds: ["p1"], decisions, publishApproved: false, maxItems: 5 })).toMatchObject({ kind: "invalid", reason: "publish-approval-required" })
    expect(planPublishBatchStart({ placeIds: ["p1", "p3"], decisions, publishApproved: true, maxItems: 5 })).toMatchObject({ kind: "invalid", reason: "ineligible", detail: "p3:no-generation" })
  })
})

describe("게시 승인 스냅샷 검증", () => {
  const content = { meta_title: "t", meta_description: "d", description: "body", faq: [{ q: "q1" }], keywords: ["k"], internal_links: [] }

  it("keeps an approval valid while content and generation stay unchanged", () => {
    const snapshot: ApprovalSnapshot = { generation_id: "g1", seo_page_id: "s1", content_hash: computePlaceContentHash(content), approved_by: "admin", approved_at: "2026-07-22T06:00:00Z" }
    expect(isApprovalStillValid(snapshot, computePlaceContentHash(content), "g1")).toBe(true)
  })

  it("invalidates the approval when content or generation changed after approval", () => {
    const snapshot: ApprovalSnapshot = { generation_id: "g1", seo_page_id: "s1", content_hash: computePlaceContentHash(content), approved_by: "admin", approved_at: "2026-07-22T06:00:00Z" }
    expect(isApprovalStillValid(snapshot, computePlaceContentHash({ ...content, description: "edited" }), "g1")).toBe(false)
    expect(isApprovalStillValid(snapshot, computePlaceContentHash(content), "g2")).toBe(false)
  })
})

const CANDIDATES: readonly BatchPublishCandidateItem[] = [
  { placeId: "p1", name: "곽병원 장례식장", region: "대구 중구", path: "/places/funeral-daegu-junggu-gwakbyeongwon-jangryesikjang", category: "funeral", contentMode: "condolence", eligible: true, reason: null },
  { placeId: "p2", name: "109디자인", region: "경남 양산시", path: "/places/area-yangsan-yangsansi-109dijain", category: "건설회사", contentMode: "corporate-celebration", eligible: false, reason: "no-generation" },
]

describe("Batch 게시 폼 UX", () => {
  it("renders candidates with 게시 가능/불가 badges and the approval checkbox when idle", () => {
    const markup = renderToStaticMarkup(<BatchPublishFormView candidates={CANDIDATES} envBlocked={false} initialSelected={["p1"]} isPending={false} />)
    expect(markup).toContain("일괄 게시 시작 (1건)")
    expect(markup).toContain("게시 가능")
    expect(markup).toContain("게시 불가 — 적용된 AI 생성 이력이 없음 (fixture 등)")
    expect(markup).toContain("운영 게시를 승인합니다")
    expect(markup).not.toContain("배치 준비 중...")
  })

  it("disables the start button with 배치 준비 중... and a spinner while pending", () => {
    const markup = renderToStaticMarkup(<BatchPublishFormView candidates={CANDIDATES} envBlocked={false} initialSelected={["p1"]} isPending />)
    expect(markup).toContain("배치 준비 중...")
    expect(markup).toContain("animate-spin")
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain("게시 배치를 생성하고 있습니다")
  })

  it("keeps everything disabled when the environment blocks publishing", () => {
    const markup = renderToStaticMarkup(<BatchPublishFormView candidates={CANDIDATES} envBlocked initialSelected={[]} isPending={false} />)
    expect((markup.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})

describe("게시 화면 빠른 선택 (카테고리 + 지정 수량)", () => {
  it("filters by content mode and picks the top N eligible candidates only", async () => {
    const { filterPublishCandidates, quickSelectPublishCandidates } = await import("@/components/admin/batch-publish-form")
    const [condolenceBase, corporateBase] = CANDIDATES
    if (condolenceBase === undefined || corporateBase === undefined) {
      throw new Error("fixture missing")
    }
    const many: BatchPublishCandidateItem[] = [
      { ...condolenceBase, placeId: "a1" },
      { ...condolenceBase, placeId: "a2" },
      { ...condolenceBase, placeId: "a3", eligible: false, reason: "seo-not-ready" },
      { ...corporateBase, placeId: "b1", eligible: true, reason: null },
      { ...condolenceBase, placeId: "a4" },
    ]

    expect(filterPublishCandidates(many, "condolence").map((candidate) => candidate.placeId)).toEqual(["a1", "a2", "a3", "a4"])
    // condolence 지정 + 수량 2 — 부적격(a3)은 건너뛴다.
    expect(quickSelectPublishCandidates(many, "condolence", 2)).toEqual(["a1", "a2"])
    // corporate 지정 — 해당 모드 적격만.
    expect(quickSelectPublishCandidates(many, "corporate-celebration", 5)).toEqual(["b1"])
    // 상한 초과 수량은 5로 잘리고, 전체 필터에서는 적격 4곳 전부.
    expect(quickSelectPublishCandidates(many, "all", 99)).toEqual(["a1", "a2", "b1", "a4"])
  })

  it("renders the mode filter chips and quick-select controls", () => {
    const markup = renderToStaticMarkup(<BatchPublishFormView candidates={CANDIDATES} envBlocked={false} isPending={false} />)
    expect(markup).toContain("게시 후보 필터")
    expect(markup).toContain("선택 수량")
    expect(markup).toContain("자동 선택")
    expect(markup).toContain("선택 해제")
    expect(markup).toContain("publish-quick-count")
  })
})
