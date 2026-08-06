// PR C — 비장례 ContentMode 기반 candidate eligibility 확대의 계약 테스트.
// 후보 자격은 별도 allowlist 없이 중앙 resolver(contentModeForCategory) 하나를 따르고,
// 승인 요청 최종 방어(decideApprovalRequest)도 같은 기준으로 다시 판정한다.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { contentModeForCategory } from "@/lib/ai/content-mode"
import { decideApprovalRequest, type ApprovalCandidateInput } from "@/lib/batch/approval-policy"
import {
  BATCH_INELIGIBLE_LABELS,
  CONTENT_MODE_LABELS,
  decideBatchCandidate,
  hasVerificationSourceUrl,
  type BatchIneligibleReason,
} from "@/lib/batch/candidate-policy"

vi.mock("@/app/admin/batch/approve/actions", () => ({
  approveAndGenerateAction: () => undefined,
  cancelApprovalAction: () => undefined,
}))

const BASE_PLACE = {
  id: "p1",
  status: "draft" as const,
  slug: "place-p1",
  official_verification_status: "verified" as const,
  exclusion_reason: null,
  category: "funeral",
}
const BASE = { place: BASE_PLACE, generationCount: 0, seoPagePathExists: false, slugDuplicateCount: 0, verificationSourceUrls: ["http://example.test/src"] as const, activeBatchItemCount: 0, activeApprovalCount: 0 }

describe("중앙 resolver 단일 기준 — 업종별 eligibility", () => {
  it.each([
    ["funeral", "condolence"],
    ["숙박/행사", "celebration"],
    ["호텔", "celebration"],
    ["hotel", "celebration"],
    ["event", "celebration"],
    ["wedding", "celebration"],
    ["venue", "celebration"],
    ["제조", "corporate-celebration"],
    ["제조업", "corporate-celebration"],
    ["제조업체", "corporate-celebration"],
    ["건설/부동산", "corporate-celebration"],
    ["건설회사", "corporate-celebration"],
    ["종합건설", "corporate-celebration"],
    ["시행사", "corporate-celebration"],
    ["manufacturing", "corporate-celebration"],
    ["company", "corporate-celebration"],
    ["construction", "corporate-celebration"],
    ["institution", "corporate-celebration"],
  ])("%s → eligible (%s) — candidate와 resolver의 mode가 항상 일치한다", (category, mode) => {
    const decision = decideBatchCandidate({ ...BASE, place: { ...BASE_PLACE, category } })
    expect(decision).toEqual({ eligible: true, mode })
    expect(contentModeForCategory(category)).toBe(mode)
  })

  it.each([["hospital"], [""], ["  "], ["미상업종"]])("'%s'는 category-unsupported로 차단", (category) => {
    expect(decideBatchCandidate({ ...BASE, place: { ...BASE_PLACE, category } })).toEqual({ eligible: false, reason: "category-unsupported", mode: null })
  })

  it("category null도 차단된다", () => {
    expect(decideBatchCandidate({ ...BASE, place: { ...BASE_PLACE, category: null as unknown as string } })).toEqual({
      eligible: false,
      reason: "category-unsupported",
      mode: null,
    })
  })
})

describe("안전 조건 — 새로 추가된 차단", () => {
  it("공식 검증 출처 URL이 없으면 verification-source-missing", () => {
    expect(decideBatchCandidate({ ...BASE, verificationSourceUrls: [] })).toEqual({ eligible: false, reason: "verification-source-missing", mode: "condolence" })
    expect(decideBatchCandidate({ ...BASE, verificationSourceUrls: null })).toEqual({ eligible: false, reason: "verification-source-missing", mode: "condolence" })
    expect(hasVerificationSourceUrl(["  "])).toBe(false)
    expect(hasVerificationSourceUrl("http://x")).toBe(true)
  })

  it("진행 중 Batch item·승인이 있으면 차단된다", () => {
    expect(decideBatchCandidate({ ...BASE, activeBatchItemCount: 1 }).eligible).toBe(false)
    expect(decideBatchCandidate({ ...BASE, activeApprovalCount: 1 }).eligible).toBe(false)
  })

  it("기존 4곳 꼴(생성 이력·ready seo page 보유)은 중복 후보가 되지 않는다", () => {
    // 라마다·아이스퀘어·KCC·LS: 전부 applied generation + ready seo page → has-generation이 먼저 잡는다.
    const applied = decideBatchCandidate({ ...BASE, place: { ...BASE_PLACE, category: "숙박/행사" }, generationCount: 2, seoPagePathExists: true })
    expect(applied).toEqual({ eligible: false, reason: "has-generation", mode: "celebration" })
    // 이력이 지워져도 seo page가 남아 있으면 여전히 차단된다.
    expect(decideBatchCandidate({ ...BASE, place: { ...BASE_PLACE, category: "제조" }, seoPagePathExists: true })).toEqual({
      eligible: false,
      reason: "seo-page-exists",
      mode: "corporate-celebration",
    })
  })

  it("모든 차단 사유에 라벨이 있다", () => {
    const reasons: readonly BatchIneligibleReason[] = [
      "not-draft", "has-generation", "active-batch", "active-approval", "not-verified",
      "verification-source-missing", "excluded", "category-unsupported", "missing-slug", "slug-conflict", "seo-page-exists",
    ]
    for (const reason of reasons) {
      expect(BATCH_INELIGIBLE_LABELS[reason].length).toBeGreaterThan(0)
    }
    expect(CONTENT_MODE_LABELS.condolence).toContain("장례")
    expect(CONTENT_MODE_LABELS.celebration).toContain("호텔")
    expect(CONTENT_MODE_LABELS["corporate-celebration"]).toContain("사업장")
  })
})

