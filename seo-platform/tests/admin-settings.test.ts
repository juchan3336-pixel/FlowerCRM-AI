import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import AdminSettingsPage, { AdminSettingsContent } from "@/app/admin/settings/page"
import { loadAdminSettings } from "@/lib/settings/admin-settings"
import type { AdminSettingsRepository } from "@/lib/settings/types"

describe("admin settings", () => {
  it("renders fixture-backed admin settings fields and values when Supabase env is absent", async () => {
    // Given: the fixture-backed admin settings placeholder page.
    const page = await AdminSettingsPage()

    // When: the server component is rendered without live Supabase settings access.
    const markup = renderToStaticMarkup(page)

    // Then: every planned setting label and deterministic placeholder value is visible.
    for (const value of [
      "Site URL",
      "https://flowers.example.test",
      "Brand Name",
      "전국팔도꽃배달",
      "Default Order URL",
      "https://flowers.example.test/order",
      "Default OG Image",
      "/og/default-flower-crm.png",
      "Google verification code",
      "google-site-verification=fixture-placeholder",
      "Naver verification code",
      "naver-site-verification=fixture-placeholder",
      "AI Provider",
      "OpenAI placeholder",
      "AI Model",
      "gpt-4.1-mini placeholder",
      "Public address policy",
      "Show city and district only",
      "Public phone policy",
      "Mask until explicit publish approval",
    ] as const) {
      expect(markup).toContain(value)
    }
  })

  it("loads Supabase repository values through the read-only settings seam", async () => {
    // Given: a credential-free fake repository matching the settings table row shape.
    const repository: AdminSettingsRepository = {
      listSettings() {
        return Promise.resolve([
          { key: "site_url", value: "https://seo.paldoflower.test", updatedAt: "2026-07-03T00:00:00.000Z" },
          { key: "brand_name", value: "팔도플라워", updatedAt: "2026-07-03T00:00:00.000Z" },
          { key: "public_phone_policy", value: "Never publish phone numbers", updatedAt: "2026-07-03T00:00:00.000Z" },
        ])
      },
    }

    // When: settings are loaded and rendered through the same admin content component.
    const settings = await loadAdminSettings(repository)
    const markup = renderToStaticMarkup(createElement(AdminSettingsContent, { settings }))

    // Then: table-backed values override local defaults while missing rows keep safe fallback values.
    expect(settings.source).toBe("supabase")
    expect(markup).toContain("Supabase settings table")
    expect(markup).toContain("https://seo.paldoflower.test")
    expect(markup).toContain("팔도플라워")
    expect(markup).toContain("Never publish phone numbers")
    expect(markup).toContain("/og/default-flower-crm.png")
  })

  it("keeps admin settings controls non-functional placeholders", async () => {
    // Given: the settings slice must not implement persistence or server actions yet.
    const page = await AdminSettingsPage()

    // When: the page is rendered to static markup.
    const markup = renderToStaticMarkup(page)

    // Then: controls are visibly disabled/read-only and persistence copy points to a later Supabase table slice.
    expect(markup).toContain("Saving remains disabled until authenticated settings table writes")
    expect(markup).toContain("disabled")
    expect(markup).toContain("readOnly")
    expect(markup).toContain("Save settings placeholder")
  })

  it("does not expose private tokens in admin settings placeholders", async () => {
    // Given: settings will eventually sit near provider credentials and verification metadata.
    const page = await AdminSettingsPage()

    // When: the fixture-backed placeholder page is rendered.
    const markup = renderToStaticMarkup(page)

    // Then: no private token names, bearer values, or service-role labels cross the UI boundary.
    for (const privateToken of [
      "SUPABASE_SERVICE_ROLE_KEY",
      "service_role",
      "service-role",
      "GOOGLE_SERVICE_ACCOUNT_JSON",
      "OPENAI_API_KEY",
      "Bearer ",
      "refresh_token",
      "private@example.com",
    ] as const) {
      expect(markup).not.toContain(privateToken)
    }
  })
})
