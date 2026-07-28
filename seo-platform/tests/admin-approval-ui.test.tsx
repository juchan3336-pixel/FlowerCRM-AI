import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { ADMIN_NAV_ITEMS, isAdminNavItemActive } from "@/components/admin/admin-data"
import { ApprovalLaunchFormView, formatVerifiedAt, type ApprovalCandidateItem } from "@/components/admin/approval-launch-form"
import { approvalWarning, canCancelApproval, canResumeApproval, describeApprovalError, describeApprovalStatus } from "@/lib/batch/approval-view"
import { approvalMaxCostUsd } from "@/lib/batch/cost-policy"

vi.mock("@/app/admin/batch/approve/actions", () => ({
  approveAndGenerateAction: () => undefined,
  cancelApprovalAction: () => undefined,
}))

function item(id: string, name: string, overrides: Partial<ApprovalCandidateItem> = {}): ApprovalCandidateItem {
  return {
    placeId: id,
    name,
    region: "부산 · 해운대구",
    address: "부산 해운대구 센텀로 1",
    phone: "051-000-0000",
    verifiedAt: "2026-07-20T05:00:00.000Z",
    verificationSourceUrls: ["https://example.test/a"],
    estimatedTokens: 1250,
    estimatedCostUsd: 0.001,
    eligible: true,
    reason: null,
    ...overrides,
  }
}

describe("승인 화면 후보 표", () => {
  it("renders every required column and the row number", () => {
    const markup = renderToStaticMarkup(
      createElement(ApprovalLaunchFormView, { candidates: [item("p1", "장소하나")], isPending: false, usdKrwRate: 1400 }),
    )
    for (const header of ["No.", "장소명", "지역", "주소", "전화", "공식 검증 출처", "검증일시", "예상 토큰", "예상 비용"]) {
      expect(markup).toContain(header)
    }
    expect(markup).toContain("장소하나")
    expect(markup).toContain("051-000-0000")
  })

  it("renders verified_at as KST, never a raw ISO timestamp", () => {
    // Given / When: 검증일시가 UTC ISO로 들어온다.
    expect(formatVerifiedAt("2026-07-23T05:08:20.699+00:00")).toBe("2026-07-23 14:08 KST")
    expect(formatVerifiedAt(null)).toBe("-")

    const markup = renderToStaticMarkup(
      createElement(ApprovalLaunchFormView, {
        candidates: [item("p1", "장소하나", { verifiedAt: "2026-07-23T05:08:20.699+00:00" })],
        isPending: false,
        usdKrwRate: 1400,
      }),
    )
    // Then: 화면에는 KST 표기만 남고 ISO 원문은 노출되지 않는다.
    expect(markup).toContain("2026-07-23 14:08 KST")
    expect(markup).not.toContain("2026-07-23T05:08")
  })

  it("marks ineligible candidates with a reason and disables their checkbox", () => {
    const markup = renderToStaticMarkup(
      createElement(ApprovalLaunchFormView, {
        candidates: [item("p2", "생성이력있음", { eligible: false, reason: "has-generation" })],
        isPending: false,
        usdKrwRate: 1400,
      }),
    )
    expect(markup).toContain("불가")
    expect(markup).toContain("기존 AI 생성 이력이 있음")
    expect(markup).toContain("disabled")
  })

  it("shows the Korean empty state when there is no candidate", () => {
    const markup = renderToStaticMarkup(createElement(ApprovalLaunchFormView, { candidates: [], isPending: false, usdKrwRate: 1400 }))
    expect(markup).toContain("현재 자동 생성 가능한 장소가 없습니다")
    expect(markup).toContain("선택할 수 있는 장소가 없습니다")
    // 부적격 목록 자체가 없으므로 섹션도 렌더링하지 않는다.
    expect(markup).not.toContain("부적격 · 제외 항목")
  })

  it("disables the approve button with nothing selected and shows a zero cost cap", () => {
    const markup = renderToStaticMarkup(createElement(ApprovalLaunchFormView, { candidates: [item("p1", "장소하나")], isPending: false, usdKrwRate: 1400 }))
    expect(markup).toContain("승인하고 자동 생성 (0곳)")
    expect(markup).toContain("disabled")
    // 아무것도 선택하지 않았는데 상한 금액이 표시되면 오해를 준다.
    expect(approvalMaxCostUsd(0)).toBe(0)
    expect(markup).toContain("$0.0000")
  })
})

