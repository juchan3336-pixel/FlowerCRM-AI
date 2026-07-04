import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { describe, expect, it } from "vitest"

import AdminLayout from "@/app/admin/layout"
import AdminPage from "@/app/admin/page"

const NAV_LABELS = ["Dashboard", "Places", "SEO Pages", "Generate AI", "Sync", "Sitemap", "Settings"] as const

const SUMMARY_VALUES = ["Places", "SEO pages", "Sitemap URLs", "Sync status", "Sync failures", "AI status", "4", "completed", "1", "preview-only"] as const

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
    expect(markup).toContain("Auth boundary")
    expect(markup).toContain("Supabase SSR auth protects admin routes")
    expect(markup).not.toContain("SUPABASE_SERVICE_ROLE_KEY")
  })
})
