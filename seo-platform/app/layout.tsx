import type { Metadata } from "next"
import "./globals.css"

import { getPublicSiteUrl } from "@/lib/site-url"

const siteUrl = getPublicSiteUrl()
// 공개 표면 브랜드 — 검색 결과 <title> 접미사로 노출되므로 소비자용 명칭만 쓴다.
// "팔도플라워 SEO Platform" 같은 내부 운영 명칭은 관리자 레이아웃에서만 쓴다 (2026-09-01 교정).
// env로 바꾸지 않는다 — 공개 title은 배포 환경과 무관하게 항상 같은 브랜드여야 한다.
const PUBLIC_BRAND_NAME = "팔도플라워"

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
      "naver-site-verification": process.env["NAVER_SITE_VERIFICATION"] ?? "",
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
