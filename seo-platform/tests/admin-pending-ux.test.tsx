import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { PasswordLoginFormView, passwordLoginErrorMessage } from "@/components/admin/password-login-form"
import { PlacesSearchFormView } from "@/components/admin/places-search"

describe("password login form UX", () => {
  it("maps error codes to the approved user-facing messages", () => {
    // Given / When / Then: 지정 문구가 코드별로 정확히 매핑되고 원문 메시지는 없다.
    expect(passwordLoginErrorMessage({ status: "error", code: "invalid-credentials", email: "a@b.c" })).toBe("이메일 또는 비밀번호가 올바르지 않습니다.")
    expect(passwordLoginErrorMessage({ status: "error", code: "server-error", email: "a@b.c" })).toBe("로그인 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.")
    expect(passwordLoginErrorMessage({ status: "idle" })).toBeNull()
  })

  it("shows the inline error, keeps the email value, and never renders auth internals", () => {
    // Given: 자격증명 오류 상태의 폼.
    const markup = renderToStaticMarkup(
      <PasswordLoginFormView isPending={false} nextPath="/admin/dashboard" state={{ status: "error", code: "invalid-credentials", email: "admin@example.com" }} />,
    )

    // Then: 폼 내부 오류 + 이메일 유지(defaultValue) + 비밀번호 값 없음 + aria-live 영역.
    expect(markup).toContain("이메일 또는 비밀번호가 올바르지 않습니다.")
    expect(markup).toContain('value="admin@example.com"')
    expect(markup).toContain('aria-live="polite"')
    expect(markup).not.toContain("Invalid login credentials")
    expect(markup).not.toContain("Supabase")
  })

  it("disables the submit button with a spinner while pending", () => {
    // Given: pending 상태의 폼.
    const markup = renderToStaticMarkup(<PasswordLoginFormView isPending nextPath="/admin/dashboard" state={{ status: "idle" }} />)

    // Then: disabled 속성 + "로그인 중..." + spinner + aria-busy (중복 제출 방지).
    expect(markup).toContain("로그인 중...")
    expect(markup).toContain('disabled=""')
    expect(markup).toContain("animate-spin")
    expect(markup).toContain('aria-busy="true"')
  })

  it("renders the idle submit button as 로그인", () => {
    const markup = renderToStaticMarkup(<PasswordLoginFormView isPending={false} nextPath="/admin/dashboard" state={{ status: "idle" }} />)
    expect(markup).toContain("로그인")
    expect(markup).not.toContain("로그인 중...")
    expect(markup).not.toContain('disabled=""')
  })
})

describe("places search form UX", () => {
  it("shows 검색 with the current query and reset control when idle", () => {
    // Given: 검색어가 있는 유휴 상태.
    const markup = renderToStaticMarkup(<PlacesSearchFormView isPending={false} q="거창" />)

    // Then: 검색 버튼 활성 + 현재 검색어 유지 + 검색 초기화 노출.
    expect(markup).toContain("검색")
    expect(markup).not.toContain("검색 중...")
    expect(markup).toContain('value="거창"')
    expect(markup).toContain("검색 초기화")
  })

  it("disables both search and reset with a spinner while pending", () => {
    // Given: 검색 실행 중.
    const markup = renderToStaticMarkup(<PlacesSearchFormView isPending q="거창" />)

    // Then: "검색 중..." + disabled(중복 클릭 방지) + spinner + aria-busy + 로딩 안내 문구.
    expect(markup).toContain("검색 중...")
    expect(markup).toContain("animate-spin")
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain("검색 결과를 불러오는 중입니다.")
    expect((markup.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it("hides the reset control when there is no active query", () => {
    const markup = renderToStaticMarkup(<PlacesSearchFormView isPending={false} q={null} />)
    expect(markup).not.toContain("검색 초기화")
  })
})
