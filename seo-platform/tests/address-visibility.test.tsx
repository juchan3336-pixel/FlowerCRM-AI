import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { PlaceLanding } from "@/components/public/place-landing"
import { COARSE_ADDRESS_OFFICIAL_SITE_NOTICE, coarsePublicAddress, isCoarseAddressOnlySlug, resolvePublicAddress } from "@/lib/public-seo/address-visibility"
import { buildJsonLdObjects, findPublicPageByTypeAndSlug } from "@/lib/public-seo/public-pages"
import type { PublicSeoSource } from "@/lib/public-seo/types"

const NAMHAE_SLUG = "funeral-gyeongnam-namhaegun-namhaebyeongwon-jangryesikjang"
const NAMHAE_DB_ADDRESS = "경남 남해군 남해읍 화전로 175 (우)52417"

function mustFindPage(page: ReturnType<typeof findPublicPageByTypeAndSlug>): NonNullable<ReturnType<typeof findPublicPageByTypeAndSlug>> {
  if (page === undefined) {
    throw new Error("published page fixture was not resolved")
  }
  return page
}

function makeSource(overrides: Partial<PublicSeoSource>): PublicSeoSource {
  return {
    id: "page-namhae",
    type: "place",
    slug: NAMHAE_SLUG,
    path: `/places/${NAMHAE_SLUG}`,
    status: "published",
    title: "남해병원 장례식장 근조화환 보내기 전 확인 정보",
    description: "경남 남해군 남해읍 남해병원 장례식장으로 근조화환을 보낼 때 확인할 주문 정보를 안내합니다.",
    canonicalUrl: `https://flowercrm-seo.vercel.app/places/${NAMHAE_SLUG}`,
    priority: 0.7,
    changeFrequency: "weekly",
    lastModifiedAt: "2026-07-20T09:00:00.000Z",
    region: "경남",
    city: "경남",
    district: "남해군",
    address: NAMHAE_DB_ADDRESS,
    homepage: "http://nhfuneral.net/main.php",
    ctaUrl: null,
    place: { name: "남해병원 장례식장", category: "funeral", detailCategory: "장례식장" },
    content: {
      faq: [
        { question: "빈소명을 모를 때 어떻게 확인하나요?", answer: "장례식장 측 또는 해당 장소 홈페이지에서 확인할 수 있습니다." },
        { question: "비슷한 이름의 장소와 구분하는 방법은 무엇인가요?", answer: "공식 홈페이지 정보를 참고해 구분할 수 있습니다." },
      ],
      keywords: ["남해병원 장례식장"],
      internalLinks: [],
    },
    ...overrides,
  }
}

