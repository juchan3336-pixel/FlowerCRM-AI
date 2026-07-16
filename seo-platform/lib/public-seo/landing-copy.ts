import type { PublicPageDto } from "./types"

// 장소 카테고리(funeral/hospital/기타)에 따라 랜딩 문구를 분기한다. 잘못된 업종 문구 혼용을 코드에서 차단한다.
export type PlaceLandingKind = "funeral" | "hospital" | "general"

export type ProductCategoryKey = "condolence" | "celebration" | "opening" | "bouquet"

export type LandingImage = {
  readonly src: string
  readonly alt: string
}

export type ProductCategoryCopy = {
  readonly key: ProductCategoryKey
  readonly name: string
  readonly purpose: string
  readonly image: LandingImage
}

export type SituationItem = {
  readonly title: string
  readonly body: string
}

export type PlaceLandingCopy = {
  readonly kind: PlaceLandingKind
  readonly eyebrowLabel: string
  readonly heroTitle: string
  readonly categoryLabel: string
  readonly productOrder: readonly ProductCategoryCopy[]
  readonly situationTitle: string
  readonly situationItems: readonly SituationItem[]
}

// 검수 승인된 고정 문구 — 배송 확정·제휴 암시 표현 금지 원칙에 따라 임의 수정하지 않는다.
export const HERO_INTAKE_NOTICE = "주문 시 입력하신 배송지 정보를 기준으로 접수되며, 배송 가능 여부와 세부 사항은 주문 과정에서 확인됩니다."
export const HERO_TRUST_LINE = "전국 단위 주문 접수 · 목적별 상품 선택 · 주문 후 진행 안내"
export const PLACE_INFO_NOTICE = "배송지 선택을 위한 참고 정보입니다. 주문 전 장소명과 주소를 다시 확인해 주세요."
export const NON_AFFILIATION_NOTICE = "본 페이지는 배송지 안내를 위한 정보 페이지이며, 해당 장소의 공식 홈페이지 또는 제휴 판매 페이지가 아닙니다."

export const ORDER_PROCESS_STEPS: readonly SituationItem[] = [
  { title: "상품 선택", body: "목적에 맞는 화환·화분·꽃다발을 선택합니다." },
  { title: "배송 정보 입력", body: "받는 장소와 일정을 입력합니다." },
  { title: "결제", body: "온라인 결제로 주문을 확정합니다." },
  { title: "제작·배송 안내", body: "주문 접수 후 진행 상황을 안내해 드립니다." },
]

export const WHY_ITEMS: readonly SituationItem[] = [
  { title: "전국 단위 주문 접수", body: "장례식장·병원·행사장 등으로 보내는 주문을 온라인으로 접수합니다. 배송 가능 여부는 주문 과정에서 확인됩니다." },
  { title: "목적별 상품 선택", body: "조문·축하·개업 등 상황에 맞는 상품을 구분해 안내합니다." },
  { title: "간편한 주문 과정", body: "상품 선택부터 결제까지 온라인으로 완결됩니다." },
  { title: "주문 후 진행 안내", body: "접수 이후 제작·배송 진행 상황을 안내해 드립니다." },
]

export function buildPlaceLandingFaq(placeName: string): readonly SituationItem[] {
  return [
    { title: "주문은 어떻게 하나요?", body: "‘화환 주문하기’ 버튼을 누르면 전국팔도플라워 주문 페이지로 이동해 상품 선택과 결제를 진행할 수 있습니다." },
    { title: "배송 장소는 어떻게 입력하나요?", body: `주문 시 받는 장소에 ‘${placeName}’과 필요한 상세 정보(호실·빈소 등)를 입력하시면 됩니다.` },
    { title: "주문 후 진행 상황은 어떻게 확인하나요?", body: "주문 접수 후 제작·배송 진행 상황을 안내해 드립니다." },
    { title: "어떤 화환을 선택해야 하나요?", body: "조문에는 근조화환, 개업·행사에는 축하화환이나 개업화분을 권해 드립니다." },
    { title: "장소명이 검색되지 않을 때는 어떻게 하나요?", body: "주문 페이지에서 주소로 직접 입력하거나 주문 상담으로 문의해 주세요." },
  ]
}

