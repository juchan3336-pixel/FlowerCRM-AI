// 검수 편집 본문 계약.
// 사람이 공식 출처와 대조해 쓴 본문을 코드에 두고, 지금 게시된 페이지와 식별자가 모두 같을 때만 화면에 싣는다.
// 다른 시설에 붙거나, 검수하지 않은 페이지의 본문이 함께 열리거나, 금지 표현이 섞여 들어가면 안 된다.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { PlaceLanding } from "@/components/public/place-landing"
import { scanBannedExpressionsInFields } from "@/lib/ai/content-quality"
import { findForbiddenModeVocabularyInFields } from "@/lib/ai/mode-vocabulary"
import { applyCuratedFaqAnswerEdits, CURATED_EDITORIAL_BODIES, CURATED_FAQ_ANSWER_EDITS, CURATED_POLICY_NOTES, findCuratedEditorialBody, findCuratedPolicyNote, isRenderableSourceUrl, laterIsoTimestamp, latestIsoTimestamp } from "@/lib/public-seo/curated-editorial"
import { buildJsonLdObjects, buildSitemapEntriesFromPages, findPublicPageByTypeAndSlug, listPublishedPublicPages } from "@/lib/public-seo/public-pages"
import type { PublicSeoSource } from "@/lib/public-seo/types"