describe("공개 주소 축약 정책", () => {
  it("coarses the verified address down to eup level only", () => {
    // Given / When / Then: 도로명·번지·우편번호가 제거되고 읍 단위까지만 남는다.
    expect(coarsePublicAddress(NAMHAE_DB_ADDRESS)).toBe("경남 남해군 남해읍")
    expect(coarsePublicAddress("경남 남해군 남해읍 화전로 169")).toBe("경남 남해군 남해읍")
    expect(coarsePublicAddress(null)).toBeNull()
  })

  it("applies the policy only to the explicitly approved slug", () => {
    // Given / When / Then: 승인 slug만 축약되고 다른 slug는 원본 주소 유지.
    expect(isCoarseAddressOnlySlug(NAMHAE_SLUG)).toBe(true)
    expect(isCoarseAddressOnlySlug("funeral-daegu-dalseogu-daegubohunbyeongwon-jangryesikjang")).toBe(false)
    expect(resolvePublicAddress(NAMHAE_SLUG, NAMHAE_DB_ADDRESS)).toBe("경남 남해군 남해읍")
    expect(resolvePublicAddress("funeral-gyeongnam-geojesi-daeubyeongwon-jangryesikjang", "경남 거제시 두모길 16 (우)53317")).toBe("경남 거제시 두모길 16 (우)53317")
  })

  it("returns the coarse address through the public DTO and JSON-LD without leaking details", () => {
    // Given: DB 주소(화전로 175)를 가진 남해 published 레코드.
    const page = mustFindPage(findPublicPageByTypeAndSlug([makeSource({})], "place", NAMHAE_SLUG))

    // Then: 공개 DTO·JSON-LD 모두 축약 주소만 노출한다.
    expect(page.address).toBe("경남 남해군 남해읍")
    const jsonLd = JSON.stringify(buildJsonLdObjects(page))
    expect(jsonLd).toContain("경남 남해군 남해읍")
    for (const banned of ["화전로 175", "화전로 169", "52417", "화전로"]) {
      expect(page.address).not.toContain(banned)
      expect(jsonLd).not.toContain(banned)
    }
  })

  it("keeps full addresses for non-target published places", () => {
    // Given: 비대상 slug(6호점 유형) 레코드.
    const source = makeSource({
      id: "page-bohun",
      slug: "funeral-daegu-dalseogu-daegubohunbyeongwon-jangryesikjang",
      path: "/places/funeral-daegu-dalseogu-daegubohunbyeongwon-jangryesikjang",
      canonicalUrl: "https://flowercrm-seo.vercel.app/places/funeral-daegu-dalseogu-daegubohunbyeongwon-jangryesikjang",
      address: "대구 달서구 월곡로 60 (지번) 도원동 748",
      place: { name: "대구보훈병원 장례식장", category: "funeral", detailCategory: "장례식장" },
    })

    // When / Then: 주소가 축약 없이 그대로 유지된다 (기존 1~6호점 회귀 없음).
    const page = mustFindPage(findPublicPageByTypeAndSlug([source], "place", source.slug))
    expect(page.address).toBe("대구 달서구 월곡로 60 (지번) 도원동 748")
    expect(JSON.stringify(buildJsonLdObjects(page))).toContain("월곡로 60")
  })

  it("renders the coarse address and official-site notice on the landing for the target place only", () => {
    // Given: 남해 랜딩과 비대상 랜딩.
    const namhae = mustFindPage(findPublicPageByTypeAndSlug([makeSource({})], "place", NAMHAE_SLUG))
    const namhaeMarkup = renderToStaticMarkup(<PlaceLanding page={namhae} />)
    const other = findPublicPageByTypeAndSlug(
      [makeSource({ id: "p2", slug: "funeral-daegu-dalseogu-daegubohunbyeongwon-jangryesikjang", path: "/places/x", canonicalUrl: "https://example.com/places/x", address: "대구 달서구 월곡로 60 (지번) 도원동 748" })],
      "place",
      "funeral-daegu-dalseogu-daegubohunbyeongwon-jangryesikjang",
    )
    const otherMarkup = renderToStaticMarkup(<PlaceLanding page={mustFindPage(other)} />)

    // Then: 남해는 축약 주소 + 공식 사이트 안내, 비대상은 원본 주소·안내 없음.
    expect(namhaeMarkup).toContain("경남 남해군 남해읍")
    expect(namhaeMarkup).not.toContain("화전로")
    expect(namhaeMarkup).not.toContain("52417")
    expect(namhaeMarkup).toContain(COARSE_ADDRESS_OFFICIAL_SITE_NOTICE)
    expect(otherMarkup).toContain("월곡로 60")
    expect(otherMarkup).not.toContain(COARSE_ADDRESS_OFFICIAL_SITE_NOTICE)
  })

  it("keeps canonical url and CTA untouched by the address policy", () => {
    // Given / When: 남해 DTO.
    const page = mustFindPage(findPublicPageByTypeAndSlug([makeSource({})], "place", NAMHAE_SLUG))

    // Then: canonical·CTA는 정책의 영향을 받지 않는다.
    expect(page.canonicalUrl).toBe(`https://flowercrm-seo.vercel.app/places/${NAMHAE_SLUG}`)
    const markup = renderToStaticMarkup(<PlaceLanding page={page} />)
    expect(markup).toContain("화환 주문하기")
    expect(markup).toContain(`place_slug=${NAMHAE_SLUG}`)
  })
})
