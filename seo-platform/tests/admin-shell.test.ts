import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { describe, expect, it } from "vitest"

import AdminLayout from "@/app/admin/layout"
import AdminPage from "@/app/admin/page"

const NAV_LABELS = ["수집", "보강", "동기화", "장소", "SEO", "AI", "설정"] as const

const SUMMARY_VALUES = ["장소", "SEO 페이지", "사이트맵 URL", "동기화 상태", "동기화 실패", "AI 상태", "4", "completed", "1", "미리보기만"] as const

describe("admin shell placeholder", () => {
  it("renders the required admin navigation labels", () => {
    // Given: the admin layout shell with placeholder child content.
    const shell = createElement(AdminLayout, null, "Dashboard child")

    // When: the server component is rendered to static markup.
    const markup = renderToStaticMarkup(shell)

    // Then: every planned admin section is visible in the navigation.
    for (const label of NAV_LABELS) {
      expect(markup).toContain(label)
    }
    expect(markup).toContain("로그아웃")
  })

  it("renders fixture-backed dashboard summary values", async () => {
    // Given: the admin dashboard placeholder page.
    const page = await AdminPage()

    // When: the server component is rendered without live Supabase credentials.
    const markup = renderToStaticMarkup(page)

    // Then: the summary cards expose deterministic fixture values.
    for (const value of SUMMARY_VALUES) {
      expect(markup).toContain(value)
    }
  })

  it("marks auth as a server-safe boundary without service-role secrets", () => {
    // Given: the admin shell renders behind the Supabase SSR proxy boundary.
    const shell = createElement(AdminLayout, null, "Dashboard child")

    // When: rendered in test/build without live environment credentials.
    const markup = renderToStaticMarkup(shell)

    // Then: the boundary is explicit and does not expose server-only secrets.
    expect(markup).toContain("인증 경계")
    expect(markup).toContain("Supabase SSR auth가 관리자 경로를 보호합니다")
    expect(markup).not.toContain("SUPABASE_SERVICE_ROLE_KEY")
  })
})
