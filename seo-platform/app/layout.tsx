import type { Metadata } from "next"
import "./globals.css"

import { getPublicSiteUrl } from "@/lib/site-url"

const siteUrl = getPublicSiteUrl()
// 공개 표면 브랜드 — 검색 결과 <title> 접미사로 노출되므로 소비자용 명칭만 쓴다.
// "팔도플라워 SEO Platform" 같은 내부 운영 명칭은 관리자 레이아웃에서만 쓴다 (2026-09-01 교정).
// env로 바꾸지 않는다 — 공개 title은 배포 환경과 무관하게 항상 같은 브랜드여야 한다.
const PUBLIC_BRAND_NAME = "팔도플라워"

// 네이버 서치어드바이저 소유 확인 값 (place.팔도플라워.com, 2026-11-26 발급).
// 페이지 HTML에 그대로 노출되는 공개 값이라 코드에 둔다. 환경 변수에 값이 있으면 그 값이 우선한다(빈 문자열이면 이 값을 쓴다).
const NAVER_SITE_VERIFICATION_DEFAULT = "c32d4ad27bfbd89e8bdc298bab65b17d0ea9b3e9"

function naverSiteVerification(): string {
  const fromEnv = (process.env["NAVER_SITE_VERIFICATION"] ?? "").trim()
  return fromEnv.length > 0 ? fromEnv : NAVER_SITE_VERIFICATION_DEFAULT
}

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: PUBLIC_BRAND_NAME,
    template: `%s | ${PUBLIC_BRAND_NAME}`,
  },
  description: "Supabase-backed SEO platform foundation for 팔도플라워 local pages.",
  robots: { index: true, follow: true },
  verification: {
    google: process.env["GOOGLE_SITE_VERIFICATION"],
    other: {
      "naver-site-verification": naverSiteVerification(),
    },
  },
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  )
}
