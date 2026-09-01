// 지역×업종 허브 (P1) — 지역 정규화·업종 판정·자동 그룹핑·관련 장소·sitemap 계약.
import { describe, expect, it } from "vitest"

import {
  buildHubIndexSitemapEntry,
  buildHubSitemapEntries,
  findHubBySlug,
  HUB_INDEX_PATH,
  HUB_INDEX_TITLE,
  listActiveHubSummaries,
  groupPagesByHub,
  hubActivation,
  hubForPage,
  hubMemberAnchor,
  hubPath,
  hubTitle,
  P1_HUBS,
  pickRelatedPlaces,
  RELATED_PLACES_LIMIT,
  resolveHubType,
  resolveSidoCode,
} from "@/lib/public-seo/region-hub"
import { buildHubCopy } from "@/lib/public-seo/hub-copy"
import { buildJsonLdObjects } from "@/lib/public-seo/public-pages"
import type { PublicPageDto } from "@/lib/public-seo/types"

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

describe("지역 정규화 resolver", () => {
  it("resolves 시/도 aliases from the region field (약칭·정식 명칭·광역시)", () => {
    expect(resolveSidoCode({ region: "경남", district: null, address: null })).toBe("gyeongnam")
    expect(resolveSidoCode({ region: "경상남도", district: null, address: null })).toBe("gyeongnam")
    expect(resolveSidoCode({ region: "경상북도", district: null, address: null })).toBe("gyeongbuk")
    expect(resolveSidoCode({ region: "대구광역시", district: null, address: null })).toBe("daegu")
    expect(resolveSidoCode({ region: "울산광역시", district: null, address: null })).toBe("ulsan")
    expect(resolveSidoCode({ region: "부산광역시", district: null, address: null })).toBe("busan")
  })

  it("falls back to the address when the region field is a city name — 아이스퀘어호텔 케이스", () => {
    // region="김해"(시/도 아님) + 주소가 경남으로 시작 → 경남.
    expect(resolveSidoCode({ region: "김해", district: "김해시", address: "경남 김해시 김해대로 2232" })).toBe("gyeongnam")
    expect(resolveSidoCode({ region: null, district: "남구", address: "울산 남구 삼산로 226" })).toBe("ulsan")
    // 첫 토큰이 아니어도 주소 안의 시/도 별칭을 찾는다.
    expect(resolveSidoCode({ region: "김해", district: null, address: "대한민국 경상남도 김해시" })).toBe("gyeongnam")
  })

  it("returns null when nothing resolves — 허브 제외 대상 (업체명은 판정 입력이 아니다)", () => {
    expect(resolveSidoCode({ region: "미상", district: null, address: "주소 없음" })).toBeNull()
    expect(resolveSidoCode({ region: null, district: null, address: null })).toBeNull()
  })
})

describe("허브 업종 resolver — contentMode 재사용", () => {
  it("maps condolence to funeral and corporate-celebration to corporate", () => {
    expect(resolveHubType({ name: "안동병원 장례식장", category: "funeral" })).toBe("funeral")
    expect(resolveHubType({ name: "KPX케미칼 울산공장", category: "제조" })).toBe("corporate")
  })

  it("keeps celebration places only with wedding-venue evidence in the name", () => {
    expect(resolveHubType({ name: "MH컨벤션웨딩홀", category: "숙박/행사" })).toBe("wedding")
    expect(resolveHubType({ name: "W웨딩 양산점", category: "숙박/행사" })).toBe("wedding")
    // 일반 호텔 — 예식장 근거 없음 → 허브 대상 아님.
    expect(resolveHubType({ name: "아이스퀘어호텔", category: "호텔" })).toBeNull()
    // 펜션 분리 정책 유지 — 어떤 경로로든 남아 있어도 허브에 넣지 않는다.
    expect(resolveHubType({ name: "까사까미노펜션", category: "숙박/행사" })).toBeNull()
    // 모드 미지원 업종.
    expect(resolveHubType({ name: "부산대학교병원", category: "hospital" })).toBeNull()
  })
})

