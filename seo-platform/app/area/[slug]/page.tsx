import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { DEFAULT_ORDER_URL, PUBLIC_SEO_FIXTURES } from "@/lib/public-seo/fixtures"
import { buildJsonLdObjects, publicPageRobots, findPublicPageByTypeAndSlug, listPublishedPublicPages } from "@/lib/public-seo/public-pages"
import type { PublicPageDto } from "@/lib/public-seo/types"

type AreaPageProps = {
  readonly params: Promise<{ readonly slug: string }>
}

export const dynamicParams = false

export function generateStaticParams(): { readonly slug: string }[] {
  return listPublishedPublicPages(PUBLIC_SEO_FIXTURES)
    .filter((page) => page.type === "area")
    .map((page) => ({ slug: page.slug }))
}

export async function generateMetadata({ params }: AreaPageProps): Promise<Metadata> {
  const { slug } = await params
  const page = getAreaPage(slug)

  if (page === undefined) {
    return {
      title: "지역 근조화환 페이지를 찾을 수 없습니다",
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

export default async function AreaPage({ params }: AreaPageProps) {
  const { slug } = await params
  const page = getAreaPage(slug)

  if (page === undefined) {
    notFound()
  }

  const jsonLdObjects = buildJsonLdObjects(page)
  const areaText = [page.city, page.district].filter((value) => value !== null).join(" · ")

  return (
    <main className="min-h-[100dvh] px-4 py-6 sm:px-6 lg:px-8">
      <article className="mx-auto flex max-w-6xl flex-col gap-10 py-12 sm:py-16">
        <nav aria-label="breadcrumb" className="text-sm text-[var(--text-secondary)]">
          <ol className="flex flex-wrap items-center gap-2">
            <li>
              <a className="transition-colors duration-150 ease-out hover:text-[var(--accent-primary)]" href={DEFAULT_ORDER_URL}>
                홈
              </a>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="font-semibold text-[var(--text-primary)]">
              {page.title}
            </li>
          </ol>
        </nav>

        <header className="grid gap-6 rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6 sm:p-8 lg:grid-cols-[1fr_auto] lg:items-end">
          <div className="flex max-w-3xl flex-col gap-4">
            <p className="w-fit rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-2 text-sm font-semibold text-[var(--accent-primary)]">
              지역 근조화환 배송 안내
            </p>
            <h1 className="text-4xl font-bold tracking-[-0.015em] text-[var(--text-primary)] sm:text-5xl">
              {page.title}
            </h1>
            <p className="text-base leading-7 text-[var(--text-secondary)]">{page.description}</p>
            <p className="text-base leading-7 text-[var(--text-secondary)]">
              {page.region ?? "전국"} 장례식장과 병원으로 보내는 근조화환 주문 정보를 팔도플라워 공식 주문 페이지로
              연결합니다.
            </p>
            {areaText.length > 0 ? <p className="text-sm leading-6 text-[var(--text-secondary)]">{areaText}</p> : null}
          </div>
          <a
            className="inline-flex items-center justify-center rounded-full bg-[var(--accent-primary)] px-6 py-3 text-sm font-semibold text-[var(--surface-elevated)] transition-colors duration-150 ease-out hover:bg-[var(--accent-hover)]"
            href={page.ctaUrl}
          >
            팔도플라워에서 주문하기
          </a>
        </header>

        <section className="grid gap-4 md:grid-cols-3" aria-label="페이지 요약">
          <SummaryCard label="지역" value={page.region ?? "전국 배송 상담"} />
          <SummaryCard label="배송 대상" value="장례식장 · 병원" />
          <SummaryCard label="주문 연결" value="팔도플라워 공식 주문 페이지" />
        </section>

        <section className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <div className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6 sm:p-8">
            <h2 className="text-3xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">자주 묻는 질문</h2>
            <div className="mt-6 flex flex-col gap-4">
              {page.content.faq.map((entry) => (
                <details className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5" key={entry.question}>
                  <summary className="cursor-pointer text-base font-semibold text-[var(--text-primary)]">{entry.question}</summary>
                  <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">{entry.answer}</p>
                </details>
              ))}
            </div>
          </div>

          <aside className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6 sm:p-8">
            <h2 className="text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">지역 페이지 안내</h2>
            <ul className="mt-5 flex flex-col gap-3">
              {page.content.keywords.map((keyword) => (
                <li className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm font-semibold text-[var(--text-primary)]" key={keyword}>
                  {keyword}
                </li>
              ))}
            </ul>

            <h2 className="mt-8 text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">관련 안내</h2>
            <ul className="mt-5 flex flex-col gap-3">
              {page.content.internalLinks.map((link) => (
                <li key={link.href}>
                  <a className="block rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm font-semibold text-[var(--accent-primary)] transition-colors duration-150 ease-out hover:text-[var(--accent-hover)]" href={link.href}>
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </aside>
        </section>
      </article>

      {jsonLdObjects.map((jsonLd) => (
        <script
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
          key={jsonLd["@type"]}
          type="application/ld+json"
        />
      ))}
    </main>
  )
}

function getAreaPage(slug: string): PublicPageDto | undefined {
  return findPublicPageByTypeAndSlug(PUBLIC_SEO_FIXTURES, "area", slug)
}

function SummaryCard({ label, value }: Readonly<{ readonly label: string; readonly value: string }>) {
  return (
    <div className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">{label}</p>
      <p className="mt-3 text-xl font-semibold text-[var(--text-primary)]">{value}</p>
    </div>
  )
}
