import type { Metadata } from "next"
import "./globals.css"

const siteUrl = process.env["SEO_PLATFORM_SITE_URL"] ?? "http://localhost:3000"
const brandName = process.env["SEO_PLATFORM_BRAND_NAME"] ?? "팔도플라워 SEO Platform"

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: brandName,
    template: `%s | ${brandName}`,
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