describe("확인 모달", () => {
  it("states cost, cap, selected names, and the four safety notes", () => {
    const markup = renderToStaticMarkup(
      createElement(ApprovalLaunchFormView, {
        candidates: [item("p1", "장소하나"), item("p2", "장소둘")],
        isPending: false,
        usdKrwRate: 1400,
        initialSelected: ["p1", "p2"],
        initialConfirmOpen: true,
      }),
    )
    expect(markup).toContain("자동 생성 최종 승인")
    expect(markup).toContain("2곳")
    expect(markup).toContain("장소하나")
    expect(markup).toContain("장소둘")
    expect(markup).toContain(`$${approvalMaxCostUsd(2).toFixed(4)}`)
    expect(markup).toContain("AI 생성은 Preview 환경에서만 실행됩니다")
    expect(markup).toContain("Production 게시는 자동으로 실행되지 않습니다")
    expect(markup).toContain("게시 승인은 별도로 필요합니다")
    expect(markup).toContain("브라우저를 닫아도 서버에서 계속 진행됩니다")
  })

  it("spins and blocks re-submit while pending", () => {
    const markup = renderToStaticMarkup(
      createElement(ApprovalLaunchFormView, {
        candidates: [item("p1", "장소하나")],
        isPending: true,
        usdKrwRate: 1400,
        initialSelected: ["p1"],
        initialConfirmOpen: true,
      }),
    )
    expect(markup).toContain("animate-spin")
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain("승인 처리 중...")
    expect(markup).toContain("창을 닫지 말고")
  })
})

describe("적격·부적격 목록 분리", () => {
  it("splits eligible candidates from blocked ones so blocked places never look selectable", () => {
    const markup = renderToStaticMarkup(
      createElement(ApprovalLaunchFormView, {
        candidates: [item("ok", "적격장소"), item("no", "대구병원 장례식장", { eligible: false, reason: "has-generation" })],
        isPending: false,
        usdKrwRate: 1400,
      }),
    )
    expect(markup).toContain("자동 생성 가능 후보")
    expect(markup).toContain("부적격 · 제외 항목")
    expect(markup).toContain("자동 생성 불가 — 기존 AI 생성 이력이 있음")
    expect(markup).toContain("선택할 수 없습니다")
    // 부적격 장소에는 체크박스가 없다 — 적격 1건에 대한 체크박스만 존재한다.
    expect(markup.match(/type="checkbox"/g)?.length).toBe(2) // 적격 1건 + 승인 확인 체크박스
    expect(markup).toContain("대구병원 장례식장")
  })

  it("shows the zero-eligible notice when every candidate is blocked", () => {
    const markup = renderToStaticMarkup(
      createElement(ApprovalLaunchFormView, {
        candidates: [item("no", "대구병원 장례식장", { eligible: false, reason: "has-generation" })],
        isPending: false,
        usdKrwRate: 1400,
      }),
    )
    expect(markup).toContain("현재 자동 생성 가능한 장소가 없습니다")
    expect(markup).toContain("공식 검증이 완료됐고 기존 AI 생성 이력과 SEO 페이지가 없는 장소만 선택할 수 있습니다")
    // 후보 0곳이므로 승인 버튼은 계속 비활성이고 상한도 0이다.
    expect(markup).toContain("승인하고 자동 생성 (0곳)")
    expect(markup).toContain("$0.0000")
  })

  it("keeps the zero-eligible notice hidden when a selectable candidate exists", () => {
    const markup = renderToStaticMarkup(
      createElement(ApprovalLaunchFormView, { candidates: [item("ok", "적격장소")], isPending: false, usdKrwRate: 1400 }),
    )
    expect(markup).not.toContain("현재 자동 생성 가능한 장소가 없습니다")
  })
})

