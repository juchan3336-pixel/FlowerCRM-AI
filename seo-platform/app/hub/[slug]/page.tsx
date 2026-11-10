import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { buildHubCopy } from "@/lib/public-seo/hub-copy"
import { DEFAULT_ORDER_URL } from "@/lib/public-seo/fixtures"
import { listPublishedPlacePages } from "@/lib/public-seo/place-pages"
import { buildCanonicalUrl } from "@/lib/public-seo/public-pages"
import {
  findHubBySlug,
  groupPagesByHub,
  HUB_INDEX_PATH,
  HUB_INDEX_TITLE,
  hubMemberAnchor,
  hubPath,
  hubTitle,
  HUB_TYPE_COPY,
  P1_HUBS,
  SIDO_LABELS,
} from "@/lib/public-seo/region-hub"
import type { JsonLdObject, PublicPageDto } from "@/lib/public-seo/types"
import { getPublicSiteUrl } from "@/lib/site-url"

// 허브는 published 데이터를 그대로 비추는 표면이다 — 게시/보관 직후 상태가 바로 반영되도록
// 빌드 시점 고정 없이 항상 현재 DB를 읽는다 (sitemap과 같은 계약).
export const dynamic = "force-dynamic"

type HubPageProps = {
  readonly params: Promise<{ readonly slug: string }>
}

export async function generateMetadata({ params }: HubPageProps): Promise<Metadata> {
  const { slug } = await params
  const hub = findHubBySlug(slug)
  if (hub === undefined) {
    return { title: "허브 페이지를 찾을 수 없습니다", robots: { index: false, follow: false } }
  }
  const members = await loadHubMembers(slug)
  if (members.length === 0) {
    return { title: "허브 페이지를 찾을 수 없습니다", robots: { index: false, follow: false } }
  }
  const copy = buildHubCopy(hub, members.length)
  const canonicalUrl = buildCanonicalUrl(getPublicSiteUrl(), hubPath(hub))
  return {
    title: copy.metaTitle,
    description: copy.metaDescription,
    alternates: { canonical: canonicalUrl },
    openGraph: { title: copy.metaTitle, description: copy.metaDescription, url: canonicalUrl, type: "website" },
  }
}

