// 광고 배포(marketing) 도메인 타입 — 화환 소재(글+이미지)를 외부 채널에 배포하는 흐름의 공통 어휘.
// 공개 SEO(/places·/hub) 파이프라인과는 분리된 도메인이다. 기존 places.order_url·order-cta.ts는 건드리지 않는다.
import type { ContentMode } from "@/lib/ai/content-mode"

// 주문 목적지 — 고객이 실제로 결제하는 곳. 소재 하나에는 주문 링크가 하나만 들어간다.
export type OrderDestinationCode = "imweb" | "smartstore"

// 추적 파라미터 방식
//   utm           — 자사몰(아임웹) UTM
//   naver-nt      — 스마트스토어 사용자정의 유입(nt_source 등)
//   platform-auto — 매체 자동 추적(네이버 검색광고 → 스마트스토어). 파라미터를 붙이지 않는다.
export type TrackingKind = "utm" | "naver-nt" | "platform-auto"

export type MarketingChannelCode =
  | "naver_search_ad"
  | "naver_blog"
  | "naver_place"
  | "naver_cafe"
  | "kakao_channel"
  | "instagram"
  | "facebook_page"
  | "google_business_profile"
  | "daangn_biz"
  | "youtube_shorts"
  | "google_search_ad"

// 1차 = 지금 운영, 2차 = 성과 확인 후 확장
export type ChannelTier = "primary" | "secondary"

// manual = 사람이 붙여넣고 게시 URL을 확인, api = 공식 API 자동 게시(2차), disabled = 배포 중지
export type PublishMode = "manual" | "api" | "disabled"

export type ChannelMedium = "organic_social" | "cpc"

export type MarketingChannel = {
  readonly code: MarketingChannelCode
  readonly label: string
  readonly tier: ChannelTier
  readonly publishMode: PublishMode
  readonly medium: ChannelMedium
  readonly defaultDestination: OrderDestinationCode
}

export type OrderDestination = {
  readonly code: OrderDestinationCode
  readonly label: string
  // 스토어 홈 — 모드별 승인 상품 URL이 없을 때 쓰는 기본 링크
  readonly baseUrl: string
}

// 소재 문안 — 채널별 변형 한 건
export type AdCopy = {
  readonly title: string
  readonly body: string
  // SNS 캡션 등 본문과 별도로 나가는 짧은 문구
  readonly caption?: string
  // 이미지 위에 합성되는 문구 — 본문과 같은 규칙으로 검사한다
  readonly imageTexts?: readonly string[]
}

export type MarketingVariantDraft = {
  readonly mode: ContentMode
  readonly channel: MarketingChannelCode
  readonly destination: OrderDestinationCode
  // 추적 파라미터까지 포함한 최종 주문 링크
  readonly orderUrl: string
  readonly copy: AdCopy
  // 이미지 저장 경로(또는 식별자) — 순서 포함
  readonly imageRefs: readonly string[]
  // 문안·이미지·목적지 중 하나라도 바뀌면 올라가는 수정 번호
  readonly revision: number
}

export type DistributionStatus =
  | "draft"
  | "needs_review"
  | "approved"
  // 사람 게시 경로
  | "manual_ready"
  | "manual_confirmed"
  // API 게시 경로 (2차)
  | "queued"
  | "publishing"
  | "published"
  | "unknown"
  | "failed"

// ── 저장 계층 상태 — 소재 검수 상태와 배포 작업 실행 상태를 분리해 저장한다 ──
// 위의 DistributionStatus는 둘을 합쳐 본 화면용 파생값이다(distribution-state.ts의 combinedDistributionStatus).

// 소재 변형의 검수 상태
export type VariantReviewStatus = "draft" | "needs_review" | "approved"

// 배포 작업(승인본 한 건을 한 계정에 내보내는 실행)의 상태.
// cancelled = 게시 전에 소재가 수정되어 폐기된 작업.
export type DistributionJobStatus = "manual_ready" | "manual_confirmed" | "queued" | "publishing" | "published" | "unknown" | "failed" | "cancelled"

// 자동 생성 한 건의 상태. unknown = 응답을 받지 못해 결과를 알 수 없음(자동 재호출 금지).
export type MarketingGenerationStatus = "reserved" | "succeeded" | "failed" | "unknown"

export type MarketingCampaignStatus = "draft" | "active" | "paused" | "ended"

// 성과 수치의 출처 — 출처마다 귀속 기준이 달라 섞어 합산하지 않는다
export type MarketingMetricSource = "imweb_report" | "smartstore_report" | "naver_ads_report" | "google_ads_report" | "manual"
