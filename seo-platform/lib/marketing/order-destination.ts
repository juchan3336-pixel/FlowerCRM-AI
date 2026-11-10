// 주문 목적지 — 자사몰(아임웹)과 네이버 스마트스토어 두 곳.
//
// 광고 소재의 주문 링크는 반드시 이 두 목적지 안의 HTTPS 주소여야 한다. 승인된 상품 상세 URL이 있으면
// 그것을 쓰고, 없으면 스토어 홈으로 보낸다 — 상품 번호를 추측해서 만들지 않는다.
//
// 공개 SEO 페이지의 주문 버튼(lib/public-seo/order-cta.ts, places.order_url)과는 별개다. 그쪽 동작은 그대로 둔다.
import type { ContentMode } from "@/lib/ai/content-mode"

import { getMarketingChannel } from "./channel-policy"
import type { MarketingChannelCode, OrderDestination, OrderDestinationCode } from "./types"

const SMARTSTORE_HOST = "smartstore.naver.com"
const SMARTSTORE_STORE_PATH = "/free77888"

const DESTINATIONS: Readonly<Record<OrderDestinationCode, OrderDestination>> = {
  imweb: { code: "imweb", label: "자사몰", baseUrl: "https://팔도플라워.com" },
  smartstore: { code: "smartstore", label: "네이버 스마트스토어", baseUrl: `https://${SMARTSTORE_HOST}${SMARTSTORE_STORE_PATH}` },
}

// URL API는 한글 도메인을 punycode로 바꾼다. 비교는 변환된 host끼리 하고, 출력 문자열은 원문을 유지한다.
const IMWEB_HOSTS: ReadonlySet<string> = new Set([new URL("https://팔도플라워.com").hostname, new URL("https://www.팔도플라워.com").hostname])

export function listOrderDestinations(): readonly OrderDestination[] {
  return [DESTINATIONS.imweb, DESTINATIONS.smartstore]
}

export function getOrderDestination(code: OrderDestinationCode): OrderDestination {
  return DESTINATIONS[code]
}

export type DestinationUrlCheck = { readonly ok: true } | { readonly ok: false; readonly reason: "invalid-url" | "not-https" | "has-credentials" | "custom-port" | "host-not-allowed" | "path-not-allowed" }

// 주문 링크가 해당 목적지의 허용 범위 안인지 검사한다.
export function checkDestinationUrl(code: OrderDestinationCode, url: string): DestinationUrlCheck {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: "invalid-url" }
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "not-https" }
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { ok: false, reason: "has-credentials" }
  }
  if (parsed.port.length > 0) {
    return { ok: false, reason: "custom-port" }
  }
  if (code === "imweb") {
    return IMWEB_HOSTS.has(parsed.hostname) ? { ok: true } : { ok: false, reason: "host-not-allowed" }
  }
  if (parsed.hostname !== SMARTSTORE_HOST) {
    return { ok: false, reason: "host-not-allowed" }
  }
  // 다른 판매자의 스토어로 새지 않도록 우리 스토어 경로만 허용한다.
  const inStore = parsed.pathname === SMARTSTORE_STORE_PATH || parsed.pathname.startsWith(`${SMARTSTORE_STORE_PATH}/`)
  return inStore ? { ok: true } : { ok: false, reason: "path-not-allowed" }
}

// 목적지별·모드별 승인 상품 상세 URL. 비어 있으면 스토어 홈을 쓴다.
export type ApprovedProductUrls = Readonly<Partial<Record<OrderDestinationCode, Readonly<Partial<Record<ContentMode, string>>>>>>

export type ResolvedDestination = {
  readonly destination: OrderDestination
  readonly url: string
  // product = 승인된 상품 상세, store-home = 상품 매핑이 없어 스토어 홈으로 보냄
  readonly target: "product" | "store-home"
  // default = 채널 기본값, override = 운영자가 명시 선택
  readonly selection: "default" | "override"
}

export type ResolveDestinationInput = {
  readonly channel: MarketingChannelCode
  readonly mode: ContentMode
  // 운영자가 채널 기본값 대신 고른 목적지
  readonly override?: OrderDestinationCode
  readonly productUrls?: ApprovedProductUrls
}

export function resolveOrderDestination(input: ResolveDestinationInput): ResolvedDestination {
  const code = input.override ?? getMarketingChannel(input.channel).defaultDestination
  const destination = DESTINATIONS[code]
  const selection = input.override === undefined ? "default" : "override"
  const productUrl = input.productUrls?.[code]?.[input.mode]
  if (productUrl === undefined) {
    return { destination, url: destination.baseUrl, target: "store-home", selection }
  }
  const check = checkDestinationUrl(code, productUrl)
  if (!check.ok) {
    throw new DestinationUrlError(code, productUrl, check.reason)
  }
  return { destination, url: productUrl, target: "product", selection }
}

export class DestinationUrlError extends Error {
  readonly name = "DestinationUrlError"

  constructor(
    readonly destination: OrderDestinationCode,
    readonly url: string,
    readonly reason: string,
  ) {
    super(`Order URL not allowed for ${destination} (${reason}): ${url}`)
  }
}
