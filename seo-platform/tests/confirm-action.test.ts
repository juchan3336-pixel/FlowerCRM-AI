import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { ConfirmCancelButton, ConfirmPanelShell, ConfirmPanelsProvider, ConfirmToggleButton } from "@/components/admin/confirm-action"
import { DrawerActionsProvider } from "@/components/admin/drawer-actions"

function renderWithProviders(initialOpen: "publish" | null, children: ReactNode): string {
  return renderToStaticMarkup(
    createElement(DrawerActionsProvider, {
      children: createElement(ConfirmPanelsProvider, { children, initialOpen, resetKey: "test" }),
    }),
  )
}

function publishFixture(): ReactNode {
  return [
    createElement(ConfirmToggleButton, { children: "게시하기", className: "btn", key: "toggle", kind: "publish" }),
    createElement(ConfirmPanelShell, {
      children: createElement(ConfirmCancelButton, { className: "cancel", kind: "publish" }),
      closedContent: createElement("p", { key: "closed" }, "최종 게시 승인 — 검토 항목"),
      description: "아래 내용으로 즉시 공개됩니다.",
      key: "panel",
      kind: "publish",
      title: "게시 확인",
      tone: "warning",
    }),
  ]
}

describe("confirm panel interaction markup", () => {
  it("renders a closed toggle with aria wiring and the closed summary instead of the panel", () => {
    // Given: no panel is open.
    const markup = renderWithProviders(null, publishFixture())

    // Then: the toggle announces its collapsed state and panel relationship.
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('aria-controls="confirm-panel-publish"')
    expect(markup).toContain("최종 게시 승인 — 검토 항목")
    expect(markup).not.toContain('id="confirm-panel-publish"')
    expect(markup).not.toContain("게시 확인")
  })

  it("renders an open panel as a labelled region with warning icon, title, description, and cancel", () => {
    // Given: the publish panel starts open (server confirm param compatibility).
    const markup = renderWithProviders("publish", publishFixture())

    // Then: the toggle is expanded and the panel exposes region semantics.
    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('role="region"')
    expect(markup).toContain('id="confirm-panel-publish"')
    expect(markup).toContain('aria-labelledby="confirm-panel-publish-title"')
    expect(markup).toContain('id="confirm-panel-publish-title"')
    expect(markup).toContain("⚠")
    expect(markup).toContain("게시 확인")
    expect(markup).toContain("아래 내용으로 즉시 공개됩니다.")
    expect(markup).toContain("취소")
    expect(markup).toContain("animate-confirm-panel-in")
    expect(markup).not.toContain("최종 게시 승인 — 검토 항목")
  })

  it("keeps the panel an inline region rather than a blocking modal dialog", () => {
    // Given: the open publish panel.
    const markup = renderWithProviders("publish", publishFixture())

    // Then: no modal semantics are applied.
    expect(markup).not.toContain('role="dialog"')
    expect(markup).not.toContain("aria-modal")
  })
})