const ENTRY = CURATED_EDITORIAL_BODIES.find((entry) => entry.placeName === "성균관컨벤션웨딩홀")
if (ENTRY === undefined) {
  throw new Error("fixture entry missing")
}
const LEGACY_SLUGS = [
  "area-gyeongnam-changwonsi-riberakeonbensyeon",
  "area-gyeongnam-yangsansi-wweding-yangsanjeom",
  "funeral-gyeongnam-jinjusi-jinjujungangbyeongwon-jangryesikjang",
  "funeral-gyeongbuk-andongsi-andongjeonmunjangryesikjang",
]
// 2026-09에 DB에 넣었던 본문의 위험 문장 — 어떤 경우에도 다시 화면에 나오면 안 된다.
const LEGACY_RISKY_DB_BODY = "주문서에 위 정보를 입력하시면 예식 시작 전에 도착하도록 접수되며, 접수 후 진행 상황을 안내해 드립니다.\n\n근조화환은 빈소 앞으로 전달되므로 호실을 확인해 주세요."
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

  it("2026-09 1차 4곳은 모두 편집본을 갖는다 (도착·전달 단정 문장을 대체)", () => {
    for (const slug of LEGACY_SLUGS) {
      expect(CURATED_EDITORIAL_BODIES.some((entry) => entry.slug === slug), slug).toBe(true)
    }
  })

  it("편집 시각은 미래가 아니다 — sitemap의 수정 시각이 된다", () => {
    for (const entry of [...CURATED_EDITORIAL_BODIES, ...CURATED_FAQ_ANSWER_EDITS]) {
      expect(Date.parse(entry.contentUpdatedAt), entry.slug).toBeLessThanOrEqual(Date.now())
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

  it("편집 맵에 없는 페이지는 본문 영역이 없다", () => {
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

  it("편집이 여럿이면(본문·FAQ 답변) 그중 가장 늦은 시각을 쓴다", () => {
    const db = "2026-11-10T08:00:00+00:00"
    expect(latestIsoTimestamp(db, [])).toBe(db)
    expect(latestIsoTimestamp(db, ["2026-11-10T09:00:00.000Z", "2026-11-10T11:00:00.000Z"])).toBe("2026-11-10T11:00:00.000Z")
    expect(latestIsoTimestamp(db, ["2026-11-10T11:00:00.000Z", "2026-11-10T09:00:00.000Z"])).toBe("2026-11-10T11:00:00.000Z")
    expect(latestIsoTimestamp("2026-11-12T00:00:00+00:00", ["2026-11-10T11:00:00.000Z"])).toBe("2026-11-12T00:00:00+00:00")
    expect(latestIsoTimestamp(db, ["not a time", "2026-11-10T09:00:00.000Z"])).toBe("2026-11-10T09:00:00.000Z")
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

// 편집본의 식별자가 맞지 않게 됐을 때 옛 DB 본문으로 되돌아가면, 대체한 위험 문장이 다시 공개된다.
describe("1차 4곳 — 식별자가 어긋나면 본문 영역 전체가 사라진다 (옛 DB 본문으로 돌아가지 않는다)", () => {
  const legacyEntries = CURATED_EDITORIAL_BODIES.filter((entry) => LEGACY_SLUGS.includes(entry.slug))
  const legacySource = (entry: (typeof legacyEntries)[number], overrides: Partial<PublicSeoSource> = {}): PublicSeoSource =>
    makeSource({
      id: entry.seoPageId,
      slug: entry.slug,
      path: `/places/${entry.slug}`,
      canonicalUrl: `/places/${entry.slug}`,
      place: { name: entry.placeName, category: entry.slug.startsWith("funeral-") ? "funeral" : "숙박/행사", detailCategory: null },
      placeBody: LEGACY_RISKY_DB_BODY,
      content: { faq: [], keywords: [], internalLinks: [] },
      ...overrides,
    })

  it("대상은 4곳이다", () => {
    expect(legacyEntries.map((entry) => entry.slug).sort()).toEqual([...LEGACY_SLUGS].sort())
  })

  it.each(legacyEntries.map((entry) => [entry.placeName, entry] as const))("%s: 식별자가 맞으면 편집본만 보인다", (_name, entry) => {
    const visible = text(renderToStaticMarkup(createElement(PlaceLanding, { page: pageOf(legacySource(entry)) })))
    expect(visible).toContain(entry.paragraphs[0] ?? "")
    expect(visible).not.toContain("도착하도록 접수")
    expect(visible).not.toContain("빈소 앞으로 전달")
  })

  const MISMATCHES: readonly (readonly [string, (entry: (typeof legacyEntries)[number]) => Partial<PublicSeoSource>])[] = [
    ["SEO 페이지 ID가 다름", () => ({ id: "00000000-0000-4000-8000-000000000000" })],
    ["장소명이 다름", (entry) => ({ place: { name: `${entry.placeName} 신관`, category: "funeral", detailCategory: null } })],
    ["DB에서 온 페이지가 아님", () => ({ dataOrigin: "fixture" as const })],
  ]
  it.each(legacyEntries.flatMap((entry) => MISMATCHES.map(([label, make]) => [entry.placeName, label, entry, make] as const)))("%s · %s → 편집 문단·DB 위험 문단·본문 영역 모두 없음, 수정 시각 불변", (_name, _label, entry, make) => {
    const page = pageOf(legacySource(entry, make(entry)))
    const markup = renderToStaticMarkup(createElement(PlaceLanding, { page }))
    const visible = text(markup)

    expect(page.editorialBody).toBeNull()
    expect(markup).not.toContain('id="place-body-heading"')
    expect(visible).not.toContain(entry.paragraphs[2] ?? "")
    expect(visible).not.toContain("도착하도록 접수")
    expect(visible).not.toContain("빈소 앞으로 전달")
    expect(page.lastModifiedAt).toBe(DB_MODIFIED)
  })
})

describe("FAQ 답변 편집 (1차 4곳, 6개 답변)", () => {
  const OTHER = { question: "리본 문구는 어떻게 작성하나요?", answer: "주문서에 입력하시면 리본으로 제작됩니다." }
  const editsFor = (slug: string) => CURATED_FAQ_ANSWER_EDITS.filter((edit) => edit.slug === slug)
  // 저장된 FAQ 재현: 편집 대상 index에는 기대 원문을, 나머지에는 다른 항목을 둔다.
  const storedFaq = (slug: string) => {
    const edits = editsFor(slug)
    const length = Math.max(...edits.map((edit) => edit.faqIndex)) + 1
    return Array.from({ length }, (_unused, index) => {
      const edit = edits.find((candidate) => candidate.faqIndex === index)
      return edit === undefined ? { question: `${OTHER.question} (${String(index)})`, answer: OTHER.answer } : { question: edit.expectedQuestion, answer: edit.expectedAnswer }
    })
  }
  const sourceFor = (slug: string, overrides: Partial<PublicSeoSource> = {}): PublicSeoSource => {
    const edit = editsFor(slug)[0]
    if (edit === undefined) {
      throw new Error("edit missing")
    }
    return makeSource({
      id: edit.seoPageId,
      slug,
      path: `/places/${slug}`,
      canonicalUrl: `/places/${slug}`,
      address: "경남 창원시 성산구 중앙대로100번길 9 (우)51495",
      place: { name: edit.placeName, category: slug.startsWith("funeral-") ? "funeral" : "숙박/행사", detailCategory: null },
      placeBody: null,
      content: { faq: storedFaq(slug), keywords: [], internalLinks: [] },
      ...overrides,
    })
  }

  it("대상은 4곳의 6개 답변이고, 대체 문구에 금지 표현이 없다", () => {
    expect(CURATED_FAQ_ANSWER_EDITS).toHaveLength(6)
    expect([...new Set(CURATED_FAQ_ANSWER_EDITS.map((edit) => edit.slug))].sort()).toEqual([...LEGACY_SLUGS].sort())
    expect(new Set(CURATED_FAQ_ANSWER_EDITS.map((edit) => `${edit.slug}#${String(edit.faqIndex)}`)).size).toBe(6)
    for (const edit of CURATED_FAQ_ANSWER_EDITS) {
      expect(scanBannedExpressionsInFields([{ field: "answer", text: edit.replacementAnswer }]).map((issue) => issue.code), edit.slug).toEqual([])
      expect(edit.replacementAnswer, edit.slug).toMatch(/(예식장|장례식장)에 직접 확인/)
      expect(edit.replacementAnswer, edit.slug).not.toMatch(/도착하도록 접수|일정에 맞춰 접수|배송이 진행되며|보장/)
      expect(edit.reason.trim().length, edit.slug).toBeGreaterThan(0)
      const mode = edit.slug.startsWith("funeral-") ? "condolence" : "celebration"
      expect(findForbiddenModeVocabularyInFields({ fields: [{ field: "answer", text: edit.replacementAnswer }], mode, placeName: edit.placeName, regionTokens: [] }), edit.slug).toEqual([])
    }
  })

  it.each(LEGACY_SLUGS)("%s: 화면과 FAQ JSON-LD에서 대상 답변만 새 문구가 되고 나머지는 그대로다", (slug) => {
    const edits = editsFor(slug)
    const stored = storedFaq(slug)
    const page = pageOf(sourceFor(slug))
    const markup = renderToStaticMarkup(createElement(PlaceLanding, { page }))
    const jsonLd = JSON.stringify(buildJsonLdObjects(page).find((object) => object["@type"] === "FAQPage"))

    expect(page.content.faq).toHaveLength(stored.length)
    stored.forEach((entry, index) => {
      const edit = edits.find((candidate) => candidate.faqIndex === index)
      expect(page.content.faq[index]?.question).toBe(entry.question)
      expect(page.content.faq[index]?.answer).toBe(edit === undefined ? entry.answer : edit.replacementAnswer)
    })
    for (const edit of edits) {
      expect(text(markup)).toContain(edit.replacementAnswer)
      expect(jsonLd).toContain(edit.replacementAnswer)
      expect(text(markup)).not.toContain("도착하도록 접수")
      expect(jsonLd).not.toContain("도착하도록 접수")
      expect(jsonLd).not.toContain("배송이 진행되며")
    }
    // 답변 편집 시각이 수정 시각에 반영된다.
    expect(page.lastModifiedAt).toBe(edits[0]?.contentUpdatedAt)
  })

  it("입력 배열을 바꾸지 않는다", () => {
    const slug = LEGACY_SLUGS[0] ?? ""
    const stored = storedFaq(slug)
    const snapshot = structuredClone(stored)
    const edit = editsFor(slug)[0]
    applyCuratedFaqAnswerEdits({ slug, seoPageId: edit?.seoPageId ?? "", placeName: edit?.placeName ?? null }, stored)
    expect(stored).toEqual(snapshot)
  })

  describe("기대값이 어긋나면 아무것도 바꾸지 않는다", () => {
    const slug = LEGACY_SLUGS[0] ?? ""
    const edit = editsFor(slug)[0]
    if (edit === undefined) {
      throw new Error("edit missing")
    }
    const stored = storedFaq(slug)
    const withAt = (index: number, entry: { question: string; answer: string }) => stored.map((original, position) => (position === index ? entry : original))

    it.each([
      ["SEO 페이지 ID가 다름", { id: "00000000-0000-4000-8000-000000000000" }],
      ["장소명이 다름", { place: { name: "다른 예식장", category: "숙박/행사", detailCategory: null } }],
      ["DB에서 온 페이지가 아님", { dataOrigin: "fixture" as const }],
    ])("%s", (_label, overrides) => {
      const page = pageOf(sourceFor(slug, overrides))
      expect(page.content.faq.map((entry) => entry.answer)).toEqual(stored.map((entry) => entry.answer))
      expect(page.lastModifiedAt).toBe(DB_MODIFIED)
    })

    it("그 index의 질문이 달라졌으면 바꾸지 않는다", () => {
      const faq = withAt(edit.faqIndex, { question: "다른 질문인가요?", answer: edit.expectedAnswer })
      const page = pageOf(sourceFor(slug, { content: { faq, keywords: [], internalLinks: [] } }))
      expect(page.content.faq[edit.faqIndex]?.answer).toBe(edit.expectedAnswer)
    })

    it("그 index의 답변이 이미 달라졌으면(다른 경로로 고쳐졌으면) 덮지 않는다", () => {
      const faq = withAt(edit.faqIndex, { question: edit.expectedQuestion, answer: "누군가 이미 고친 답변입니다." })
      const page = pageOf(sourceFor(slug, { content: { faq, keywords: [], internalLinks: [] } }))
      expect(page.content.faq[edit.faqIndex]?.answer).toBe("누군가 이미 고친 답변입니다.")
    })

    it("순서가 밀려 같은 질문이 다른 index에 있어도 그 항목을 바꾸지 않는다", () => {
      const shifted = [{ question: "새로 끼어든 질문인가요?", answer: "새 답변입니다." }, ...stored]
      const page = pageOf(sourceFor(slug, { content: { faq: shifted, keywords: [], internalLinks: [] } }))
      expect(page.content.faq.map((entry) => entry.answer)).toEqual(shifted.map((entry) => entry.answer))
      // 적용된 FAQ 편집이 없다 — 수정 시각을 올리는 것은 (식별자가 맞아 붙은) 편집 본문뿐이다.
      expect(applyCuratedFaqAnswerEdits({ slug, seoPageId: edit.seoPageId, placeName: edit.placeName }, shifted).applied).toEqual([])
    })

    it("일부만 맞으면 맞는 답변만 바꾼다", () => {
      const edits = editsFor(slug)
      const second = edits[1]
      if (second === undefined) {
        throw new Error("second edit missing")
      }
      const faq = withAt(second.faqIndex, { question: second.expectedQuestion, answer: "이미 고친 답변" })
      const page = pageOf(sourceFor(slug, { content: { faq, keywords: [], internalLinks: [] } }))
      expect(page.content.faq[edit.faqIndex]?.answer).toBe(edit.replacementAnswer)
      expect(page.content.faq[second.faqIndex]?.answer).toBe("이미 고친 답변")
    })
  })

  it("기대값은 저장 원문 기준이다 — 주소 표기 정리는 편집 뒤에 적용된다", () => {
    // 리베라컨벤션 반입 위치 답변의 기대 원문에는 주소가 들어 있다. 저장 주소에 꼬리가 붙어 있어도(정리 대상) 편집이 먼저 맞아야 한다.
    const slug = "area-gyeongnam-changwonsi-riberakeonbensyeon"
    const access = editsFor(slug).find((edit) => edit.expectedQuestion.includes("반입"))
    if (access === undefined) {
      throw new Error("access edit missing")
    }
    const page = pageOf(sourceFor(slug))
    expect(access.expectedAnswer).toContain("경남 창원시 성산구 중앙대로100번길 9")
    expect(page.content.faq[access.faqIndex]?.answer).toBe(access.replacementAnswer)
    // 편집하지 않은 항목의 주소 표기 정리는 그대로 동작한다.
    const raw = "경남 창원시 성산구 중앙대로100번길 9 (우)51495"
    const untouched = pageOf(sourceFor(slug, { content: { faq: [{ question: "주소가 어디인가요?", answer: `주소는 ${raw}입니다.` }], keywords: [], internalLinks: [] } }))
    expect(untouched.content.faq[0]?.answer).toBe("주소는 경남 창원시 성산구 중앙대로100번길 9입니다.")
  })

  it("canonical·제목·설명·sitemap URL 집합은 FAQ 편집과 무관하다", () => {
    const slug = LEGACY_SLUGS[0] ?? ""
    const edited = pageOf(sourceFor(slug))
    const plain = pageOf(sourceFor(slug, { id: "00000000-0000-4000-8000-000000000000" }))
    expect(edited.canonicalUrl).toBe(plain.canonicalUrl)
    expect(edited.title).toBe(plain.title)
    expect(edited.description).toBe(plain.description)
    const urls = (source: PublicSeoSource) => buildSitemapEntriesFromPages(listPublishedPublicPages([source]), "https://example.com").map((entry) => entry.url)
    expect(urls(sourceFor(slug))).toEqual(urls(sourceFor(slug, { id: "00000000-0000-4000-8000-000000000000" })))
  })
})

// 공식 사이트의 과거 공지를 현재 규정처럼 옮기지 않는다 — 작성일을 밝히고, 확인되지 않는 것을 함께 적는다.
describe("시설별 정책 참고 메모", () => {
  const NOTE = CURATED_POLICY_NOTES[0]
  if (NOTE === undefined) {
    throw new Error("note missing")
  }
  const noteSource = (overrides: Partial<PublicSeoSource> = {}): PublicSeoSource =>
    makeSource({
      id: NOTE.seoPageId,
      slug: NOTE.slug,
      path: `/places/${NOTE.slug}`,
      canonicalUrl: `/places/${NOTE.slug}`,
      place: { name: NOTE.placeName, category: "숙박/행사", detailCategory: "웨딩홀 / 예식장" },
      placeBody: null,
      lastModifiedAt: "2026-08-10T02:36:03.065569+00:00",
      ...overrides,
    })

  it("형식이 맞고, 과거 공지임과 확인되지 않는 범위를 함께 적는다", () => {
    for (const note of CURATED_POLICY_NOTES) {
      expect(note.seoPageId, note.slug).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(note.sourcePublishedAt, note.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(note.reviewedAt, note.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(Date.parse(note.sourcePublishedAt), note.slug).toBeLessThan(Date.parse(note.reviewedAt))
      expect(Date.parse(note.contentUpdatedAt), note.slug).toBeLessThanOrEqual(Date.now())
      expect(isRenderableSourceUrl(note.source.url), note.slug).toBe(true)
      const body = note.lines.join(" ")
      // 공지 작성 연도를 문장에 밝힌다.
      expect(body, note.slug).toContain(`${note.sourcePublishedAt.slice(0, 4)}년`)
      expect(body, note.slug).toContain("확인되지 않습니다")
      expect(body, note.slug).toMatch(/(예식장|장례식장|시설)에 [^.]*직접 확인/)
      // 과거 공지를 현재 규정으로 단정하지 않는다.
      for (const pattern of [/반입(이|은)? ?(불가|금지)/, /만 (받습니다|가능합니다)/, /반입(이|은)? ?가능합니다/, /시행하고 있습니다/, /보장/, /\d{2,4}-\d{3,4}-\d{4}/]) {
        expect(pattern.test(body), `${note.slug}: ${String(pattern)}`).toBe(false)
      }
      expect(scanBannedExpressionsInFields(note.lines.map((line, index) => ({ field: `line[${String(index)}]`, text: line }))).map((issue) => issue.code), note.slug).toEqual([])
    }
  })

  it("반입 확인 안내 안에 메모·출처 링크·확인일을 보이고, 일반 안내는 그대로 둔다", () => {
    const page = pageOf(noteSource())
    const markup = renderToStaticMarkup(createElement(PlaceLanding, { page }))
    const visible = text(markup)

    expect(markup).toContain('id="venue-policy-note"')
    for (const line of NOTE.lines) {
      expect(visible).toContain(line)
    }
    expect(markup).toContain(`href="${NOTE.source.url.replace(/&/g, "&amp;")}"`)
    expect(visible).toContain(`확인일 ${NOTE.reviewedAt}`)
    expect(visible).toContain("주문 전에 예식장에 반입 가능 여부")
    // 메모는 반입 확인 안내 영역 안에 있다.
    expect(markup.indexOf('id="venue-policy-note"')).toBeGreaterThan(markup.indexOf('id="venue-policy"'))
    // 본문 영역을 새로 만들지 않고, JSON-LD에도 싣지 않는다.
    expect(markup).not.toContain('id="place-body-heading"')
    expect(JSON.stringify(buildJsonLdObjects(page))).not.toContain("쌀화환")
    expect(page.lastModifiedAt).toBe(NOTE.contentUpdatedAt)
  })

  it.each([
    ["SEO 페이지 ID가 다름", { id: "00000000-0000-4000-8000-000000000000" }],
    ["장소명이 다름", { place: { name: "스카이뷰호텔", category: "숙박/행사", detailCategory: null } }],
    ["DB에서 온 페이지가 아님", { dataOrigin: "fixture" as const }],
  ])("%s → 메모를 붙이지 않고 수정 시각도 그대로다", (_label, overrides) => {
    const page = pageOf(noteSource(overrides))
    const markup = renderToStaticMarkup(createElement(PlaceLanding, { page }))
    expect(page.policyNote).toBeNull()
    expect(markup).not.toContain('id="venue-policy-note"')
    expect(text(markup)).not.toContain("쌀화환")
    expect(page.lastModifiedAt).toBe("2026-08-10T02:36:03.065569+00:00")
  })

  it("메모가 없는 페이지에는 나타나지 않는다", () => {
    const markup = renderToStaticMarkup(createElement(PlaceLanding, { page: pageOf(makeSource()) }))
    expect(markup).not.toContain('id="venue-policy-note"')
    expect(findCuratedPolicyNote({ slug: "area-seoul-other", seoPageId: NOTE.seoPageId, placeName: NOTE.placeName })).toBeNull()
  })

  it("FAQ·canonical·제목·sitemap URL 집합은 메모와 무관하다", () => {
    const withNote = pageOf(noteSource())
    const without = pageOf(noteSource({ id: "00000000-0000-4000-8000-000000000000" }))
    expect(withNote.content).toEqual(without.content)
    expect(withNote.canonicalUrl).toBe(without.canonicalUrl)
    expect(withNote.title).toBe(without.title)
    const urls = (source: PublicSeoSource) => buildSitemapEntriesFromPages(listPublishedPublicPages([source]), "https://example.com").map((entry) => entry.url)
    expect(urls(noteSource())).toEqual(urls(noteSource({ id: "00000000-0000-4000-8000-000000000000" })))
  })
})
