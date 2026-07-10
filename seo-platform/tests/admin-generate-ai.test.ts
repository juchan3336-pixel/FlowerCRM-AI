import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import AdminGenerateAiPage from "@/app/admin/generate-ai/page"

const REQUIRED_SECTIONS = [
  "AI",
  "대상 장소 / 페이지 선택기",
  "생성 유형",
  "미리보기 패널",
  "적용 상태 패널",
  "가드레일 요약",
  "감사 추적 요약",
] as const

const REQUIRED_VALUES = [
  "FakeDeterministicAiProvider",
  "미리보기만",
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

const DISABLED_CONTROLS = ["미리보기 생성", "장소에 적용", "일괄 생성 자리표시자"] as const

const GUARDRAIL_TEXT = [
  "원본 장소에 없는 사실을 만들지 않습니다.",
  "전화번호, 이메일, 가격 정보는 생성하지 않습니다.",
  "주문과 배송 가능성은 기본 CTA로만 표현합니다.",
  "장례와 병원 문구는 사실적이고 절제되게 유지합니다.",
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