describe("승인 요청 최종 방어 — 같은 resolver 기준", () => {
  const candidate = (overrides: Partial<ApprovalCandidateInput["place"]> = {}): ApprovalCandidateInput => ({
    place: {
      id: overrides.id ?? "11111111-1111-1111-1111-111111111111",
      name: "테스트 장소",
      address: "주소",
      phone: "055-000-0000",
      slug: "place-slug",
      status: "draft",
      category: "숙박/행사",
      official_verification_status: "verified",
      verification_source_urls: ["http://example.test/src"],
      ...overrides,
    },
    generationCount: 0,
    seoPageExists: false,
    estimatedTokens: 1250,
    estimatedCostUsd: 0.001,
  })
  const request = (input: ApprovalCandidateInput) => decideApprovalRequest({ candidates: [input], maxCostUsd: 0.01, expiresInMinutes: 30 })

  it("mode가 매핑된 업종(비장례 포함)은 승인 요청이 통과한다", () => {
    expect(request(candidate()).ok).toBe(true)
    expect(request(candidate({ category: "제조" })).ok).toBe(true)
    expect(request(candidate({ category: "funeral" })).ok).toBe(true)
  })

  it("판정 불가 업종·출처 없음은 승인 요청도 막는다", () => {
    expect(request(candidate({ category: "hospital" }))).toEqual({ ok: false, blockedBy: "category-unsupported", placeId: "11111111-1111-1111-1111-111111111111" })
    expect(request(candidate({ verification_source_urls: [] }))).toEqual({ ok: false, blockedBy: "verification-source-missing", placeId: "11111111-1111-1111-1111-111111111111" })
  })
})

describe("승인 화면 — 모드 표시·필터", () => {
  async function loadForm() {
    return import("@/components/admin/approval-launch-form")
  }
  const item = (overrides: Record<string, unknown> = {}) => {
    return {
      placeId: (overrides["placeId"] as string | undefined) ?? "p1",
      name: (overrides["name"] as string | undefined) ?? "테스트 장소",
      region: "울산 · 울주군",
      address: "주소",
      phone: "055-000-0000",
      verifiedAt: "2026-07-31T07:22:47.000Z",
      verificationSourceUrls: ["https://example.test/a"] as readonly string[],
      estimatedTokens: 1250,
      estimatedCostUsd: 0.001,
      eligible: true,
      reason: null,
      category: "숙박/행사",
      contentMode: "celebration" as const,
      hasGeneration: false,
      seoPageStatus: null,
      ...overrides,
    }
  }

  it("filterApprovalCandidates가 모드·적격 기준으로 거른다", async () => {
    const { filterApprovalCandidates } = await loadForm()
    const items = [
      item({ placeId: "a", contentMode: "condolence", category: "funeral" }),
      item({ placeId: "b", contentMode: "celebration" }),
      item({ placeId: "c", contentMode: "corporate-celebration", category: "제조", eligible: false, reason: "has-generation" }),
      item({ placeId: "d", contentMode: null, category: "hospital", eligible: false, reason: "category-unsupported" }),
    ] as never[]
    expect(filterApprovalCandidates(items, "all")).toHaveLength(4)
    expect(filterApprovalCandidates(items, "condolence").map((c) => c.placeId)).toEqual(["a"])
    expect(filterApprovalCandidates(items, "celebration").map((c) => c.placeId)).toEqual(["b"])
    expect(filterApprovalCandidates(items, "corporate-celebration").map((c) => c.placeId)).toEqual(["c"])
    expect(filterApprovalCandidates(items, "eligible-only").map((c) => c.placeId)).toEqual(["a", "b"])
    expect(filterApprovalCandidates(items, "blocked-only").map((c) => c.placeId)).toEqual(["c", "d"])
  })

  it("후보 표에 업종·모드·필터·차단 정보가 렌더링된다", async () => {
    const { ApprovalLaunchFormView } = await loadForm()
    const markup = renderToStaticMarkup(
      createElement(ApprovalLaunchFormView, {
        candidates: [
          item({ placeId: "a", name: "행사호텔", contentMode: "celebration", category: "숙박/행사" }),
          item({ placeId: "b", name: "미지원업종", contentMode: null, category: "hospital", eligible: false, reason: "category-unsupported", seoPageStatus: "ready" }),
        ] as never[],
        isPending: false,
        usdKrwRate: 1400,
      }),
    )
    // 필터 칩
    expect(markup).toContain("전체")
    expect(markup).toContain(CONTENT_MODE_LABELS.celebration)
    expect(markup).toContain(CONTENT_MODE_LABELS["corporate-celebration"])
    expect(markup).toContain("생성 가능만")
    expect(markup).toContain("생성 불가만")
    // 적격 행: 업종 원문 + 모드 배지
    expect(markup).toContain("숙박/행사")
    expect(markup).toContain("업종 / 모드")
    // 부적격 행: 판정 불가 + 사유 + 부가 정보
    expect(markup).toContain("모드 판정 불가")
    expect(markup).toContain(BATCH_INELIGIBLE_LABELS["category-unsupported"])
    expect(markup).toContain("SEO ready")
  })
})
