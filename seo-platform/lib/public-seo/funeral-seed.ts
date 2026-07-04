import { createBaseSlug, createUniqueSlug } from "@/lib/domain/slug"
import type { PublicSeoSource } from "./types"

const SITE_URL = "https://seo.example.com" as const
const LAST_MODIFIED_AT = "2026-07-03T00:00:00.000Z" as const

type FuneralSeedRegion = {
  readonly city: string
  readonly district: string
  readonly addressBase: string
}

const FUNERAL_SEED_REGIONS = [
  { city: "서울", district: "강남구", addressBase: "서울 강남구 테헤란로" },
  { city: "서울", district: "서초구", addressBase: "서울 서초구 반포대로" },
  { city: "부산", district: "해운대구", addressBase: "부산 해운대구 센텀중앙로" },
  { city: "부산", district: "부산진구", addressBase: "부산 부산진구 중앙대로" },
  { city: "대구", district: "수성구", addressBase: "대구 수성구 달구벌대로" },
  { city: "인천", district: "남동구", addressBase: "인천 남동구 인주대로" },
  { city: "광주", district: "서구", addressBase: "광주 서구 상무대로" },
  { city: "대전", district: "유성구", addressBase: "대전 유성구 대학로" },
  { city: "울산", district: "남구", addressBase: "울산 남구 삼산로" },
  { city: "창원", district: "성산구", addressBase: "창원 성산구 중앙대로" },
] as const satisfies readonly FuneralSeedRegion[]

const FUNERAL_PLACE_NAMES = ["평안", "하늘", "보람", "은하", "추모", "새빛", "늘봄", "한마음", "우리", "동행"] as const

export const GENERATED_FUNERAL_PUBLIC_PAGES = generateFuneralPublicPages()

function generateFuneralPublicPages(): readonly PublicSeoSource[] {
  const usedSlugs = new Set<string>()

  return FUNERAL_SEED_REGIONS.flatMap((region, regionIndex) =>
    FUNERAL_PLACE_NAMES.map((placeName, placeIndex) => {
      const ordinal = regionIndex * FUNERAL_PLACE_NAMES.length + placeIndex + 1
      const name = `${region.city} ${region.district} ${placeName}장례식장`
      const slug = createUniqueSlug(createBaseSlug({ pageType: "funeral", city: region.city, district: region.district, name }), usedSlugs)
      usedSlugs.add(slug)

      return buildFuneralPage({ region, name, slug, ordinal })
    }),
  )
}

function buildFuneralPage(input: Readonly<{ region: FuneralSeedRegion; name: string; slug: string; ordinal: number }>): PublicSeoSource {
  const path = `/funeral/${input.slug}`
  const regionName = `${input.region.city} ${input.region.district}`

  return {
    id: `seo_seed_funeral_${String(input.ordinal).padStart(3, "0")}`,
    type: "funeral",
    slug: input.slug,
    path,
    status: "published",
    title: `${input.name} 근조화환`,
    description: `${regionName} ${input.name} 근조화환 주문과 장례식장 배송 안내입니다.`,
    canonicalUrl: `${SITE_URL}${path}`,
    priority: 0.8,
    changeFrequency: "weekly",
    lastModifiedAt: LAST_MODIFIED_AT,
    region: regionName,
    city: input.region.city,
    district: input.region.district,
    address: `${input.region.addressBase} ${String(input.ordinal)}`,
    homepage: null,
    ctaUrl: null,
    place: { name: input.name, category: "funeral", detailCategory: "전문장례식장" },
    content: {
      faq: [{ question: `${input.name}으로 바로 배송되나요?`, answer: "주문 페이지에서 장례식장명과 빈소 정보를 입력할 수 있습니다." }],
      keywords: [`${regionName} 장례식장`, `${input.name} 근조화환`, "장례식장 화환"],
      internalLinks: [{ href: `/area/area-${input.region.city}-${input.region.district}`, label: `${regionName} 배송 안내` }],
    },
  }
}
