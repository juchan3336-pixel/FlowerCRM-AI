import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { DEFAULT_ORDER_URL } from "@/lib/public-seo/fixtures"
import { listPublishedPlacePages } from "@/lib/public-seo/place-pages"
import { buildCanonicalUrl } from "@/lib/public-seo/public-pages"
import {
  HUB_INDEX_PATH,
  HUB_INDEX_TITLE,
  hubPath,
  hubTitle,
  listActiveHubSummaries,
  SIDO_LABELS,
  type ActiveHubSummary,
  type HubType,
} from "@/lib/public-seo/region-hub"
import type { JsonLdObject } from "@/lib/public-seo/types"
import { getPublicSiteUrl } from "@/lib/site-url"

// 지역별 화환 안내 인덱스 — 아임웹 본체가 연결하는 단일 대표 진입점.
// 활성 허브 목록·장소 수는 published 데이터에서 매 렌더 시 계산한다 (허브 상세와 같은 계약).
export const dynamic = "force-dynamic"

const META_DESCRIPTION = "지역별 장례식장 근조화환, 예식장·행사 축하화환, 기업·사업장 축하화환 안내를 확인할 수 있습니다. 공식 정보 확인을 거친 장소를 지역과 목적으로 찾아보세요."

// 섹션 구성 — 업종 축 3개. 활성 허브가 없는 섹션은 표시하지 않는다.
const SECTIONS: readonly Readonly<{ hubType: HubType; heading: string; blurb: string }>[] = [
  { hubType: "funeral", heading: "근조화환", blurb: "장례식장별 근조화환 주문 전 확인할 정보를 지역별로 안내합니다." },
  { hubType: "wedding", heading: "축하화환 — 예식·행사", blurb: "예식장·웨딩홀·컨벤션의 축하화환 안내를 지역별로 모았습니다." },
  { hubType: "corporate", heading: "기업·사업장 축하화환", blurb: "개업·준공·창립 등 기업 행사 축하화환 안내입니다." },
]

export function generateMetadata(): Metadata {
  const canonicalUrl = buildCanonicalUrl(getPublicSiteUrl(), HUB_INDEX_PATH)
  const title = `${HUB_INDEX_TITLE} | 팔도플라워`
  return {
    title,
    description: META_DESCRIPTION,
    alternates: { canonical: canonicalUrl },
    openGraph: { title, description: META_DESCRIPTION, url: canonicalUrl, type: "website" },
  }
}

export default async function HubIndexPage() {
  const pages = await listPublishedPlacePages()
  const summaries = listActiveHubSummaries(pages)
  // 활성 허브가 하나도 없으면 인덱스도 열지 않는다 (soft 404 방지 — sitemap 포함 기준과 동일).
  if (summaries.length === 0) {
    notFound()
  }
  const canonicalUrl = buildCanonicalUrl(getPublicSiteUrl(), HUB_INDEX_PATH)
  const jsonLdObjects = buildHubIndexJsonLd(summaries, canonicalUrl)

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
            <li aria-current="page" className="font-semibold text-[var(--text-primary)]">
              {HUB_INDEX_TITLE}
            </li>
          </ol>
        </nav>

        <header className="flex flex-col gap-4 rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6 sm:p-8">
          <h1 className="text-3xl font-bold tracking-[-0.015em] text-[var(--text-primary)] sm:text-4xl">{HUB_INDEX_TITLE}</h1>
          <p className="max-w-3xl text-base leading-7 text-[var(--text-secondary)]">
            팔도플라워에서 실제 확인을 거친 장례식장·예식장·기업 사업장 정보를 지역별로 찾아볼 수 있습니다. 지역과 목적을 고르면 해당 지역의 장소
            목록과 화환 주문 전 확인할 정보를 안내합니다.
          </p>
        </header>

        {SECTIONS.map((section) => {
          const sectionHubs = summaries.filter((summary) => summary.hub.hubType === section.hubType)
          if (sectionHubs.length === 0) {
            return null
          }
          return (
            <section aria-label={section.heading} className="flex flex-col gap-4" key={section.hubType}>
              <div>
                <h2 className="text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">{section.heading}</h2>
                <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">{section.blurb}</p>
              </div>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {sectionHubs.map(({ hub, count }) => (
                  <li key={hub.slug}>
                    <a
                      className="flex h-full flex-col gap-2 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 transition-colors duration-150 ease-out hover:border-[var(--accent-primary)]"
                      href={hubPath(hub)}
                    >
                      <span className="text-lg font-semibold text-[var(--text-primary)]">{SIDO_LABELS[hub.sido]}</span>
                      <span className="text-sm text-[var(--text-secondary)]">{hubTitle(hub)}</span>
                      <span className="mt-auto flex items-center justify-between pt-2 text-sm">
                        <span className="font-semibold text-[var(--text-primary)]">{count}곳 안내 중</span>
                        <span aria-hidden className="font-semibold text-[var(--accent-primary)]">
                          보러 가기 →
                        </span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}

        <p className="text-xs leading-5 text-[var(--text-secondary)]">
          목록에 없는 지역은 확인된 장소가 준비되는 대로 추가됩니다. 각 장소 정보는 공식 안내를 기준으로 확인한 내용이며, 방문 전 시설 측 확인을
          함께 이용하시기 바랍니다.
        </p>
      </article>

      {jsonLdObjects.map((jsonLd) => (
        <script dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} key={jsonLd["@type"]} type="application/ld+json" />
      ))}
    </main>
  )
}

function buildHubIndexJsonLd(summaries: readonly ActiveHubSummary[], canonicalUrl: string): readonly JsonLdObject[] {
  const siteUrl = getPublicSiteUrl()
  return [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "홈", item: DEFAULT_ORDER_URL },
        { "@type": "ListItem", position: 2, name: HUB_INDEX_TITLE, item: canonicalUrl },
      ],
    },
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: HUB_INDEX_TITLE,
      description: META_DESCRIPTION,
      url: canonicalUrl,
    },
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      itemListElement: summaries.map(({ hub }, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: hubTitle(hub),
        url: buildCanonicalUrl(siteUrl, hubPath(hub)),
      })),
    },
  ]
}
