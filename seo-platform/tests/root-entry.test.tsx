import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import Home from "@/app/page"
import { RootEntry } from "@/components/root-entry"
import { resolveRootEnvironmentLabel } from "@/lib/root-recovery"

describe("루트 진입 화면", () => {
  it("renders the Korean entry screen with 관리자 로그인 and SEO 운영 콘솔 buttons", () => {
    // Given: 비로그인 사용자의 루트 방문 (배지 없음 = Production).
    const markup = renderToStaticMarkup(<RootEntry environmentLabel={null} />)

    // Then: 한국어 타이틀 + 두 진입 버튼(로그인·콘솔) + 안내 문구.
    expect(markup).toContain("팔도플라워 SEO Platform")
    expect(markup).toContain("관리자 로그인")
    expect(markup).toContain('href="/login"')
    expect(markup).toContain("SEO 운영 콘솔")
    expect(markup).toContain('href="/admin"')
    expect(markup).toContain("로그인하지 않은 상태로 콘솔에 진입하면 로그인 화면으로 이동합니다")
  })

  it("removes every legacy Foundation phrase", () => {
    const markup = renderToStaticMarkup(<RootEntry environmentLabel={null} />)
    expect(markup).not.toContain("Foundation")
    expect(markup).not.toContain("schema and app shell")
    expect(markup).not.toContain("next workers")
    expect(markup).not.toContain("dependency wave")
  })

  it("shows the environment badge outside production and hides it in production", () => {
    const preview = renderToStaticMarkup(<RootEntry environmentLabel="Preview 환경" />)
    expect(preview).toContain("Preview 환경")

    const production = renderToStaticMarkup(<RootEntry environmentLabel={null} />)
    expect(production).not.toContain("Preview 환경")
    expect(production).not.toContain("로컬 개발")
  })

  it("keeps the layout mobile-responsive (column buttons stacking to row)", () => {
    const markup = renderToStaticMarkup(<RootEntry environmentLabel={null} />)
    expect(markup).toContain("flex-col")
    expect(markup).toContain("sm:flex-row")
    expect(markup).toContain("min-h-[100dvh]")
  })

  it("maps VERCEL_ENV to badge labels — production은 배지 미노출", () => {
    expect(resolveRootEnvironmentLabel("production")).toBeNull()
    expect(resolveRootEnvironmentLabel("preview")).toBe("Preview 환경")
    expect(resolveRootEnvironmentLabel("development")).toBe("Development 환경")
    expect(resolveRootEnvironmentLabel(undefined)).toBe("로컬 개발")
  })

  it("renders the server page with the local badge outside Vercel (VERCEL_ENV 미설정)", () => {
    // 서버 컴포넌트 페이지가 환경 라벨을 주입한다 — 테스트 환경은 VERCEL_ENV 미설정 = 로컬 개발.
    const markup = renderToStaticMarkup(<Home />)
    expect(markup).toContain("팔도플라워 SEO Platform")
    expect(markup).toContain("로컬 개발")
  })
})
