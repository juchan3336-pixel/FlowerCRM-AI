import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { ApprovalLaunchFormView, type ApprovalCandidateItem } from "@/components/admin/approval-launch-form"
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
    expect(markup).toContain("승인 가능한 후보가 없습니다")
  })

  it("disables the approve button with nothing selected", () => {
    const markup = renderToStaticMarkup(createElement(ApprovalLaunchFormView, { candidates: [item("p1", "장소하나")], isPending: false, usdKrwRate: 1400 }))
    expect(markup).toContain("승인하고 자동 생성 (0곳)")
    expect(markup).toContain("disabled")
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
