import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import AdminGenerateAiPage from "@/app/admin/generate-ai/page"

const REQUIRED_SECTIONS = [
  "Generate AI",
  "Target place / page selector",
  "Generation types",
  "Preview panel",
  "Apply status panel",
  "Guardrail summary",
  "Audit trail summary",
] as const

const REQUIRED_VALUES = [
  "FakeDeterministicAiProvider",
  "preview-only",
  "area",
  "funeral",
  "hospital",
  "product",
  "description",
  "meta_title",
  "meta_description",
  "faq",
  "keywords",
  "internal_links",
] as const

const DISABLED_CONTROLS = ["Generate Preview", "Apply to Place", "Batch generate placeholder"] as const

const GUARDRAIL_TEXT = [
  "Do not invent facts absent from the source place.",
  "Do not generate phone, email, or price information.",
  "Express ordering and delivery availability only through the default CTA.",
  "Keep funeral and hospital language factual and restrained.",
] as const

const PRIVATE_TOKENS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",
  "KAKAO_REST_API_KEY",
  "private@hospital.example.com",
  "02-123-4567",
  "service_role",
  "imported_payload",
] as const

describe("admin generate AI placeholder", () => {
  it("renders fixture-backed AI generation sections and values", () => {
    // Given: the admin AI generation page is fixture-backed and server-rendered.
    // When: the page renders without live providers, auth, or Supabase credentials.
    const markup = renderToStaticMarkup(createElement(AdminGenerateAiPage))

    // Then: the planned workflow sections and AI domain values are visible.
    for (const section of REQUIRED_SECTIONS) {
      expect(markup).toContain(section)
    }
    for (const value of REQUIRED_VALUES) {
      expect(markup).toContain(value)
    }
  })

  it("keeps generation and apply controls disabled", () => {
    // Given: preview/apply/batch actions are intentionally non-functional in this slice.
    // When: the page renders its placeholder controls.
    const markup = renderToStaticMarkup(createElement(AdminGenerateAiPage))

    // Then: every planned control is visible and disabled in the static output.
    for (const control of DISABLED_CONTROLS) {
      expect(markup).toContain(control)
    }
    expect(markup.match(/disabled=""/g)).toHaveLength(5)
  })

  it("shows guardrails and avoids private service/API key tokens", () => {
    // Given: AI output must stay public-safe and secret-free.
    // When: the placeholder renders deterministic guardrail/audit copy.
    const markup = renderToStaticMarkup(createElement(AdminGenerateAiPage))

    // Then: guardrails are explicit and private/service/API key tokens never render.
    for (const guardrail of GUARDRAIL_TEXT) {
      expect(markup).toContain(guardrail)
    }
    for (const token of PRIVATE_TOKENS) {
      expect(markup).not.toContain(token)
    }
  })
})
