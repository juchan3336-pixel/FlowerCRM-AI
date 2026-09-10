// 공개 루트(/) 고객용 첫 화면 — host 표면 분기·콘텐츠·메타·sitemap 계약.
import { Children, isValidElement, type ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { PublicRootLanding } from "@/components/public/root-landing"
import { RootRecoveryRedirect } from "@/components/root-recovery-redirect"
import { DEFAULT_ORDER_URL } from "@/lib/public-seo/fixtures"
import { listActiveHubSummaries } from "@/lib/public-seo/region-hub"
import { buildRootJsonLd, buildRootSitemapEntry, ROOT_DESCRIPTION, ROOT_DOCUMENT_TITLE, ROOT_TITLE } from "@/lib/public-seo/root-landing"
import type { PublicPageDto } from "@/lib/public-seo/types"
import { resolveRootSurface } from "@/lib/root-surface"

// 루트 페이지(app/page.tsx)는 request headers·DB 조회에 묶여 있어 두 의존성만 모킹한다.
const headersMock = vi.hoisted(() => ({ host: "place.xn--hq1bo4e93ri3lbmc.com" }))
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers({ host: headersMock.host })),
}))
vi.mock("@/lib/public-seo/place-pages", () => ({
  listPublishedPlacePages: () => Promise.resolve([GYEONGNAM_FUNERAL]),
}))

function pageDto(overrides: Partial<PublicPageDto> & Readonly<{ slug: string; name: string; category: string }>): PublicPageDto {
  const { name, category, slug, ...rest } = overrides
  return {
    id: `id-${slug}`,
    type: "place",
    slug,
    path: `/places/${slug}`,
    dataOrigin: "database",
    title: `${name} 화환 안내`,
    description: "확인된 정보를 안내합니다.",
    canonicalUrl: `https://place.example.com/places/${overrides.slug}`,
    priority: 0.8,
    changeFrequency: "weekly",
    lastModifiedAt: "2026-08-10T00:00:00.000Z",
    region: null,
    city: null,
    district: null,
    address: null,
    homepage: null,
    ctaUrl: "https://order.example.com/",
    place: { name, category, detailCategory: null },
    content: { faq: [], keywords: [], internalLinks: [] },
    ...rest,
  }
}

const GYEONGNAM_FUNERAL = pageDto({ slug: "f-gn-1", name: "창원장례식장", category: "funeral", region: "경남", district: "창원시", address: "경남 창원시 1" })

// 루트 페이지가 반환한 fragment의 1단계 자식 컴포넌트 타입 목록.
function topLevelChildTypes(tree: ReactElement): readonly unknown[] {
  const { children } = tree.props as Readonly<{ children?: React.ReactNode }>
  return Children.toArray(children)
    .filter((child) => isValidElement(child))
    .map((child) => child.type)
}

describe("루트 표면 판정 (host 분기)", () => {
  it("keeps the admin entry only on the 운영 관리자용 Vercel origin (포트·대소문자 무시)", () => {
    expect(resolveRootSurface("flowercrm-seo.vercel.app")).toBe("admin")
    expect(resolveRootSurface("FLOWERCRM-SEO.VERCEL.APP")).toBe("admin")
    expect(resolveRootSurface("flowercrm-seo.vercel.app:443")).toBe("admin")
  })

  it("serves the customer surface on the public domain, previews, localhost, and unknown hosts", () => {
    expect(resolveRootSurface("place.xn--hq1bo4e93ri3lbmc.com")).toBe("public")
    expect(resolveRootSurface("flowercrm-seo-git-branch-team.vercel.app")).toBe("public") // Preview 배포에서 고객용 화면을 실검증할 수 있어야 한다
    expect(resolveRootSurface("localhost:3000")).toBe("public")
    expect(resolveRootSurface(null)).toBe("public")
  })
})

describe("고객용 첫 화면 렌더", () => {
  const summaries = listActiveHubSummaries([GYEONGNAM_FUNERAL])
  const markup = renderToStaticMarkup(<PublicRootLanding summaries={summaries} />)

  it("renders the customer H1·설명 and removes every 관리자 전용 phrase", () => {
    expect(markup).toContain(ROOT_TITLE)
    expect(markup).toContain("팔도플라워의 안내 서비스")
    expect(markup).toContain("공식 홈페이지가 아니며")
    expect(markup).not.toContain("관리자 전용 서비스")
    expect(markup).not.toContain("일반 방문자용 페이지가 아닙니다")
    expect(markup).not.toContain("관리자 로그인")
    expect(markup).not.toContain("SEO 운영 콘솔")
  })

  it("renders 이용 목적 3종 and the 주문 전 확인사항 checklist", () => {
    expect(markup).toContain("장례식장 근조화환")
    expect(markup).toContain("예식장 축하화환")
    expect(markup).toContain("기업·사업장 축하화환")
    expect(markup).toContain("정확한 시설명과 주소")
    expect(markup).toContain("시설별 화환 반입 절차 사전 확인")
  })

  it("links to /hub·active hubs·외부 판매 사이트 as real anchors (외부 이동 명시)", () => {
    expect(markup).toContain('href="/hub"')
    expect(markup).toContain("지역별 화환 안내 보기")
    expect(markup).toContain('href="/hub/funeral-gyeongnam"')
    expect(markup).toContain(`href="${DEFAULT_ORDER_URL}"`)
    expect(markup).toContain("판매 사이트로 이동")
    // 배송 보장·가격·제휴 단정 금지.
    expect(markup).not.toContain("보장")
    expect(markup).not.toContain("제휴")
  })

  it("stays mobile-responsive and embeds the WebSite JSON-LD", () => {
    expect(markup).toContain("sm:grid-cols-3")
    expect(markup).toContain("sm:flex-row")
    expect(markup).toContain("min-h-[100dvh]")
    expect(markup).toContain('"@type":"WebSite"')
  })

  it("hides the hub quick-link section without active hubs but keeps the /hub CTA", () => {
    const empty = renderToStaticMarkup(<PublicRootLanding summaries={[]} />)
    expect(empty).not.toContain("곳 안내 중")
    expect(empty).toContain('href="/hub"')
  })
})