const GYEONGNAM_FUNERAL = pageDto({ slug: "f-gn-1", name: "창원중앙장례식장", category: "funeral", region: "경남", district: "창원시", address: "경남 창원시 성산구 1" })
const GYEONGNAM_FUNERAL_2 = pageDto({ slug: "f-gn-2", name: "김해시민장례식장", category: "funeral", region: "경남", district: "김해시", address: "경남 김해시 2" })
const DAEGU_FUNERAL = pageDto({ slug: "f-dg-1", name: "곽병원 장례식장", category: "funeral", region: "대구", district: "중구", address: "대구 중구 3" })
const GYEONGNAM_WEDDING = pageDto({ slug: "w-gn-1", name: "리베라컨벤션", category: "숙박/행사", region: "경남", district: "창원시", address: "경남 창원시 성산구 9" })
const ULSAN_CORPORATE = pageDto({ slug: "c-us-1", name: "KPX케미칼 울산공장", category: "제조", region: "울산", district: "남구", address: "울산 남구 4" })
const ICSQUARE_HOTEL = pageDto({ slug: "h-gn-1", name: "아이스퀘어호텔", category: "호텔", region: "김해", district: "김해시", address: "경남 김해시 김해대로 2232" })
const GYEONGGI_FUNERAL = pageDto({ slug: "f-gg-1", name: "가평장례식장", category: "funeral", region: "경기", district: "가평군", address: "경기 가평군 5" })
const FIXTURE_PAGE = pageDto({ slug: "fixture-1", name: "합성장례식장", category: "funeral", region: "경남", district: "창원시", dataOrigin: "fixture" })

describe("published 자동 그룹핑", () => {
  it("groups published places into their P1 hubs and excludes fixtures entirely", () => {
    const { byHub, diagnostics } = groupPagesByHub([GYEONGNAM_FUNERAL, GYEONGNAM_FUNERAL_2, DAEGU_FUNERAL, GYEONGNAM_WEDDING, ULSAN_CORPORATE, FIXTURE_PAGE])
    expect(byHub.get("funeral-gyeongnam")?.map((page) => page.slug)).toEqual(["f-gn-2", "f-gn-1"]) // 시/군/구 가나다 정렬
    expect(byHub.get("funeral-daegu")).toHaveLength(1)
    expect(byHub.get("wedding-gyeongnam")).toHaveLength(1)
    expect(byHub.get("corporate-ulsan")).toHaveLength(1)
    expect(byHub.get("funeral-gyeongbuk")).toHaveLength(0)
    // fixture는 diagnostic에도 나타나지 않는다 — 허브 표면 밖.
    expect(diagnostics).toHaveLength(0)
    // P1 7개 외의 허브 키는 만들어지지 않는다 (P2 자동 생성 금지).
    expect([...byHub.keys()].sort()).toEqual([...P1_HUBS.map((hub) => hub.slug)].sort())
  })

  it("emits diagnostics instead of guessing — 일반 호텔·P1 밖 지역", () => {
    const { byHub, diagnostics } = groupPagesByHub([ICSQUARE_HOTEL, GYEONGGI_FUNERAL])
    expect([...byHub.values()].flat()).toHaveLength(0)
    expect(diagnostics).toEqual([
      { path: "/places/h-gn-1", name: "아이스퀘어호텔", reason: "hub-type-unresolved" },
      { path: "/places/f-gg-1", name: "가평장례식장", reason: "no-active-hub" },
    ])
  })

  it("auto-enrolls a newly published place with no other change — 자동 편입 실증", () => {
    const before = groupPagesByHub([GYEONGNAM_FUNERAL]).byHub.get("funeral-gyeongnam")
    expect(before).toHaveLength(1)
    const newlyPublished = pageDto({ slug: "f-gn-new", name: "신규장례식장", category: "funeral", region: "경남", district: "진주시", address: "경남 진주시 6" })
    const after = groupPagesByHub([GYEONGNAM_FUNERAL, newlyPublished]).byHub.get("funeral-gyeongnam")
    expect(after).toHaveLength(2)
  })

  it("resolves 아이스퀘어호텔 region correctly even though it never enters a hub", () => {
    expect(resolveSidoCode({ region: ICSQUARE_HOTEL.region, district: ICSQUARE_HOTEL.district, address: ICSQUARE_HOTEL.address })).toBe("gyeongnam")
    expect(hubForPage(ICSQUARE_HOTEL)).toBeNull()
  })
})

