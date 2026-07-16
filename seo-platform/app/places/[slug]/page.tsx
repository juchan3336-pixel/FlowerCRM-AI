import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { PlaceLanding } from "@/components/public/place-landing"
import { buildJsonLdObjects } from "@/lib/public-seo/public-pages"
import { findPublishedPlacePageBySlug, listPublishedPlacePages } from "@/lib/public-seo/place-pages"

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

  const jsonLdObjects = buildJsonLdObjects(page)

  return (
    <main className="min-h-[100dvh]">
      <PlaceLanding page={page} />

      {jsonLdObjects.map((jsonLd) => (
        <script dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} key={jsonLd["@type"]} type="application/ld+json" />
      ))}
    </main>
  )
}
