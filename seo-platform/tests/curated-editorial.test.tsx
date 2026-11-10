// 검수 편집 본문 계약.
// 사람이 공식 출처와 대조해 쓴 본문을 코드에 두고, 지금 게시된 페이지와 식별자가 모두 같을 때만 화면에 싣는다.
// 다른 시설에 붙거나, 검수하지 않은 페이지의 본문이 함께 열리거나, 금지 표현이 섞여 들어가면 안 된다.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { PlaceLanding } from "@/components/public/place-landing"
import { scanBannedExpressionsInFields } from "@/lib/ai/content-quality"
import { findForbiddenModeVocabularyInFields } from "@/lib/ai/mode-vocabulary"
import { CURATED_PLACE_BODY_SLUGS } from "@/lib/public-seo/curated-body"
import { CURATED_EDITORIAL_BODIES, findCuratedEditorialBody, isRenderableSourceUrl, laterIsoTimestamp } from "@/lib/public-seo/curated-editorial"
import { buildJsonLdObjects, buildSitemapEntriesFromPages, findPublicPageByTypeAndSlug, listPublishedPublicPages } from "@/lib/public-seo/public-pages"
import type { PublicSeoSource } from "@/lib/public-seo/types"

const ENTRY = CURATED_EDITORIAL_BODIES.find((entry) => entry.placeName === "성균관컨벤션웨딩홀")
if (ENTRY === undefined) {
  throw new Error("fixture entry missing")
}
const DB_MODIFIED = "2026-11-10T08:38:09.7904+00:00"
const DB_BODY = "DB에 저장된 AI 본문입니다. 이 문장은 화면에 나오면 안 됩니다."
const FAQ = [{ question: "주문 시 행사명과 받는 분 성함은 어떻게 입력하나요?", answer: "주문 과정에서 정확히 입력해 주세요." }]

function makeSource(overrides: Partial<PublicSeoSource> = {}): PublicSeoSource {
  return {
    id: ENTRY?.seoPageId ?? "",
    type: "place",
    slug: ENTRY?.slug ?? "",
    path: `/places/${ENTRY?.slug ?? ""}`,
    dataOrigin: "database",
    status: "published",
    title: "성균관컨벤션웨딩홀 기념행사 화환 주문 정보",
    description: "성균관컨벤션웨딩홀 축하화환 주문 전 필요한 정보와 세부 조건을 안내합니다.",
    canonicalUrl: `/places/${ENTRY?.slug ?? ""}`,
    priority: 0.7,
    changeFrequency: "weekly",
    lastModifiedAt: DB_MODIFIED,
    region: "서울",
    city: "서울",
    district: "종로구",
    address: "서울 종로구 성균관로 31 (지번) 명륜3가 53",
    homepage: "http://www.skkconvention.co.kr/",
    ctaUrl: "https://example.com/order",
    place: { name: "성균관컨벤션웨딩홀", category: "숙박/행사", detailCategory: "웨딩홀 / 예식장" },
    content: { faq: FAQ, keywords: [], internalLinks: [] },
    placeBody: DB_BODY,
    ...overrides,
  }
}

function pageOf(source: PublicSeoSource) {
  const page = findPublicPageByTypeAndSlug([source], "place", source.slug)
  if (page === undefined) {
    throw new Error("page not resolved")
  }
  return page
}
const text = (markup: string): string => markup.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