export default async function HubPage({ params }: HubPageProps) {
  const { slug } = await params
  const hub = findHubBySlug(slug)
  if (hub === undefined) {
    notFound()
  }
  const members = await loadHubMembers(slug)
  // 구성원 0인 허브는 열지 않는다 — 빈 목록 페이지는 soft 404가 된다 (sitemap 포함 기준과 동일).
  if (members.length === 0) {
    notFound()
  }

  const copy = buildHubCopy(hub, members.length)
  const canonicalUrl = buildCanonicalUrl(getPublicSiteUrl(), hubPath(hub))
  const { facilityLabel, wreathLabel } = HUB_TYPE_COPY[hub.hubType]
  const relatedHubs = P1_HUBS.filter((entry) => entry.slug !== hub.slug)
  const jsonLdObjects = buildHubJsonLd({ heading: copy.heading, description: copy.metaDescription, canonicalUrl, members })

  return (
    <main className="min-h-[100dvh] px-4 py-6 sm:px-6 lg:px-8">
      <article className="mx-auto flex max-w-5xl flex-col gap-10 py-10 sm:py-14">
        <nav aria-label="breadcrumb" className="text-sm text-[var(--text-secondary)]">
          <ol className="flex flex-wrap items-center gap-2">
            <li>
              <a className="transition-colors duration-150 ease-out hover:text-[var(--accent-primary)]" href={DEFAULT_ORDER_URL}>
                홈
              </a>
            </li>
            <li aria-hidden="true">/</li>
            <li>
              <a className="transition-colors duration-150 ease-out hover:text-[var(--accent-primary)]" href={HUB_INDEX_PATH}>
                {HUB_INDEX_TITLE}
              </a>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="font-semibold text-[var(--text-primary)]">
              {copy.heading}
            </li>
          </ol>
        </nav>

        <header className="flex flex-col gap-4 rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6 sm:p-8">
          <p className="w-fit rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-2 text-sm font-semibold text-[var(--accent-primary)]">
            {SIDO_LABELS[hub.sido]} · {facilityLabel} {wreathLabel}
          </p>
          <h1 className="text-3xl font-bold tracking-[-0.015em] text-[var(--text-primary)] sm:text-4xl">{copy.heading}</h1>
          <p className="max-w-3xl text-base leading-7 text-[var(--text-secondary)]">{copy.intro}</p>
          <p className="text-sm font-semibold text-[var(--text-primary)]">현재 안내 중인 {facilityLabel} {members.length}곳</p>
        </header>

        <section aria-label={`${copy.heading} 목록`} className="flex flex-col gap-3">
          <h2 className="text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
            {SIDO_LABELS[hub.sido]} {facilityLabel} 목록
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {members.map((page) => (
              <li key={page.path}>
                <a
                  className="flex h-full flex-col gap-1.5 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 transition-colors duration-150 ease-out hover:border-[var(--accent-primary)]"
                  href={page.path}
                >
                  <span className="text-base font-semibold text-[var(--accent-primary)]">{hubMemberAnchor(hub, page.place?.name ?? page.title)}</span>
                  <span className="text-sm text-[var(--text-secondary)]">
                    {[page.district, page.address].filter((value): value is string => value !== null && value.length > 0).filter((value, index, all) => all.indexOf(value) === index).join(" · ")}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="주문 전 확인 사항" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">{copy.checklistTitle}</h2>
          <ul className="mt-5 flex list-disc flex-col gap-2 pl-5 text-sm leading-6 text-[var(--text-secondary)]">
            {copy.checklist.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <section aria-label="자주 묻는 질문" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6 sm:p-8">
          <h2 className="text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">자주 묻는 질문</h2>
          <div className="mt-5 flex flex-col gap-4">
            {copy.faq.map((entry) => (
              <details className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5" key={entry.question}>
                <summary className="cursor-pointer text-base font-semibold text-[var(--text-primary)]">{entry.question}</summary>
                <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">{entry.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <nav aria-label="다른 지역·업종 안내" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-6">
          <p className="text-sm font-bold text-[var(--text-secondary)]">다른 지역·업종 안내</p>
          <ul className="mt-3 flex flex-wrap gap-2">
            <li>
              <a
                className="inline-flex rounded-full border border-[var(--accent-primary)] bg-[var(--surface-elevated)] px-4 py-2 text-sm font-semibold text-[var(--accent-primary)] transition-colors duration-150 ease-out hover:bg-[var(--accent-primary)]/5"
                href={HUB_INDEX_PATH}
              >
                {HUB_INDEX_TITLE} 전체
              </a>
            </li>
            {relatedHubs.map((entry) => (
              <li key={entry.slug}>
                <a
                  className="inline-flex rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2 text-sm font-semibold text-[var(--accent-primary)] transition-colors duration-150 ease-out hover:border-[var(--accent-primary)]"
                  href={hubPath(entry)}
                >
                  {hubTitle(entry)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </article>

      {jsonLdObjects.map((jsonLd) => (
        <script dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} key={jsonLd["@type"]} type="application/ld+json" />
      ))}
    </main>
  )
}

async function loadHubMembers(slug: string): Promise<readonly PublicPageDto[]> {
  const pages = await listPublishedPlacePages()
  const { byHub } = groupPagesByHub(pages)
  return byHub.get(slug) ?? []
}

function buildHubJsonLd(input: Readonly<{ heading: string; description: string; canonicalUrl: string; members: readonly PublicPageDto[] }>): readonly JsonLdObject[] {
  const siteUrl = getPublicSiteUrl()
  return [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "홈", item: DEFAULT_ORDER_URL },
        { "@type": "ListItem", position: 2, name: HUB_INDEX_TITLE, item: buildCanonicalUrl(siteUrl, HUB_INDEX_PATH) },
        { "@type": "ListItem", position: 3, name: input.heading, item: input.canonicalUrl },
      ],
    },
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: input.heading,
      description: input.description,
      url: input.canonicalUrl,
    },
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      itemListElement: input.members.map((page, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: page.place?.name ?? page.title,
        url: buildCanonicalUrl(siteUrl, page.path),
      })),
    },
  ]
}
