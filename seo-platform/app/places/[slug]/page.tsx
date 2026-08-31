import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { PlaceLanding, type PlaceHubLink, type RelatedPlaceLink } from "@/components/public/place-landing"
import { buildCanonicalUrl, buildJsonLdObjects, publicPageRobots, type BreadcrumbHubCrumb } from "@/lib/public-seo/public-pages"
import { findPublishedPlacePageBySlug, listPublishedPlacePages } from "@/lib/public-seo/place-pages"
import { HUB_INDEX_PATH, HUB_INDEX_TITLE, hubForPage, hubPath, hubTitle, pickRelatedPlaces } from "@/lib/public-seo/region-hub"
import type { PublicPageDto } from "@/lib/public-seo/types"
import { getPublicSiteUrl } from "@/lib/site-url"

type PlacesPageProps = {
  readonly params: Promise<{ readonly slug: string }>
}

export const dynamicParams = true

export async function generateStaticParams(): Promise<{ readonly slug: string }[]> {
  const pages = await listPublishedPlacePages()
  return pages.map((page) => ({ slug: page.slug }))
}

export async function generateMetadata({ params }: PlacesPageProps): Promise<Metadata> {
  const { slug } = await params
  const page = await findPublishedPlacePageBySlug(slug)

  if (page === undefined) {
    return {
      title: "장소 SEO 페이지를 찾을 수 없습니다",
      robots: { index: false, follow: false },
    }
  }

  return {
    title: page.title,
    description: page.description,
    // 합성 fixture 페이지는 noindex — 실제 DB 게시 페이지만 layout 기본(index)을 따른다.
    robots: publicPageRobots(page),
    alternates: { canonical: page.canonicalUrl },
    openGraph: {
      title: page.title,
      description: page.description,
      url: page.canonicalUrl,
      type: "website",
    },
  }
}

export default async function PlacesPage({ params }: PlacesPageProps) {
  const { slug } = await params
  const page = await findPublishedPlacePageBySlug(slug)

  if (page === undefined) {
    notFound()
  }

  // 허브 역링크·관련 장소는 렌더 계층에서 계산한다 — AI 생성 콘텐츠(internal_links)는 수정하지 않는다.
  // 소속 P1 허브가 없으면(예: fixture·허브 미개설 지역) 기존 화면·JSON-LD와 완전히 동일하다.
  const { hubLink, hubCrumbs, relatedPlaces } = await buildHubContext(page)
  const jsonLdObjects = buildJsonLdObjects(page, hubCrumbs)

  return (
    <main className="min-h-[100dvh]">
      <PlaceLanding hubIndexHref={hubLink === null ? null : HUB_INDEX_PATH} hubIndexLabel={HUB_INDEX_TITLE} hubLink={hubLink} page={page} relatedPlaces={relatedPlaces} />

      {jsonLdObjects.map((jsonLd) => (
        <script dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} key={jsonLd["@type"]} type="application/ld+json" />
      ))}
    </main>
  )
}

// 소속 P1 허브·관련 장소 계산 — 허브가 없으면 전부 비어 있고 목록 조회도 하지 않는다.
async function buildHubContext(page: PublicPageDto): Promise<{
  readonly hubLink: PlaceHubLink | null
  readonly hubCrumbs: readonly BreadcrumbHubCrumb[] | undefined
  readonly relatedPlaces: readonly RelatedPlaceLink[]
}> {
  const hub = hubForPage(page)
  if (hub === null) {
    return { hubLink: null, hubCrumbs: undefined, relatedPlaces: [] }
  }
  const title = hubTitle(hub)
  const path = hubPath(hub)
  const siteUrl = getPublicSiteUrl()
  const allPages = await listPublishedPlacePages()
  const relatedPlaces = pickRelatedPlaces(page, allPages).map((related) => ({
    href: related.path,
    name: related.place?.name ?? related.title,
    district: related.district,
  }))
  return {
    hubLink: { href: path, label: `${title.replace(" 안내", "")} 전체 보기` },
    // 4단 breadcrumb: 홈 → 지역별 화환 안내 → 지역/업종 허브 → 업체명
    hubCrumbs: [
      { name: HUB_INDEX_TITLE, item: buildCanonicalUrl(siteUrl, HUB_INDEX_PATH) },
      { name: title, item: buildCanonicalUrl(siteUrl, path) },
    ],
    relatedPlaces,
  }
}