describe("편집 본문 맵의 형식", () => {
  it("slug·SEO 페이지 ID가 겹치지 않고, 형식이 맞다", () => {
    expect(new Set(CURATED_EDITORIAL_BODIES.map((entry) => entry.slug)).size).toBe(CURATED_EDITORIAL_BODIES.length)
    expect(new Set(CURATED_EDITORIAL_BODIES.map((entry) => entry.seoPageId)).size).toBe(CURATED_EDITORIAL_BODIES.length)
    for (const entry of CURATED_EDITORIAL_BODIES) {
      expect(entry.seoPageId, entry.slug).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(entry.reviewedAt, entry.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(Number.isNaN(Date.parse(entry.contentUpdatedAt)), entry.slug).toBe(false)
      expect(entry.paragraphs.length, entry.slug).toBeGreaterThanOrEqual(3)
      expect(entry.paragraphs.length, entry.slug).toBeLessThanOrEqual(4)
      // 첫 문단은 그 시설을 가리킨다.
      expect(entry.paragraphs[0], entry.slug).toContain(entry.placeName)
      for (const source of entry.sources) {
        expect(isRenderableSourceUrl(source.url), source.url).toBe(true)
        expect(source.label.trim().length, source.url).toBeGreaterThan(0)
      }
    }
  })

  it("금지 표현(가격·보장·도착 약속·제휴·전화)이 없다", () => {
    for (const entry of CURATED_EDITORIAL_BODIES) {
      const body = entry.paragraphs.join(" ")
      const fields = entry.paragraphs.map((paragraph, index) => ({ field: `paragraph[${String(index)}]`, text: paragraph }))
      expect(scanBannedExpressionsInFields(fields).map((issue) => issue.code), entry.slug).toEqual([])
      for (const pattern of [/\d{2,4}-\d{3,4}-\d{4}/, /\d[\d,]*\s*원/, /무료/, /보장/, /제휴/, /도착하도록 접수/, /빈소 앞으로 전달/, /반입이? ?가능합니다/, /보낼 수 있습니다/, /반드시 도착/]) {
        expect(pattern.test(body), `${entry.slug}: ${String(pattern)}`).toBe(false)
      }
    }
  })

  it("모드 어휘를 지킨다 — 예식장 본문에 장례 어휘가 없고, 장례식장 본문에 축하 어휘가 없다", () => {
    for (const entry of CURATED_EDITORIAL_BODIES) {
      const mode = entry.slug.startsWith("funeral-") ? "condolence" : "celebration"
      const fields = entry.paragraphs.map((paragraph, index) => ({ field: `paragraph[${String(index)}]`, text: paragraph }))
      const findings = findForbiddenModeVocabularyInFields({ fields, mode, placeName: entry.placeName, regionTokens: [] })
      expect(findings.map((finding) => finding.term), entry.slug).toEqual([])
    }
  })

  it("확인 주체를 나눈다 — 시설 반입은 시설에, 제작·배송은 주문 과정에", () => {
    for (const entry of CURATED_EDITORIAL_BODIES) {
      const body = entry.paragraphs.join(" ")
      expect(body, entry.slug).toMatch(/(예식장|장례식장)에 직접 확인/)
      expect(body, entry.slug).toContain("주문 과정에서")
      // 주문 과정이 시설의 반입을 확인해 준다고 쓰지 않는다.
      expect(body, entry.slug).not.toMatch(/주문 과정에서 [^.]*반입 (위치|가능)[^.]*확인(할 수|이 가능|됩니다)/)
    }
  })

  it("화환 정책을 찾지 못한 곳은 조사 범위를 한정해 쓰고, 출처에 있는 페이지만 열거한다", () => {
    for (const entry of CURATED_EDITORIAL_BODIES.filter((candidate) => candidate.sources.length > 0 && !candidate.slug.startsWith("funeral-"))) {
      const last = entry.paragraphs[entry.paragraphs.length - 1] ?? ""
      expect(last, entry.slug).toContain("페이지에서는 화환 반입 기준을 확인하지 못했습니다")
      expect(last, entry.slug).toContain(entry.reviewedAt)
      for (const overreach of ["이용 안내", "체크리스트", "자주 묻는 질문", "안내가 없습니다", "사이트 전체"]) {
        expect(last, `${entry.slug}: ${overreach}`).not.toContain(overreach)
      }
    }
  })

  it("기존 옵트인 4곳은 모두 편집본을 갖는다 (도착·전달 단정 문장을 대체)", () => {
    for (const slug of CURATED_PLACE_BODY_SLUGS) {
      expect(CURATED_EDITORIAL_BODIES.some((entry) => entry.slug === slug), slug).toBe(true)
    }
  })
})

describe("식별자 일치", () => {
  it("slug·SEO 페이지 ID·장소명이 모두 같을 때만 돌려준다", () => {
    const match = { slug: ENTRY.slug, seoPageId: ENTRY.seoPageId, placeName: ENTRY.placeName }
    expect(findCuratedEditorialBody(match)).toBe(ENTRY)
    expect(findCuratedEditorialBody({ ...match, seoPageId: "00000000-0000-4000-8000-000000000000" })).toBeNull()
    expect(findCuratedEditorialBody({ ...match, placeName: "성균관컨벤션" })).toBeNull()
    expect(findCuratedEditorialBody({ ...match, placeName: null })).toBeNull()
    expect(findCuratedEditorialBody({ ...match, slug: "area-seoul-other" })).toBeNull()
  })

  it.each([
    ["SEO 페이지 ID가 다름", { id: "00000000-0000-4000-8000-000000000000" }],
    ["장소명이 다름", { place: { name: "다른 예식장", category: "숙박/행사", detailCategory: null } }],
    ["DB에서 온 페이지가 아님", { dataOrigin: "fixture" as const }],
  ])("%s → 편집 본문을 붙이지 않고, 수정 시각도 그대로다", (_label, overrides) => {
    const page = pageOf(makeSource(overrides))
    expect(page.editorialBody).toBeNull()
    expect(page.lastModifiedAt).toBe(DB_MODIFIED)
    const markup = renderToStaticMarkup(createElement(PlaceLanding, { page }))
    expect(markup).not.toContain('id="place-body-heading"')
    expect(text(markup)).not.toContain(ENTRY.paragraphs[1] ?? "")
  })
})

describe("화면", () => {
  it("편집 본문과 출처·확인일을 보이고, DB의 AI 본문은 보이지 않는다", () => {
    const page = pageOf(makeSource())
    const markup = renderToStaticMarkup(createElement(PlaceLanding, { page }))
    const visible = text(markup)

    for (const paragraph of ENTRY.paragraphs) {
      expect(visible).toContain(paragraph)
    }
    expect(visible).not.toContain(DB_BODY)
    expect(visible).toContain(`확인일 ${ENTRY.reviewedAt}`)
    for (const source of ENTRY.sources) {
      expect(markup).toContain(`href="${source.url}"`)
      expect(visible).toContain(source.label)
    }
    // 공식 홈페이지 링크와 반입 확인 안내는 그대로 있다.
    expect(markup).toContain('href="http://www.skkconvention.co.kr/"')
    expect(markup).toContain('id="venue-policy"')
  })

  it("FAQ 화면과 FAQ JSON-LD, canonical은 편집 본문과 무관하게 그대로다", () => {
    const withEditorial = pageOf(makeSource())
    const without = pageOf(makeSource({ id: "00000000-0000-4000-8000-000000000000" }))

    expect(withEditorial.content).toEqual(without.content)
    expect(withEditorial.canonicalUrl).toBe(without.canonicalUrl)
    expect(withEditorial.title).toBe(without.title)
    expect(withEditorial.description).toBe(without.description)
    const faqOf = (page: typeof withEditorial) => buildJsonLdObjects(page).find((object) => object["@type"] === "FAQPage")
    expect(faqOf(withEditorial)).toEqual(faqOf(without))
    // 편집 본문은 JSON-LD에 싣지 않는다.
    expect(JSON.stringify(buildJsonLdObjects(withEditorial))).not.toContain("화환 반입 기준을 확인하지 못했습니다")
  })

  it("출처가 없는 편집본(기존 4곳)은 본문만 바꾸고 출처 목록은 보이지 않는다", () => {
    const old = CURATED_EDITORIAL_BODIES.find((entry) => entry.placeName === "리베라컨벤션")
    if (old === undefined) {
      throw new Error("entry missing")
    }
    const riskyDbBody = "리베라컨벤션은 웨딩홀입니다.\n\n주문서에 위 정보를 입력하시면 예식 시작 전에 도착하도록 접수되며, 접수 후 진행 상황을 안내해 드립니다."
    const page = pageOf(
      makeSource({ id: old.seoPageId, slug: old.slug, path: `/places/${old.slug}`, canonicalUrl: `/places/${old.slug}`, place: { name: old.placeName, category: "숙박/행사", detailCategory: null }, placeBody: riskyDbBody, homepage: "https://www.rivieraconvention.com/" }),
    )
    const markup = renderToStaticMarkup(createElement(PlaceLanding, { page }))

    expect(text(markup)).toContain(old.paragraphs[2] ?? "")
    expect(text(markup)).not.toContain("예식 시작 전에 도착하도록 접수")
    expect(markup).not.toContain('id="place-body-sources"')
    expect(markup).toContain('href="https://www.rivieraconvention.com/"')
  })

  it("옵트인 목록에도 편집 맵에도 없는 페이지는 본문 영역이 없다", () => {
    const page = pageOf(makeSource({ id: "11111111-0000-4000-8000-000000000000", slug: "area-seoul-not-curated", path: "/places/area-seoul-not-curated", canonicalUrl: "/places/area-seoul-not-curated" }))
    const markup = renderToStaticMarkup(createElement(PlaceLanding, { page }))
    expect(markup).not.toContain('id="place-body-heading"')
    expect(text(markup)).not.toContain(DB_BODY)
  })
})

describe("수정 시각과 sitemap", () => {
  it("편집 본문을 고친 시각이 더 늦으면 그 시각, 아니면 DB 시각", () => {
    expect(laterIsoTimestamp("2026-11-10T08:38:09.7904+00:00", "2026-11-10T11:30:00.000Z")).toBe("2026-11-10T11:30:00.000Z")
    expect(laterIsoTimestamp("2026-11-12T00:00:00+00:00", "2026-11-10T11:30:00.000Z")).toBe("2026-11-12T00:00:00+00:00")
    expect(laterIsoTimestamp("2026-11-10T08:00:00+00:00", "not a time")).toBe("2026-11-10T08:00:00+00:00")
    expect(laterIsoTimestamp("not a time", "2026-11-10T11:30:00.000Z")).toBe("2026-11-10T11:30:00.000Z")
  })

  it("단건·목록·sitemap이 같은 수정 시각을 쓰고, sitemap의 URL 집합은 바뀌지 않는다", () => {
    const curated = makeSource()
    const other = makeSource({ id: "22222222-0000-4000-8000-000000000000", slug: "area-seoul-other", path: "/places/area-seoul-other", canonicalUrl: "/places/area-seoul-other" })
    const single = pageOf(curated)
    const listed = listPublishedPublicPages([curated, other])
    const entries = buildSitemapEntriesFromPages(listed, "https://example.com")

    expect(single.lastModifiedAt).toBe(ENTRY.contentUpdatedAt)
    expect(listed.find((page) => page.slug === curated.slug)?.lastModifiedAt).toBe(ENTRY.contentUpdatedAt)
    expect(entries.find((entry) => entry.url.endsWith(curated.path))?.lastModified).toBe(ENTRY.contentUpdatedAt)
    expect(entries.find((entry) => entry.url.endsWith(other.path))?.lastModified).toBe(DB_MODIFIED)
    expect(entries.map((entry) => entry.url).sort()).toEqual([`https://example.com${other.path}`, `https://example.com${curated.path}`].sort())
  })

  it("DB 시각이 더 늦으면(이후 FAQ 보정 등) DB 시각을 쓴다", () => {
    const page = pageOf(makeSource({ lastModifiedAt: "2026-12-01T00:00:00+00:00" }))
    expect(page.editorialBody).not.toBeNull()
    expect(page.lastModifiedAt).toBe("2026-12-01T00:00:00+00:00")
  })
})
