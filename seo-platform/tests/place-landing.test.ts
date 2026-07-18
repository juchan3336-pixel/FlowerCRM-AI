import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { PlaceLanding } from "@/components/public/place-landing"
import {
  HERO_INTAKE_NOTICE,
  NON_AFFILIATION_NOTICE,
  PLACE_INFO_NOTICE,
  buildHeroDisclaimer,
  buildPlaceLandingCopy,
  directionalParticle,
  resolvePlaceLandingKind,
  topicParticle,
} from "@/lib/public-seo/landing-copy"
import { buildOrderCtaUrl } from "@/lib/public-seo/order-cta"
import type { PublicPageDto } from "@/lib/public-seo/types"

function makePage(overrides: Partial<PublicPageDto> = {}): PublicPageDto {
  return {
    id: "seo_place_test",
    type: "place",
    slug: "funeral-gyeongnam-test",
    path: "/places/funeral-gyeongnam-test",
    title: "합천추모공원 장례식장 근조화환",
    description: "경남 합천군 장례식장 근조화환 주문 안내입니다.",
    canonicalUrl: "https://seo.example.com/places/funeral-gyeongnam-test",
    priority: 0.8,
    changeFrequency: "weekly",
    lastModifiedAt: "2026-07-15T00:00:00.000Z",
    region: "경남",
    city: "경남",
    district: "합천군",
    address: "경남 합천군 합천읍 합천호수로 1613",
    homepage: null,
    ctaUrl: "https://팔도플라워.com",
    place: { name: "합천추모공원 장례식장", category: "funeral", detailCategory: "장례식장 / 장례식장" },
    content: { faq: [], keywords: [], internalLinks: [] },
    ...overrides,
  }
}

describe("place landing copy mapping", () => {
  it("maps funeral, hospital, and other categories to distinct landing kinds", () => {
    // Given / When / Then: DB 카테고리 값이 랜딩 분기로 매핑된다.
    expect(resolvePlaceLandingKind("funeral")).toBe("funeral")
    expect(resolvePlaceLandingKind("hospital")).toBe("hospital")
    expect(resolvePlaceLandingKind("꽃집")).toBe("general")
    expect(resolvePlaceLandingKind(null)).toBe("general")
  })

  it("keeps situation copy separated by category without mixing", () => {
    // Given: 장례식장·병원·일반 페이지.
    const funeral = buildPlaceLandingCopy(makePage())
    const hospital = buildPlaceLandingCopy(makePage({ place: { name: "테스트병원", category: "hospital", detailCategory: null } }))
    const general = buildPlaceLandingCopy(makePage({ place: { name: "부산 해운대 꽃집", category: "꽃집", detailCategory: "근조화환 전문" } }))
    const generalPathDetail = buildPlaceLandingCopy(makePage({ place: { name: "109디자인", category: "건설회사", detailCategory: "서비스,산업 > 건설,건축 > 인테리어" } }))
    const generalWithoutPlace = buildPlaceLandingCopy(makePage({ place: null, title: "테스트 장소 근조화환" }))

    // Then: 조문 문구는 장례식장에만, 쾌유 문구는 병원에만 나타난다.
    expect(funeral.situationTitle).toBe("조문 화환, 이렇게 보내세요")
    expect(JSON.stringify(funeral.situationItems)).toContain("고인의 명복")
    expect(JSON.stringify(funeral.situationItems)).not.toContain("쾌유")
    expect(JSON.stringify(hospital.situationItems)).toContain("쾌유")
    expect(JSON.stringify(hospital.situationItems)).not.toContain("조문")
    expect(JSON.stringify(general.situationItems)).not.toContain("고인의 명복")
    expect(funeral.productOrder[0]?.name).toBe("근조화환")
    expect(general.productOrder[0]?.name).toBe("축하화환")
    expect(funeral.categoryLabel).toBe("장례식장")
    expect(hospital.categoryLabel).toBe("병원")
    expect(general.categoryLabel).toBe("꽃집 · 근조화환 전문")
    expect(generalPathDetail.categoryLabel).toBe("건설회사 · 인테리어")
    expect(generalWithoutPlace.categoryLabel).toBe("장소 안내")
    expect(generalWithoutPlace.heroTitle).toContain("테스트 장소 근조화환")
  })

  it("selects Korean particles by final consonant", () => {
    // Given / When / Then: 받침 유무에 따라 로/으로, 은/는이 결정된다.
    expect(directionalParticle("장례식장")).toBe("으로")
    expect(directionalParticle("테스트병원")).toBe("으로")
    expect(directionalParticle("빌라")).toBe("로")
    expect(directionalParticle("호텔")).toBe("로")
    expect(topicParticle("장례식장")).toBe("은")
    expect(topicParticle("꽃집스튜디오")).toBe("는")
  })
})

describe("order cta url", () => {
  it("appends only public tracking params without any internal id", () => {
    // Given: 한글 도메인 주문 URL과 장소 정보.
    const url = buildOrderCtaUrl(makePage())

    // Then: 공개 정보만 파라미터로 전달되고 도메인은 원형 그대로다.
    expect(url.startsWith("https://팔도플라워.com?")).toBe(true)
    expect(url).toContain("utm_source=place_page")
    expect(url).toContain(`place_slug=funeral-gyeongnam-test`)
    expect(url).toContain(`place_name=${new URLSearchParams({ v: "합천추모공원 장례식장" }).toString().slice(2)}`)
    expect(url).toContain(`region=${encodeURIComponent("경남")}`)
    expect(url).not.toContain("place_id")
    expect(url).not.toContain("seo_place_test")
  })

  it("appends the product param for category card ctas and respects existing query strings", () => {
    // Given: 이미 쿼리가 있는 주문 URL.
    const url = buildOrderCtaUrl(makePage({ ctaUrl: "https://example.com/order?src=a" }), { product: "근조화환" })

    // Then: &로 이어 붙고 상품 파라미터가 포함된다.
    expect(url.startsWith("https://example.com/order?src=a&")).toBe(true)
    expect(url).toContain(`product=${encodeURIComponent("근조화환")}`)
  })
})

