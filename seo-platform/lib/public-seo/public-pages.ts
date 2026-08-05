import type { SeoPageType } from "@/lib/domain/constants"
import { getPublicSiteUrl } from "@/lib/site-url"
import { resolvePublicAddress } from "./address-visibility"
import { DEFAULT_ORDER_URL } from "./fixtures"
import type { JsonLdObject, PrivacyScanResult, PublicPageDto, PublicSeoSource, RobotsConfig, SitemapEntry } from "./types"

const PRIVATE_PATH_PREFIXES = ["/admin", "/api", "/login", "/private"] as const
const PRIVATE_TOKENS = [
  "email",
  "memo",
  "imported_payload",
  "synced_at",
  "service_role",
  "SUPABASE_SERVICE_ROLE_KEY",
  "Bearer ",
  "private@example.com",
  "010-9999-0000",
] as const

export function listPublishedPublicPages(records: readonly PublicSeoSource[]): readonly PublicPageDto[] {
  return records.filter(isPublishedCanonicalPublicRecord).map(toPublicPageDto)
}

export function findPublicPageByTypeAndSlug(
  records: readonly PublicSeoSource[],
  type: SeoPageType,
  slug: string,
): PublicPageDto | undefined {
  return listPublishedPublicPages(records).find((page) => page.type === type && page.slug === slug)
}

export function buildCanonicalUrl(siteUrl: string, path: string): string {
  const baseUrl = siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path
  return new URL(normalizedPath, baseUrl).toString()
}

export function buildSitemapEntries(records: readonly PublicSeoSource[], siteUrl: string): readonly SitemapEntry[] {
  return buildSitemapEntriesFromPages(listPublishedPublicPages(records), siteUrl)
}

export function buildSitemapEntriesFromPages(pages: readonly PublicPageDto[], siteUrl: string): readonly SitemapEntry[] {
  return pages.map((page) => ({
    url: buildCanonicalUrl(siteUrl, page.path),
    lastModified: page.lastModifiedAt,
    changeFrequency: page.changeFrequency,
    priority: page.priority,
  }))
}

export function buildRobotsConfig(siteUrl: string): RobotsConfig {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/api", "/login", "/private"],
    },
    sitemap: buildCanonicalUrl(siteUrl, "/sitemap.xml"),
  }
}

export function buildJsonLdObjects(page: PublicPageDto): readonly JsonLdObject[] {
  const breadcrumb = buildBreadcrumbJsonLd(page)
  const faq = buildFaqJsonLd(page)
  const subject = buildSubjectJsonLd(page)
  return [breadcrumb, faq, subject]
}

export function scanPublicPayloadForPrivateData(rendered: string, payload: unknown): PrivacyScanResult {
  const serializedPayload = JSON.stringify(payload)
  const haystack = `${rendered}\n${serializedPayload}`
  const leaks = PRIVATE_TOKENS.filter((token) => haystack.includes(token))
  return leaks.length === 0 ? { ok: true, leaks: [] } : { ok: false, leaks }
}

function isPublishedCanonicalPublicRecord(record: PublicSeoSource): boolean {
  return record.status === "published" && record.canonicalUrl !== null && isPublicPath(record.path)
}

function isPublicPath(path: string): boolean {
  return PRIVATE_PATH_PREFIXES.every((prefix) => path !== prefix && !path.startsWith(`${prefix}/`))
}

function toPublicPageDto(record: PublicSeoSource): PublicPageDto {
  return {
    id: record.id,
    type: record.type,
    slug: record.slug,
    path: record.path,
    title: record.title,
    description: record.description,
    // canonical은 저장값을 그대로 내보내지 않고 공개 origin + path로 다시 만든다.
    // 저장값은 상대 경로(장소 행)와 구식 절대 URL(fixture)이 섞여 있어, 여기서 절대화해야
    // 페이지 canonical·og:url·JSON-LD가 전부 같은 공개 도메인의 self-canonical이 된다.
    // record.canonicalUrl은 '공개 가능' 판정(isPublishedCanonicalPublicRecord)에만 남는다.
    canonicalUrl: buildCanonicalUrl(getPublicSiteUrl(), record.path),
    priority: record.priority,
    changeFrequency: record.changeFrequency,
    lastModifiedAt: record.lastModifiedAt,
    region: record.region,
    city: record.city,
    district: record.district,
    // 공개 표면 주소는 축약 정책을 거친다 (랜딩 배송지 정보·JSON-LD가 이 필드를 공유)
    address: resolvePublicAddress(record.slug, record.address),
    homepage: record.homepage,
    ctaUrl: record.ctaUrl ?? DEFAULT_ORDER_URL,
    place: record.place,
    content: record.content,
  }
}

function buildBreadcrumbJsonLd(page: PublicPageDto): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "홈", item: DEFAULT_ORDER_URL },
      { "@type": "ListItem", position: 2, name: page.title, item: page.canonicalUrl },
    ],
  }
}

function buildFaqJsonLd(page: PublicPageDto): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: page.content.faq.map((entry) => ({
      "@type": "Question",
      name: entry.question,
      acceptedAnswer: { "@type": "Answer", text: entry.answer },
    })),
  }
}

function buildSubjectJsonLd(page: PublicPageDto): JsonLdObject {
  switch (page.type) {
    case "area":
      return buildWebPageJsonLd(page)
    case "funeral":
    case "hospital":
    case "place":
      return buildLocalBusinessJsonLd(page)
    case "product":
      return buildProductJsonLd(page)
    default:
      return assertNever(page.type)
  }
}

function buildWebPageJsonLd(page: PublicPageDto): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: page.title,
    description: page.description,
    url: page.canonicalUrl,
  }
}

function buildLocalBusinessJsonLd(page: PublicPageDto): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: page.place?.name ?? page.title,
    description: page.description,
    url: page.homepage ?? page.canonicalUrl,
    address: page.address,
    areaServed: page.region,
  }
}

function buildProductJsonLd(page: PublicPageDto): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: page.title,
    description: page.description,
    url: page.canonicalUrl,
  }
}

function assertNever(value: never): never {
  throw new UnhandledPublicSeoVariantError(String(value))
}

class UnhandledPublicSeoVariantError extends Error {
  readonly name = "UnhandledPublicSeoVariantError"

  constructor(readonly variant: string) {
    super(`Unhandled public SEO variant ${variant}`)
  }
}
