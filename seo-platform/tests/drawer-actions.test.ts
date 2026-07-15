import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { ActionSubmitButtonView, DRAWER_ACTION_LABELS, DrawerActionForm, DrawerActionsProvider } from "@/components/admin/drawer-actions"
import { NoticeToast, resolveNoticeToast } from "@/components/admin/notice-toast"

describe("drawer action pending states", () => {
  it("defines the approved pending labels for all five actions", () => {
    // Given / When / Then: the five Korean pending phrases match the approved copy.
    expect(DRAWER_ACTION_LABELS.ai).toEqual({ label: "AI 생성", pendingLabel: "AI 생성 중…" })
    expect(DRAWER_ACTION_LABELS.prepare).toEqual({ label: "게시 준비", pendingLabel: "게시 준비 중…" })
    expect(DRAWER_ACTION_LABELS.publish).toEqual({ label: "게시 확인", pendingLabel: "게시 중…" })
    expect(DRAWER_ACTION_LABELS.archive).toEqual({ label: "보관 확인", pendingLabel: "보관 중…" })
    expect(DRAWER_ACTION_LABELS.restore).toEqual({ label: "복원 확인", pendingLabel: "복원 중…" })
  })

  it("shows a spinner and pending label while the action runs", () => {
    // Given: the submitting button in pending state.
    const markup = renderToStaticMarkup(
      createElement(ActionSubmitButtonView, { label: "게시 확인", pendingLabel: "게시 중…", isPending: true, disabled: true, className: "btn" }),
    )

    // Then: the spinner, phrase, busy flag, and disabled state all render.
    expect(markup).toContain("게시 중…")
    expect(markup).toContain("animate-spin")
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain("disabled")
    expect(markup).not.toContain(">게시 확인<")
  })

  it("renders all action buttons enabled when no submission is in flight", () => {
    // Given: two action forms sharing one provider, with no active submission —
    // the state after a completed server action (soft navigation does not remount the provider).
    const noopAction = () => Promise.resolve()
    const markup = renderToStaticMarkup(
      createElement(
        DrawerActionsProvider,
        null,
        createElement(DrawerActionForm, { action: noopAction, kind: "prepare", fields: { placeId: "p1" }, buttonClassName: "btn" }),
        createElement(DrawerActionForm, { action: noopAction, kind: "publish", fields: { placeId: "p1" }, buttonClassName: "btn" }),
      ),
    )

    // Then: neither button is disabled or busy — pending must not outlive the submission.
    expect(markup).not.toContain('disabled=""')
    expect(markup).not.toContain('aria-busy="true"')
    expect(markup).toContain("게시 준비")
    expect(markup).toContain("게시 확인")
  })

  it("disables sibling dangerous buttons while another action is pending", () => {
    // Given: a non-submitting button while another action is in flight.
    const markup = renderToStaticMarkup(
      createElement(ActionSubmitButtonView, { label: "AI 생성", pendingLabel: "AI 생성 중…", isPending: false, disabled: true, className: "btn" }),
    )

    // Then: it stays labeled normally but cannot be clicked.
    expect(markup).toContain("AI 생성")
    expect(markup).not.toContain("AI 생성 중…")
    expect(markup).toContain("disabled")
  })
})

describe("notice toast", () => {
  it("maps the five approved success messages", () => {
    // Given / When / Then: each success notice produces the approved Korean toast text.
    expect(resolveNoticeToast("ai-generated", null)).toEqual({ tone: "success", title: "완료", message: "AI 미리보기가 생성되었습니다." })
    expect(resolveNoticeToast("prepared", null)?.message).toBe("게시 준비가 완료되었습니다.")
    expect(resolveNoticeToast("published", null)?.message).toBe("게시가 완료되었습니다.")
    expect(resolveNoticeToast("archived", null)?.message).toBe("보관이 완료되었습니다.")
    expect(resolveNoticeToast("restored", null)?.message).toBe("게시 준비 상태로 복원되었습니다.")
  })

  it("marks failures with a safe error code and failure title", () => {
    // Given / When: a failed AI generation notice with a code.
    const content = resolveNoticeToast("ai-failed", "rate_limit")

    // Then: the failure tone carries the code without any secrets.
    expect(content?.tone).toBe("failure")
    expect(content?.title).toBe("실패")
    expect(content?.message).toContain("오류 코드: rate_limit")
    expect(resolveNoticeToast(null, null)).toBeNull()
  })

  it("renders an accessible toast with icon, text label, and close button", () => {
    // Given: a success toast.
    const successMarkup = renderToStaticMarkup(createElement(NoticeToast, { notice: "published", aiCode: null }))
    const failureMarkup = renderToStaticMarkup(createElement(NoticeToast, { notice: "publish-failed", aiCode: null }))

    // Then: tone is conveyed by icon + text (not color alone), with aria-live and a close control.
    expect(successMarkup).toContain('aria-live="polite"')
    expect(successMarkup).toContain("✓")
    expect(successMarkup).toContain("완료")
    expect(successMarkup).toContain("게시가 완료되었습니다.")
    expect(successMarkup).toContain("알림 닫기")
    expect(failureMarkup).toContain("⚠")
    expect(failureMarkup).toContain("실패")
    expect(renderToStaticMarkup(createElement(NoticeToast, { notice: null, aiCode: null }))).toBe("")
  })
})
