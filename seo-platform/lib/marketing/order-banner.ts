// 주문 배너 — 글 안에 넣어 "누르면 주문 페이지로 가는" 고정 이미지의 문구와 색.
//
// 이미지는 브라우저 canvas로 그린다(components/admin/marketing/order-banner.tsx). 서버에 한글 폰트를 싣지 않아도 되고
// 외부 이미지 생성 서비스를 부르지 않는다. 사진이 아니라 문구와 버튼 모양만 있는 배너이므로 가짜 화환 사진이 생기지 않는다.
// 문구는 광고 문안과 같은 품질 검사를 통과해야 한다(테스트로 고정) — 근조 배너에 축하 표현이 섞이면 안 된다.
import type { ContentMode } from "@/lib/ai/content-mode"

export type OrderBannerSpec = {
  // 큰 글씨 한 줄
  readonly headline: string
  // 그 아래 작은 글씨
  readonly subline: string
  // 버튼 모양 안의 글씨
  readonly button: string
  readonly background: string
  readonly foreground: string
  readonly muted: string
  readonly accent: string
  // 버튼 글씨 색
  readonly accentText: string
}

export const ORDER_BANNER_SIZE = { width: 1200, height: 400 } as const

export const BRAND_NAME = "팔도플라워"

const SPECS: Readonly<Record<ContentMode, OrderBannerSpec>> = {
  // 근조 — 차분한 무채색. 장식·밝은 색을 쓰지 않는다.
  condolence: {
    headline: "근조화환 주문하기",
    subline: "빈소 호실과 리본 문구를 준비해 주세요",
    button: "주문 페이지로 이동",
    background: "#1f2937",
    foreground: "#f9fafb",
    muted: "#d1d5db",
    accent: "#f9fafb",
    accentText: "#1f2937",
  },
  celebration: {
    headline: "축하화환 주문하기",
    subline: "예식 날짜와 홀 이름을 준비해 주세요",
    button: "주문 페이지로 이동",
    background: "#fff7ed",
    foreground: "#7c2d12",
    muted: "#9a3412",
    accent: "#c2410c",
    accentText: "#ffffff",
  },
  "corporate-celebration": {
    headline: "개업·취임 축하화환 주문하기",
    subline: "행사 일시와 받는 분 직함을 준비해 주세요",
    button: "주문 페이지로 이동",
    background: "#eff6ff",
    foreground: "#1e3a8a",
    muted: "#1d4ed8",
    accent: "#1d4ed8",
    accentText: "#ffffff",
  },
}

export function orderBannerSpec(mode: ContentMode): OrderBannerSpec {
  return SPECS[mode]
}

// 배너에 실제로 그려지는 문구 전부 — 품질 검사에 그대로 넣는다
export function orderBannerTexts(mode: ContentMode): readonly string[] {
  const spec = SPECS[mode]
  return [BRAND_NAME, spec.headline, spec.subline, spec.button]
}

// 내려받는 파일 이름 — 어느 캠페인·소재의 배너인지 알 수 있게
export function orderBannerFileName(campaignCode: string, variantCode: string): string {
  return `order-banner-${campaignCode}-${variantCode}.png`
}