describe("place landing rendering", () => {
  it("renders the funeral landing with approved notices and no delivery guarantees", () => {
    // Given: 장례식장 published 페이지.
    const page = makePage()

    // When: 랜딩을 정적 렌더링한다.
    const markup = renderToStaticMarkup(createElement(PlaceLanding, { page }))

    // Then: 승인 문구(접수 기준·배송지 참고·비제휴 고지·판매처 아님)와 전환 요소가 렌더링된다.
    expect(markup).toContain(HERO_INTAKE_NOTICE)
    expect(markup).toContain(PLACE_INFO_NOTICE)
    expect(markup).toContain(NON_AFFILIATION_NOTICE)
    expect(markup).toContain(buildHeroDisclaimer("합천추모공원 장례식장"))
    expect(markup).toContain("합천추모공원 장례식장으로 보내는 정성스러운 근조화환")
    expect(markup).toContain("화환 주문하기")
    expect(markup).toContain("근조화환")
    expect(markup).toContain("주문은 이렇게 진행됩니다")
    expect(markup).toContain("배송지 참고 정보")
    expect(markup).toContain("자주 묻는 질문")
    // 금지: 확정 표현·제휴 암시가 없다 (‘제휴’ 단어는 비제휴 고지문 안에서만 등장해야 한다).
    expect(markup).not.toContain("당일 배송")
    expect(markup).not.toContain("공식 접수")
    expect(markup).not.toContain("어디든")
    expect(markup.split("제휴").length - 1).toBe(1)
    expect(markup).not.toMatch(/[0-9,]+\s*원/)
  })

  it("renders category-matched webp images with alt text and no typo path", () => {
    // Given: 3개 카테고리 페이지.
    const funeral = renderToStaticMarkup(createElement(PlaceLanding, { page: makePage() }))
    const hospital = renderToStaticMarkup(createElement(PlaceLanding, { page: makePage({ place: { name: "테스트병원", category: "hospital", detailCategory: null } }) }))
    const general = renderToStaticMarkup(createElement(PlaceLanding, { page: makePage({ place: { name: "테스트상사", category: "건설회사", detailCategory: null } }) }))

    // Then: 카테고리별 Hero WebP와 상품 4종 WebP가 alt와 함께 렌더링된다 (next/image는 경로를 URL 인코딩한다).
    const encoded = (path: string) => encodeURIComponent(path)
    expect(funeral).toContain(encoded("/images/place-landing/hero/funeral-hero.webp"))
    expect(hospital).toContain(encoded("/images/place-landing/hero/hospital-hero.webp"))
    expect(general).toContain(encoded("/images/place-landing/hero/general-hero.webp"))
    for (const product of ["funeral-wreath", "celebration-wreath", "opening-plant", "bouquet"]) {
      expect(funeral).toContain(encoded(`/images/place-landing/products/${product}.webp`))
    }
    expect(funeral).toContain('alt="흰 국화 근조화환 3단 스탠드"')
    expect(funeral).toContain('alt="장례식장 로비에 놓인 흰 국화 근조화환"')
    // 오타 경로·원본 파일이 코드 출력에 없어야 한다.
    expect(funeral).not.toContain("place-ianding")
    expect(funeral).not.toContain(encodeURIComponent("place-ianding"))
    expect(funeral).not.toContain("celebration-wreath-source")
    expect(funeral).not.toContain(".png")
    expect(funeral).not.toContain(encodeURIComponent(".png"))
  })

  it("marks every primary order cta with the readability class", () => {
    // Given: 랜딩 전체 렌더 — 전역 `a { color: inherit }` 규칙이 text-white 유틸리티를 덮으므로,
    // Primary CTA는 pl-cta-primary(무레이어 흰색 고정)를 반드시 가져야 한다.
    const markup = renderToStaticMarkup(createElement(PlaceLanding, { page: makePage() }))

    // Then: Hero + 하단 + 모바일 고정 + 상품 카드 4개 = 7곳 전부 적용, secondary(상품 보기)는 미적용.
    expect(markup.split("pl-cta-primary").length - 1).toBe(7)
    const secondaryAnchors = [...markup.matchAll(/<a[^>]*>[^<]*상품 보기/g)].map((match) => match[0])
    expect(secondaryAnchors.length).toBeGreaterThan(0)
    for (const anchor of secondaryAnchors) {
      expect(anchor).not.toContain("pl-cta-primary")
    }
  })

  it("renders the mobile sticky cta bar with order and product links", () => {
    // Given: published 페이지.
    const markup = renderToStaticMarkup(createElement(PlaceLanding, { page: makePage() }))

    // Then: 하단 고정 CTA 바가 모바일 전용으로 렌더링된다.
    expect(markup).toContain("sm:hidden")
    expect(markup).toContain("fixed inset-x-0 bottom-0")
    expect(markup).toContain("#place-products")
  })

  it("falls back to default faq copy when the page has no faq content", () => {
    // Given: FAQ가 비어 있는 페이지.
    const markup = renderToStaticMarkup(createElement(PlaceLanding, { page: makePage() }))

    // Then: 기본 FAQ 5문이 렌더링되고 미확정 답변(가격 표기)이 없다.
    expect(markup).toContain("주문은 어떻게 하나요?")
    expect(markup).toContain("장소명이 검색되지 않을 때는 어떻게 하나요?")
    expect(markup).not.toMatch(/[0-9,]+\s*원/)
  })
})