describe("상세→허브 역링크·관련 장소", () => {
  it("returns the P1 hub for a member page and null for fixtures", () => {
    expect(hubForPage(GYEONGNAM_FUNERAL)?.slug).toBe("funeral-gyeongnam")
    expect(hubForPage(FIXTURE_PAGE)).toBeNull()
  })

  it("picks related places by district → sido → hub type, excluding self, max 5", () => {
    const sameDistrict = pageDto({ slug: "f-gn-cw2", name: "창원제2장례식장", category: "funeral", region: "경남", district: "창원시", address: "경남 창원시 7" })
    const otherSido = [DAEGU_FUNERAL, pageDto({ slug: "f-gb-1", name: "안동장례식장", category: "funeral", region: "경북", district: "안동시", address: "경북 안동시 8" })]
    const fillers = Array.from({ length: 6 }, (_, i) =>
      pageDto({ slug: `f-gn-x${String(i)}`, name: `경남장례${String(i)}`, category: "funeral", region: "경남", district: "진주시", address: "경남 진주시 9" }),
    )
    const picked = pickRelatedPlaces(GYEONGNAM_FUNERAL, [GYEONGNAM_FUNERAL, sameDistrict, GYEONGNAM_WEDDING, FIXTURE_PAGE, ...otherSido, ...fillers])
    expect(picked).toHaveLength(RELATED_PLACES_LIMIT)
    expect(picked[0]?.slug).toBe("f-gn-cw2") // 같은 시/군/구 우선
    expect(picked.every((page) => page.slug !== GYEONGNAM_FUNERAL.slug)).toBe(true) // 자기 자신 제외
    expect(picked.every((page) => page.dataOrigin === "database")).toBe(true)
    // 같은 업종만 — 예식장은 장례식장 상세의 관련 장소가 아니다.
    expect(picked.every((page) => page.slug !== GYEONGNAM_WEDDING.slug)).toBe(true)
  })

  it("returns no related places for pages outside any hub", () => {
    expect(pickRelatedPlaces(ICSQUARE_HOTEL, [GYEONGNAM_WEDDING, GYEONGNAM_FUNERAL])).toEqual([])
  })
})

describe("sitemap·활성 조건·문구", () => {
  it("adds one sitemap entry per non-empty P1 hub with the members' latest lastModified", () => {
    const entries = buildHubSitemapEntries([GYEONGNAM_FUNERAL, { ...GYEONGNAM_FUNERAL_2, lastModifiedAt: "2026-08-20T00:00:00.000Z" }, ULSAN_CORPORATE], "https://place.example.com")
    expect(entries.map((entry) => entry.url)).toEqual(["https://place.example.com/hub/funeral-gyeongnam", "https://place.example.com/hub/corporate-ulsan"])
    expect(entries[0]?.lastModified).toBe("2026-08-20T00:00:00.000Z")
    // 구성원 0인 허브(예: wedding-daegu)는 sitemap에 없다.
    expect(entries.some((entry) => entry.url.includes("wedding"))).toBe(false)
  })

  it("keeps the activation thresholds for future expansion (P1은 명시 활성)", () => {
    expect(hubActivation(3)).toBe("active")
    expect(hubActivation(2)).toBe("hold")
    expect(hubActivation(1)).toBe("inactive")
    expect(hubActivation(0)).toBe("inactive")
  })

  it("builds hub identity: exactly 7 P1 hubs, stable slugs and anchors", () => {
    expect(P1_HUBS).toHaveLength(7)
    expect(findHubBySlug("funeral-gyeongnam")?.hubType).toBe("funeral")
    expect(findHubBySlug("funeral-gyeongnam-changwonsi")).toBeUndefined() // P2 없음
    const hub = findHubBySlug("wedding-ulsan")
    expect(hub === undefined ? null : hubPath(hub)).toBe("/hub/wedding-ulsan")
    expect(hub === undefined ? null : hubTitle(hub)).toBe("울산 예식장 축하화환 안내")
    expect(hub === undefined ? null : hubMemberAnchor(hub, "문수컨벤션웨딩홀")).toBe("문수컨벤션웨딩홀 축하화환 안내")
    const funeralHub = findHubBySlug("funeral-daegu")
    expect(funeralHub === undefined ? null : hubMemberAnchor(funeralHub, "곽병원 장례식장")).toBe("곽병원 장례식장 근조화환 안내")
  })

  it("hub copy stays factual — 단정·보장·제휴·가격 표현 금지", () => {
    for (const hub of P1_HUBS) {
      const copy = buildHubCopy(hub, 5)
      const text = JSON.stringify(copy)
      for (const banned of ["보장", "공식 제휴", "즉시 배송", "무료", "원 부터", "빈소가 마련되어"]) {
        expect(text, `${hub.slug} contains ${banned}`).not.toContain(banned)
      }
      expect(copy.metaTitle).toContain("5곳")
      expect(copy.faq.length).toBeGreaterThanOrEqual(2)
    }
  })
})