// 운영 코드는 WebP 최적화본만 사용한다 (원본 PNG는 배포 제외).
export const PLACE_LANDING_HERO_IMAGES: Record<PlaceLandingKind, LandingImage> = {
  funeral: { src: "/images/place-landing/hero/funeral-hero.webp", alt: "장례식장 로비에 놓인 흰 국화 근조화환" },
  hospital: { src: "/images/place-landing/hero/hospital-hero.webp", alt: "병원 로비에 놓인 축하 화분과 꽃바구니" },
  general: { src: "/images/place-landing/hero/general-hero.webp", alt: "행사장에 놓인 축하화환" },
}

const PRODUCT_CATEGORIES: Record<ProductCategoryKey, ProductCategoryCopy> = {
  condolence: {
    key: "condolence",
    name: "근조화환",
    purpose: "조문과 애도의 마음을 전할 때",
    image: { src: "/images/place-landing/products/funeral-wreath.webp", alt: "흰 국화 근조화환 3단 스탠드" },
  },
  celebration: {
    key: "celebration",
    name: "축하화환",
    purpose: "개업·행사·기념일 축하",
    image: { src: "/images/place-landing/products/celebration-wreath.webp", alt: "축하화환 3단 스탠드" },
  },
  opening: {
    key: "opening",
    name: "개업화분",
    purpose: "새 출발하는 공간에 오래 남는 선물",
    image: { src: "/images/place-landing/products/opening-plant.webp", alt: "개업 축하 대형 관엽 화분" },
  },
  bouquet: {
    key: "bouquet",
    name: "꽃다발",
    purpose: "감사와 축하를 가까이에서 전할 때",
    image: { src: "/images/place-landing/products/bouquet.webp", alt: "핑크 톤 장미 꽃다발" },
  },
}

const FUNERAL_SITUATIONS: readonly SituationItem[] = [
  { title: "근조화환 선택", body: "조문에는 흰 국화 중심의 근조화환이 격식에 맞습니다. 3단 화환이 일반적입니다." },
  { title: "리본 문구", body: "‘삼가 고인의 명복을 빕니다’와 보내는 분의 성함·소속을 리본에 담아 전합니다." },
  { title: "보내는 시점", body: "부고 확인 후 빈소가 차려진 뒤 도착하도록 주문하는 것이 일반적입니다." },
]

const HOSPITAL_SITUATIONS: readonly SituationItem[] = [
  { title: "쾌유 인사", body: "입원한 분께는 꽃다발이나 꽃바구니로 위로와 응원의 마음을 전할 수 있습니다." },
  { title: "개원·개업 축하", body: "개원·이전 축하에는 축하화환이나 오래 두고 볼 수 있는 개업화분을 권해 드립니다." },
  { title: "방문 전 확인", body: "병원에 따라 생화 반입이 제한될 수 있으니, 병동 방문 전 반입 가능 여부를 확인해 주세요." },
]

const GENERAL_SITUATIONS: readonly SituationItem[] = [
  { title: "개업·이전 축하", body: "새 출발을 축하할 때는 축하화환이나 공간에 어울리는 개업화분이 좋습니다." },
  { title: "행사·기념일", body: "행사장에는 축하화환, 가까운 분께는 꽃다발로 마음을 전해 보세요." },
  { title: "리본 문구", body: "‘축 발전’, ‘축 개업’ 등 목적에 맞는 문구와 보내는 분의 성함·소속을 리본에 담습니다." },
]

