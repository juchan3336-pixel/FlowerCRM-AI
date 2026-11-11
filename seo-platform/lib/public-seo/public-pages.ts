import type { SeoPageType } from "@/lib/domain/constants"
import { getPublicSiteUrl } from "@/lib/site-url"
import { quotedAddressForms, resolvePublicAddress, rewritePublicAddressInText, rewriteQuotedAddress } from "./address-visibility"
import { applyCuratedFaqAnswerEdits, findCuratedEditorialBody, findCuratedPolicyNote, isRenderableSourceUrl, latestIsoTimestamp } from "./curated-editorial"
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

// hubCrumbs: 소속 P1 허브가 있는 상세 페이지의 중간 breadcrumb 단계들
// (홈 → 지역별 화환 안내 → 허브 → 업체명). 없으면 기존 2단 구조(홈 → 업체명) 그대로다 —
// fixture·허브 미편입 페이지는 변화 없음.
export type BreadcrumbHubCrumb = { readonly name: string; readonly item: string }

export function buildJsonLdObjects(page: PublicPageDto, hubCrumbs?: readonly BreadcrumbHubCrumb[]): readonly JsonLdObject[] {
  const breadcrumb = buildBreadcrumbJsonLd(page, hubCrumbs ?? [])
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

// sitemap(검색 제출 표면)에는 운영 DB에서 출처가 증명된 페이지만 남긴다.
// 경로 패턴이 아니라 데이터 출처(dataOrigin)로 거른다 — 합성 seed/fixture가 어떤 경로에 있든 제외된다.
export function filterSitemapIncludablePages(pages: readonly PublicPageDto[]): readonly PublicPageDto[] {
  return pages.filter((page) => page.dataOrigin === "database")
}

// 색인 정책도 데이터 출처 기준이다: DB에서 출처가 증명된 게시 페이지만 색인을 허용하고,
// 합성 seed/fixture 페이지는 직접 접근되더라도 noindex를 명시한다 (sitemap 제외와 같은 기준).
// 반환값은 Next Metadata의 robots 필드에 그대로 넣는다 — undefined면 layout 기본(index)을 따른다.
export function publicPageRobots(page: PublicPageDto): { readonly index: false; readonly follow: false } | undefined {
  return page.dataOrigin === "database" ? undefined : { index: false, follow: false }
}

function toPublicPageDto(record: PublicSeoSource): PublicPageDto {
  // 저장된 문장 안에 인용된 주소 원문도 주소 칸과 같은 표기로 내보낸다 (FAQ 화면·FAQ JSON-LD·meta description 공통).
  // 검수 주소가 적용된 장소(rawAddress가 따로 온다)는 원문 인용을 '최종 공개 주소'(축약 정책까지 거친 값)로 바꾼다.
  const publicAddress = resolvePublicAddress(record.slug, record.address)
  const publicText = (text: string): string =>
    record.rawAddress === undefined ? rewritePublicAddressInText(record.slug, record.address, text) : rewriteQuotedAddress(quotedAddressForms(record.rawAddress, record.address), publicAddress, text)
  // 검수 편집 본문 — DB에서 온 게시 페이지이고 slug·SEO 페이지 ID·장소명이 모두 같을 때만 붙는다.
  // 단건 조회·목록·sitemap이 모두 이 변환을 지나므로 본문과 수정 시각이 한곳에서 정해진다.
  const identity = { slug: record.slug, seoPageId: record.id, placeName: record.place?.name ?? null }
  const editorial = record.dataOrigin === "database" ? findCuratedEditorialBody(identity) : null
  // FAQ 답변 편집 — 저장 원문(주소 표기 정리 전)의 질문·답변이 기대값과 같을 때만 그 답변을 바꾼다.
  // 순서: ① 저장 원문에 편집 적용 → ② 주소 표기 정리. 화면과 FAQ JSON-LD가 모두 이 결과(content.faq)를 쓴다.
  const faqEdits = record.dataOrigin === "database" ? applyCuratedFaqAnswerEdits(identity, record.content.faq) : { faq: record.content.faq, applied: [] }
  // 수정 시각: DB 시각과, 실제로 적용된 편집(본문·FAQ 답변)을 고친 시각 중 가장 늦은 쪽. 재확인일·현재 시각으로 올리지 않는다.
  // 정책 참고 메모 — 출처 링크가 화면에 낼 수 있는 주소일 때만 붙인다 (출처 없는 메모는 내지 않는다).
  const foundNote = record.dataOrigin === "database" ? findCuratedPolicyNote(identity) : null
  const policyNote = foundNote !== null && isRenderableSourceUrl(foundNote.source.url) ? foundNote : null
  const editedAt = [...(editorial === null ? [] : [editorial.contentUpdatedAt]), ...faqEdits.applied.map((edit) => edit.contentUpdatedAt), ...(policyNote === null ? [] : [policyNote.contentUpdatedAt])]
  return {
    id: record.id,
    type: record.type,
    slug: record.slug,
    path: record.path,
    dataOrigin: record.dataOrigin ?? "fixture",
    title: record.title,
    description: publicText(record.description),
    // canonical은 저장값을 그대로 내보내지 않고 공개 origin + path로 다시 만든다.
    // 저장값은 상대 경로(장소 행)와 구식 절대 URL(fixture)이 섞여 있어, 여기서 절대화해야
    // 페이지 canonical·og:url·JSON-LD가 전부 같은 공개 도메인의 self-canonical이 된다.
    // record.canonicalUrl은 '공개 가능' 판정(isPublishedCanonicalPublicRecord)에만 남는다.
    canonicalUrl: buildCanonicalUrl(getPublicSiteUrl(), record.path),
    priority: record.priority,
    changeFrequency: record.changeFrequency,
    lastModifiedAt: latestIsoTimestamp(record.lastModifiedAt, editedAt),
    region: record.region,
    city: record.city,
    district: record.district,
    // 공개 표면 주소는 축약 정책을 거친다 (랜딩 배송지 정보·JSON-LD가 이 필드를 공유)
    address: publicAddress,
    homepage: record.homepage,
    ctaUrl: record.ctaUrl ?? DEFAULT_ORDER_URL,
    place: record.place,
    content: {
      ...record.content,
      faq: faqEdits.faq.map((entry) => ({ ...entry, question: publicText(entry.question), answer: publicText(entry.answer) })),
    },
    placeBody: record.placeBody === null || record.placeBody === undefined ? null : publicText(record.placeBody),
    editorialBody:
      editorial === null
        ? null
        : { paragraphs: editorial.paragraphs, sources: editorial.sources.filter((source) => isRenderableSourceUrl(source.url)), reviewedAt: editorial.reviewedAt },
    policyNote: policyNote === null ? null : { lines: policyNote.lines, source: policyNote.source, sourcePublishedAt: policyNote.sourcePublishedAt, reviewedAt: policyNote.reviewedAt },
  }
}

function buildBreadcrumbJsonLd(page: PublicPageDto, hubCrumbs: readonly BreadcrumbHubCrumb[]): JsonLdObject {
  const crumbs = [
    { name: "홈", item: DEFAULT_ORDER_URL },
    ...hubCrumbs,
    { name: page.title, item: page.canonicalUrl },
  ]
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, index) => ({ "@type": "ListItem", position: index + 1, name: crumb.name, item: crumb.item })),
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