describe("상세 breadcrumb JSON-LD — 허브 crumb", () => {
  it("inserts index + hub crumbs between 홈 and the page, and stays 2-level without them", () => {
    const withHub = buildJsonLdObjects(GYEONGNAM_FUNERAL, [
      { name: HUB_INDEX_TITLE, item: "https://place.example.com/hub" },
      { name: "경남 장례식장 근조화환 안내", item: "https://place.example.com/hub/funeral-gyeongnam" },
    ])
    const breadcrumb = withHub.find((entry) => entry["@type"] === "BreadcrumbList")
    const items = (breadcrumb?.["itemListElement"] ?? []) as readonly { name: string; position: number }[]
    expect(items.map((item) => item.name)).toEqual(["홈", HUB_INDEX_TITLE, "경남 장례식장 근조화환 안내", GYEONGNAM_FUNERAL.title])
    expect(items.map((item) => item.position)).toEqual([1, 2, 3, 4])

    const withoutHub = buildJsonLdObjects(GYEONGNAM_FUNERAL)
    const plain = withoutHub.find((entry) => entry["@type"] === "BreadcrumbList")
    expect(((plain?.["itemListElement"] ?? []) as readonly unknown[]).length).toBe(2)
  })
})

describe("허브 인덱스 (/hub)", () => {
  it("lists only active hubs with dynamic counts in P1 definition order", () => {
    const summaries = listActiveHubSummaries([GYEONGNAM_FUNERAL, GYEONGNAM_FUNERAL_2, GYEONGNAM_WEDDING, ULSAN_CORPORATE, FIXTURE_PAGE])
    expect(summaries.map((entry) => [entry.hub.slug, entry.count])).toEqual([
      ["funeral-gyeongnam", 2],
      ["wedding-gyeongnam", 1],
      ["corporate-ulsan", 1],
    ])
    // 구성원 0 허브는 목록에 없다 — 새 published가 들어오면 코드 수정 없이 나타난다.
    const withDaegu = listActiveHubSummaries([GYEONGNAM_FUNERAL, DAEGU_FUNERAL])
    expect(withDaegu.map((entry) => entry.hub.slug)).toEqual(["funeral-gyeongnam", "funeral-daegu"])
  })

  it("adds one sitemap entry for /hub only when at least one hub is active", () => {
    const entry = buildHubIndexSitemapEntry([GYEONGNAM_FUNERAL, { ...GYEONGNAM_FUNERAL_2, lastModifiedAt: "2026-08-25T00:00:00.000Z" }], "https://place.example.com")
    expect(entry?.url).toBe("https://place.example.com/hub")
    expect(entry?.lastModified).toBe("2026-08-25T00:00:00.000Z")
    expect(HUB_INDEX_PATH).toBe("/hub")
    // 활성 허브 0 → 인덱스도 sitemap에 없다.
    expect(buildHubIndexSitemapEntry([ICSQUARE_HOTEL], "https://place.example.com")).toBeNull()
    expect(buildHubIndexSitemapEntry([FIXTURE_PAGE], "https://place.example.com")).toBeNull()
  })
})