// 받침 유무에 따라 ‘로/으로’를 선택한다 (ㄹ 받침은 ‘로’).
export function directionalParticle(word: string): "로" | "으로" {
  const code = word.charCodeAt(word.length - 1)
  if (Number.isNaN(code) || code < 0xac00 || code > 0xd7a3) {
    return "로"
  }
  const finalConsonant = (code - 0xac00) % 28
  return finalConsonant === 0 || finalConsonant === 8 ? "로" : "으로"
}

// 받침 유무에 따라 ‘은/는’을 선택한다.
export function topicParticle(word: string): "은" | "는" {
  const code = word.charCodeAt(word.length - 1)
  if (Number.isNaN(code) || code < 0xac00 || code > 0xd7a3) {
    return "는"
  }
  return (code - 0xac00) % 28 === 0 ? "는" : "은"
}

export function buildHeroDisclaimer(placeName: string): string {
  return `본 페이지는 전국팔도플라워의 꽃배달 주문 안내 페이지입니다. ${placeName}${topicParticle(placeName)} 화환 판매처가 아니며, 주문·결제·배송 문의는 전국팔도플라워에서 처리합니다.`
}

export function resolvePlaceLandingKind(category: string | null): PlaceLandingKind {
  if (category === "funeral") {
    return "funeral"
  }
  if (category === "hospital") {
    return "hospital"
  }
  return "general"
}

export function buildPlaceLandingCopy(page: PublicPageDto): PlaceLandingCopy {
  const kind = resolvePlaceLandingKind(page.place?.category ?? null)
  const placeName = page.place?.name ?? page.title
  const particle = directionalParticle(placeName)
  const location = [page.region, page.district].filter((value) => value !== null && value.length > 0).join(" ")

  if (kind === "funeral") {
    return {
      kind,
      eyebrowLabel: `${location.length > 0 ? `${location} · ` : ""}장례식장 꽃배달`,
      heroTitle: `${placeName}${particle} 보내는 정성스러운 근조화환`,
      categoryLabel: "장례식장",
      productOrder: [PRODUCT_CATEGORIES.condolence, PRODUCT_CATEGORIES.celebration, PRODUCT_CATEGORIES.opening, PRODUCT_CATEGORIES.bouquet],
      situationTitle: "조문 화환, 이렇게 보내세요",
      situationItems: FUNERAL_SITUATIONS,
    }
  }

  if (kind === "hospital") {
    return {
      kind,
      eyebrowLabel: `${location.length > 0 ? `${location} · ` : ""}병원 꽃배달`,
      heroTitle: `${placeName}${particle} 보내는 정성스러운 꽃과 화환`,
      categoryLabel: "병원",
      productOrder: [PRODUCT_CATEGORIES.bouquet, PRODUCT_CATEGORIES.celebration, PRODUCT_CATEGORIES.opening, PRODUCT_CATEGORIES.condolence],
      situationTitle: "병원으로 꽃을 보낼 때",
      situationItems: HOSPITAL_SITUATIONS,
    }
  }

  // detail_category는 "서비스,산업 > 건설,건축 > 인테리어" 형태의 경로 문자열이라 마지막 세그먼트만 표기한다.
  const detailLeaf = page.place?.detailCategory?.split(">").map((segment) => segment.trim()).filter((segment) => segment.length > 0).at(-1) ?? null
  const rawCategory = page.place?.category ?? null
  const categoryLabel = [rawCategory, detailLeaf === rawCategory ? null : detailLeaf].filter((value): value is string => value !== null).join(" · ") || "장소 안내"
  return {
    kind,
    eyebrowLabel: `${location.length > 0 ? `${location} · ` : ""}꽃배달 주문`,
    heroTitle: `${placeName}${particle} 보내는 정성스러운 축하화환`,
    categoryLabel,
    productOrder: [PRODUCT_CATEGORIES.celebration, PRODUCT_CATEGORIES.opening, PRODUCT_CATEGORIES.bouquet, PRODUCT_CATEGORIES.condolence],
    situationTitle: "상황별 꽃 선물 안내",
    situationItems: GENERAL_SITUATIONS,
  }
}