describe("관리자 메뉴 active 판정", () => {
  const navItem = (href: string) => {
    const found = ADMIN_NAV_ITEMS.find((entry) => entry.href === href)
    if (found === undefined) throw new Error(`nav item not registered: ${href}`)
    return found
  }
  const approve = navItem("/admin/batch/approve")
  const history = navItem("/admin/batch")
  const places = navItem("/admin/places")

  it("registers both batch menus separately", () => {
    expect(approve.label).toBe("승인 자동 생성")
    expect(history.label).toBe("Batch 이력")
  })

  it("activates only 승인 자동 생성 on the approval route", () => {
    expect(isAdminNavItemActive(approve, "/admin/batch/approve")).toBe(true)
    expect(isAdminNavItemActive(history, "/admin/batch/approve")).toBe(false)
  })

  it("activates only Batch 이력 on the history and detail routes", () => {
    for (const path of ["/admin/batch", "/admin/batch/new", "/admin/batch/publish/new", "/admin/batch/8f2c1b90-0000-0000-0000-000000000000"]) {
      expect(isAdminNavItemActive(history, path)).toBe(true)
      expect(isAdminNavItemActive(approve, path)).toBe(false)
    }
  })

  it("keeps unrelated menus unaffected", () => {
    expect(isAdminNavItemActive(places, "/admin/places")).toBe(true)
    expect(isAdminNavItemActive(places, "/admin/batch")).toBe(false)
    expect(isAdminNavItemActive(history, "")).toBe(false)
  })
})

describe("승인 이력 정책", () => {
  it("warns when a running approval never linked a batch run", () => {
    expect(approvalWarning({ status: "running", batchRunId: null, lastErrorCode: null })).toEqual({
      kind: "start-interrupted",
      message: "실행 시작 중단 — 취소 후 새 승인이 필요합니다",
    })
  })

  it("warns when the self-chain stalled", () => {
    const warning = approvalWarning({ status: "running", batchRunId: "batch-1", lastErrorCode: "chain-dispatch-failed" })
    expect(warning?.kind).toBe("chain-stalled")
    expect(warning?.message).toContain("자동 진행이 멈췄습니다")
  })

  it("warns on expired and failed, stays silent while healthy", () => {
    expect(approvalWarning({ status: "expired", batchRunId: null, lastErrorCode: null })?.kind).toBe("expired")
    expect(approvalWarning({ status: "failed", batchRunId: "b", lastErrorCode: "start-failed" })?.kind).toBe("failed")
    expect(approvalWarning({ status: "running", batchRunId: "batch-1", lastErrorCode: null })).toBeNull()
    expect(approvalWarning({ status: "completed", batchRunId: "batch-1", lastErrorCode: null })).toBeNull()
  })

  it("allows cancel only before terminal states", () => {
    expect(canCancelApproval("approved")).toBe(true)
    expect(canCancelApproval("queued")).toBe(true)
    expect(canCancelApproval("running")).toBe(true)
    expect(canCancelApproval("completed")).toBe(false)
    expect(canCancelApproval("failed")).toBe(false)
    expect(canCancelApproval("expired")).toBe(false)
    expect(canCancelApproval("cancelled")).toBe(false)
  })

  it("offers resume only for a stalled running approval with a linked run", () => {
    expect(canResumeApproval({ status: "running", batchRunId: "batch-1", lastErrorCode: "chain-dispatch-failed" })).toBe(true)
    expect(canResumeApproval({ status: "running", batchRunId: null, lastErrorCode: "chain-dispatch-failed" })).toBe(false)
    expect(canResumeApproval({ status: "completed", batchRunId: "batch-1", lastErrorCode: "chain-dispatch-failed" })).toBe(false)
  })

  it("labels statuses and hides raw internal error codes", () => {
    expect(describeApprovalStatus("running").label).toBe("자동 생성 중")
    expect(describeApprovalStatus("completed").tone).toBe("accent")
    expect(describeApprovalError("chain-dispatch-failed")).toBe("자동 진행 요청 실패")
    expect(describeApprovalError("kick-failed:unauthorized")).toBe("실행 서버 호출 실패")
    expect(describeApprovalError("some-unknown-internal-code")).toBe("실행 오류")
    expect(describeApprovalError(null)).toBeNull()
  })
})
