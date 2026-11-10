// 추적 주문 링크 빌더 — 어느 채널·캠페인·소재에서 온 주문인지 쇼핑몰 보고서에서 가를 수 있게 한다.
//
//   자사몰        utm_source / utm_medium / utm_campaign / utm_content
//   스마트스토어  nt_source / nt_medium / nt_detail (/ nt_keyword) — 네이버 사용자정의 유입 파라미터
//   네이버 검색광고 → 스마트스토어: 매체가 자동 추적하므로 파라미터를 붙이지 않는다
//
// UTM이 스마트스토어 보고서에서 집계된다고 가정하지 않는다. 목적지마다 그 쇼핑몰이 읽는 키만 붙인다.
// URL API는 한글 도메인(팔도플라워.com)을 punycode로 바꾸므로 출력은 문자열 결합으로 만든다.
import { getMarketingChannel } from "./channel-policy"
import { checkDestinationUrl, DestinationUrlError } from "./order-destination"
import type { MarketingChannelCode, OrderDestinationCode, TrackingKind } from "./types"

// 캠페인·소재·키워드 코드 — 영문/숫자/-_ 만. 공백·한글·개인정보(이름, 전화번호)를 링크에 싣지 않는다.
// 마침표는 코드에 쓸 수 없다 — nt_detail에서 캠페인과 소재를 가르는 구분자로만 쓴다.
// 구분자가 코드 안에 나올 수 있으면 ('a-b','c')와 ('a','b-c')처럼 다른 소재가 같은 값으로 합쳐진다.
const TRACKING_CODE_PATTERN = /^[A-Za-z0-9_-]{1,50}$/
const NT_DETAIL_SEPARATOR = "."

// 우리가 관리하는 추적 키 — 링크를 만들 때 목적지 URL에 남아 있던 값은 전부 지우고 이번 값만 붙인다.
// 선택 항목(nt_keyword)도 포함한다. 이전 소재의 키워드가 남으면 새 소재가 그 키워드로 집계된다.
const MANAGED_KEYS: Readonly<Record<OrderDestinationCode, readonly string[]>> = {
  imweb: ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"],
  smartstore: ["nt_source", "nt_medium", "nt_detail", "nt_keyword"],
}

export function isTrackingCode(value: string): boolean {
  return TRACKING_CODE_PATTERN.test(value)
}

export function trackingKindFor(channel: MarketingChannelCode, destination: OrderDestinationCode): TrackingKind {
  if (destination === "imweb") {
    return "utm"
  }
  return channel === "naver_search_ad" ? "platform-auto" : "naver-nt"
}

export type TrackedOrderUrlInput = {
  readonly channel: MarketingChannelCode
  readonly destination: OrderDestinationCode
  // 목적지 URL — 스토어 홈 또는 승인된 상품 상세
  readonly baseUrl: string
  readonly campaignCode: string
  readonly variantCode: string
  // 스마트스토어 nt_keyword (선택)
  readonly keyword?: string
}

export type TrackedOrderUrl = {
  readonly url: string
  readonly trackingKind: TrackingKind
  // 실제로 붙인 추적 파라미터 — 승인 스냅샷과 성과 매핑에 그대로 쓴다
  readonly params: Readonly<Record<string, string>>
}

export function buildTrackedOrderUrl(input: TrackedOrderUrlInput): TrackedOrderUrl {
  const check = checkDestinationUrl(input.destination, input.baseUrl)
  if (!check.ok) {
    throw new DestinationUrlError(input.destination, input.baseUrl, check.reason)
  }
  requireTrackingCode("campaignCode", input.campaignCode)
  requireTrackingCode("variantCode", input.variantCode)
  if (input.keyword !== undefined) {
    requireTrackingCode("keyword", input.keyword)
  }

  const channel = getMarketingChannel(input.channel)
  const trackingKind = trackingKindFor(input.channel, input.destination)
  const pairs: (readonly [string, string])[] = []
  if (trackingKind === "utm") {
    pairs.push(["utm_source", channel.code], ["utm_medium", channel.medium], ["utm_campaign", input.campaignCode], ["utm_content", input.variantCode])
  } else if (trackingKind === "naver-nt") {
    pairs.push(["nt_source", channel.code], ["nt_medium", channel.medium], ["nt_detail", `${input.campaignCode}${NT_DETAIL_SEPARATOR}${input.variantCode}`])
    if (input.keyword !== undefined) {
      pairs.push(["nt_keyword", input.keyword])
    }
  }
  return { url: replaceManagedParams(input.baseUrl, MANAGED_KEYS[input.destination], pairs), trackingKind, params: Object.fromEntries(pairs) }
}

// 일반 query(idx 등)와 hash는 보존하고, 관리 대상 추적 키는 기존 값을 지운 뒤 이번 값만 붙인다.
function replaceManagedParams(baseUrl: string, managedKeys: readonly string[], pairs: readonly (readonly [string, string])[]): string {
  const keys = new Set(managedKeys)
  const hashIndex = baseUrl.indexOf("#")
  const beforeHash = hashIndex === -1 ? baseUrl : baseUrl.slice(0, hashIndex)
  const hash = hashIndex === -1 ? "" : baseUrl.slice(hashIndex)
  const queryIndex = beforeHash.indexOf("?")
  const path = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex)
  const existing = queryIndex === -1 ? [] : beforeHash.slice(queryIndex + 1).split("&")

  const kept = existing.filter((pair) => pair.length > 0 && !keys.has(decodeKey(pair)))
  const added = pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
  const query = [...kept, ...added].join("&")
  return `${path}${query.length > 0 ? `?${query}` : ""}${hash}`
}

function decodeKey(pair: string): string {
  const raw = pair.split("=")[0] ?? ""
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function requireTrackingCode(field: string, value: string): void {
  if (!isTrackingCode(value)) {
    throw new TrackingCodeError(field, value)
  }
}

export class TrackingCodeError extends Error {
  readonly name = "TrackingCodeError"

  constructor(
    readonly field: string,
    readonly value: string,
  ) {
    super(`Invalid tracking code for ${field}: '${value}' (영문/숫자/-_ 1~50자)`)
  }
}
