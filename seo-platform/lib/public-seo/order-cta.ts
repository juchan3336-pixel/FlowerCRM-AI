import type { PublicPageDto } from "./types"

// 주문 CTA URL 빌더 — 기존 ctaUrl(order_url ?? DEFAULT_ORDER_URL) 위에 공개 정보만 파라미터로 얹는다.
// 내부 UUID(placeId)와 개인정보는 전달하지 않는다.
// URL API는 한글 도메인(팔도플라워.com)을 punycode로 바꿔 버리므로 문자열 결합으로 처리한다.
export type OrderCtaOptions = {
  readonly product?: string
}

export function buildOrderCtaUrl(page: PublicPageDto, options?: OrderCtaOptions): string {
  const params = new URLSearchParams()
  params.set("utm_source", "place_page")
  params.set("place_slug", page.slug)
  const placeName = page.place?.name ?? page.title
  if (placeName.length > 0) {
    params.set("place_name", placeName)
  }
  if (page.region !== null && page.region.length > 0) {
    params.set("region", page.region)
  }
  if (options?.product !== undefined) {
    params.set("product", options.product)
  }

  const separator = page.ctaUrl.includes("?") ? "&" : "?"
  return `${page.ctaUrl}${separator}${params.toString()}`
}
