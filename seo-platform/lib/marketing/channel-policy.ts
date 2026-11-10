// 배포 채널 목록 — 어디에 노출하고, 어떻게 게시하고, 기본으로 어느 쇼핑몰로 보낼지를 한 곳에서 정한다.
//
// 제외한 채널(여기에 넣지 않는다):
//   지식iN 홍보 답변·무허가 카페/댓글/DM 대량 배포 — 위장 추천·스팸 위험
//   티스토리 신규 운영 — Open API 종료, 채널 유지 대비 효율 낮음
//   톡스토어 신규 입점 — 세 번째 결제 채널로 주문 운영이 분산됨
//
// 1차는 전부 사람 게시(manual)다. 공식 API 자동 게시는 계정 권한 확인 후 2차에서 채널별로 켠다.
import type { MarketingChannel, MarketingChannelCode } from "./types"

const CHANNELS: readonly MarketingChannel[] = [
  // 1차 — 네이버 검색 의도 포착. 네이버 유입은 스마트스토어 주문이 기본이다.
  { code: "naver_search_ad", label: "네이버 검색광고", tier: "primary", publishMode: "manual", medium: "cpc", defaultDestination: "smartstore" },
  { code: "naver_blog", label: "네이버 블로그", tier: "primary", publishMode: "manual", medium: "organic_social", defaultDestination: "smartstore" },
  { code: "naver_place", label: "네이버 플레이스 소식", tier: "primary", publishMode: "manual", medium: "organic_social", defaultDestination: "smartstore" },
  // 2차
  { code: "naver_cafe", label: "네이버 카페(허가된 홍보 게시판)", tier: "secondary", publishMode: "manual", medium: "organic_social", defaultDestination: "smartstore" },
  { code: "kakao_channel", label: "카카오 채널 소식", tier: "secondary", publishMode: "manual", medium: "organic_social", defaultDestination: "imweb" },
  { code: "instagram", label: "인스타그램", tier: "secondary", publishMode: "manual", medium: "organic_social", defaultDestination: "imweb" },
  { code: "facebook_page", label: "페이스북 페이지", tier: "secondary", publishMode: "manual", medium: "organic_social", defaultDestination: "imweb" },
  { code: "google_business_profile", label: "구글 비즈니스 프로필", tier: "secondary", publishMode: "manual", medium: "organic_social", defaultDestination: "imweb" },
  { code: "daangn_biz", label: "당근 비즈프로필", tier: "secondary", publishMode: "manual", medium: "organic_social", defaultDestination: "imweb" },
  { code: "youtube_shorts", label: "유튜브 쇼츠", tier: "secondary", publishMode: "manual", medium: "organic_social", defaultDestination: "imweb" },
  { code: "google_search_ad", label: "구글 검색광고", tier: "secondary", publishMode: "manual", medium: "cpc", defaultDestination: "imweb" },
]

const CHANNEL_BY_CODE: ReadonlyMap<MarketingChannelCode, MarketingChannel> = new Map(CHANNELS.map((channel) => [channel.code, channel]))

export function listMarketingChannels(): readonly MarketingChannel[] {
  return CHANNELS
}

export function getMarketingChannel(code: MarketingChannelCode): MarketingChannel {
  const channel = CHANNEL_BY_CODE.get(code)
  if (channel === undefined) {
    throw new Error(`Unknown marketing channel: ${code}`)
  }
  return channel
}

export function isMarketingChannelCode(value: string): value is MarketingChannelCode {
  return CHANNEL_BY_CODE.has(value as MarketingChannelCode)
}