describe("루트 페이지 host 분기 (app/page.tsx)", () => {
  beforeEach(() => {
    headersMock.host = "place.xn--hq1bo4e93ri3lbmc.com"
  })

  it("renders the customer landing (published 파생 허브 링크 포함) on the public domain", async () => {
    const { default: Home } = await import("@/app/page")
    const markup = renderToStaticMarkup(await Home())
    expect(markup).toContain(ROOT_TITLE)
    expect(markup).toContain('href="/hub/funeral-gyeongnam"')
    expect(markup).not.toContain("관리자 로그인")
  })

  it("preserves the 관리자 진입 화면 on the 구 Vercel origin", async () => {
    headersMock.host = "flowercrm-seo.vercel.app"
    const { default: Home } = await import("@/app/page")
    const markup = renderToStaticMarkup(await Home())
    expect(markup).toContain("팔도플라워 SEO Platform")
    expect(markup).toContain("관리자 로그인")
    expect(markup).not.toContain(ROOT_TITLE)
  })

  it("mounts the shared recovery redirect on BOTH surfaces (복구 링크 처리 보존)", async () => {
    const { default: Home } = await import("@/app/page")
    const publicTypes = topLevelChildTypes(await Home())
    expect(publicTypes).toContain(RootRecoveryRedirect)

    headersMock.host = "flowercrm-seo.vercel.app"
    const adminTypes = topLevelChildTypes(await Home())
    expect(adminTypes).toContain(RootRecoveryRedirect)
  })

  it("emits customer metadata (canonical=공개 루트) only on the public surface", async () => {
    const { generateMetadata } = await import("@/app/page")
    const publicMeta = await generateMetadata()
    // layout template이 같은 세그먼트엔 적용되지 않으므로 브랜드 접미사 1회를 포함한 절대 title이어야 한다.
    expect(publicMeta.title).toEqual({ absolute: ROOT_DOCUMENT_TITLE })
    expect(ROOT_DOCUMENT_TITLE).toBe(`${ROOT_TITLE} | 팔도플라워`)
    expect(publicMeta.description).toBe(ROOT_DESCRIPTION)
    // 테스트 환경은 로컬 origin — canonical은 자기 origin 루트를 가리킨다.
    expect(publicMeta.alternates?.canonical).toBe("http://localhost:3000/")
    expect(publicMeta.openGraph?.url).toBe("http://localhost:3000/")

    headersMock.host = "flowercrm-seo.vercel.app"
    const adminMeta = await generateMetadata()
    expect(adminMeta).toEqual({})
  })
})

describe("루트 sitemap 항목·JSON-LD", () => {
  it("builds the root entry without lastmod (장소 수정일·현재 시각 대체 금지) — 게시 0건이면 null", () => {
    const newer = pageDto({ slug: "f-gn-2", name: "진주장례식장", category: "funeral", lastModifiedAt: "2026-09-01T00:00:00.000Z" })
    const entry = buildRootSitemapEntry([GYEONGNAM_FUNERAL, newer], "https://place.xn--hq1bo4e93ri3lbmc.com")
    expect(entry?.url).toBe("https://place.xn--hq1bo4e93ri3lbmc.com/")
    expect(entry?.changeFrequency).toBe("daily")
    expect(entry?.priority).toBe(0.8)
    // lastmod 자체를 싣지 않는다 — 장소 데이터 최신 수정일로 대신하지 않는다.
    expect(entry !== null && "lastModified" in entry).toBe(false)
    expect(buildRootSitemapEntry([], "https://place.xn--hq1bo4e93ri3lbmc.com")).toBeNull()
  })

  it("describes the service as 안내 (공식 홈페이지·제휴 오인 금지) in the WebSite JSON-LD", () => {
    const [jsonLd] = buildRootJsonLd("https://place.xn--hq1bo4e93ri3lbmc.com/")
    expect(jsonLd?.["@type"]).toBe("WebSite")
    expect(jsonLd?.["url"]).toBe("https://place.xn--hq1bo4e93ri3lbmc.com/")
    expect(jsonLd?.["description"]).toBe(ROOT_DESCRIPTION)
  })
})
