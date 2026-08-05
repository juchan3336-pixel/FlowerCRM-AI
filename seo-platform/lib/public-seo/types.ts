import type { ChangeFrequency, SeoPageStatus, SeoPageType } from "@/lib/domain/constants"
import type { Json } from "@/types/database"

// 공개 페이지 데이터 출처 — sitemap·색인 노출 판정의 중앙 기준.
// "database" = 운영 DB(published_place_pages)에서 온 실제 게시 데이터.
// "fixture"  = 코드에 내장된 합성 seed/fixture (가상 시설·demo). 검색 제출 대상이 아니다.
// 미지정은 fixture로 간주한다 — 출처를 증명한 데이터만 검색 표면에 나가야 하므로 기본값이 보수적이다.
export type PublicDataOrigin = "database" | "fixture"

export type PublicSeoSource = {
  readonly id: string
  readonly type: SeoPageType
  readonly slug: string
  readonly path: string
  readonly status: SeoPageStatus
  readonly dataOrigin?: PublicDataOrigin
  readonly title: string
  readonly description: string
  readonly canonicalUrl: string | null
  readonly priority: number
  readonly changeFrequency: ChangeFrequency
  readonly lastModifiedAt: string
  readonly region: string | null
  readonly city: string | null
  readonly district: string | null
  readonly address: string | null
  readonly homepage: string | null
  readonly ctaUrl: string | null
  readonly place: PublicSeoPlace | null
  readonly content: PublicSeoContent
}

export type PublicSeoRecord = PublicSeoSource & {
  readonly privateSource: PrivateSeoSource
}

export type PublicSeoPlace = {
  readonly name: string
  readonly category: string
  readonly detailCategory: string | null
}

export type PublicSeoContent = {
  readonly faq: readonly PublicFaq[]
  readonly keywords: readonly string[]
  readonly internalLinks: readonly PublicInternalLink[]
}

export type PublicFaq = {
  readonly question: string
  readonly answer: string
}

export type PublicInternalLink = {
  readonly href: string
  readonly label: string
}

export type PrivateSeoSource = {
  readonly email: string | null
  readonly memo: string | null
  readonly imported_payload: Json | null
  readonly synced_at: string | null
  readonly service_role: string | null
  readonly phone: string | null
}

export type PublicPageDto = {
  readonly id: string
  readonly type: SeoPageType
  readonly slug: string
  readonly path: string
  readonly dataOrigin: PublicDataOrigin
  readonly title: string
  readonly description: string
  readonly canonicalUrl: string
  readonly priority: number
  readonly changeFrequency: ChangeFrequency
  readonly lastModifiedAt: string
  readonly region: string | null
  readonly city: string | null
  readonly district: string | null
  readonly address: string | null
  readonly homepage: string | null
  readonly ctaUrl: string
  readonly place: PublicSeoPlace | null
  readonly content: PublicSeoContent
}

export type SitemapEntry = {
  readonly url: string
  readonly lastModified: string
  readonly changeFrequency: ChangeFrequency
  readonly priority: number
}

export type RobotsConfig = {
  readonly rules: {
    readonly userAgent: "*"
    readonly allow: "/"
    readonly disallow: readonly ["/admin", "/api", "/login", "/private"]
  }
  readonly sitemap: string
}

export type JsonLdValue = string | number | boolean | null | readonly JsonLdValue[] | { readonly [key: string]: JsonLdValue }

export type JsonLdObject = {
  readonly "@context": "https://schema.org"
  readonly "@type": string
  readonly [key: string]: JsonLdValue
}

export type PrivacyScanResult =
  | { readonly ok: true; readonly leaks: readonly [] }
  | { readonly ok: false; readonly leaks: readonly string[] }
