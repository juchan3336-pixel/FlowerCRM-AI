import { z } from "zod"

import { resolveVerifiedAddress } from "@/lib/domain/verified-address"
import { PUBLIC_SEO_RECORDS } from "@/lib/public-seo/fixtures"
import { findPublicPageByTypeAndSlug, listPublishedPublicPages } from "@/lib/public-seo/public-pages"
import type { PublicPageDto, PublicSeoContent, PublicSeoSource } from "@/lib/public-seo/types"
import type { PublicPlacePageRow } from "@/types/database"

export type PublicPlacePagesRepository = {
  readonly findPublishedPlaceBySlug: (slug: string) => Promise<PublicPlacePageRow | null>
  readonly listPublishedPlaces: () => Promise<readonly PublicPlacePageRow[]>
}

const PublicFaqSchema = z.object({ question: z.string(), answer: z.string() })
const PublicInternalLinkSchema = z.object({ href: z.string(), label: z.string() })
const PublicSeoContentSchema = z.object({
  faq: z.array(PublicFaqSchema).default([]),
  keywords: z.array(z.string()).default([]),
  internalLinks: z.array(PublicInternalLinkSchema).default([]),
})

export async function listPublishedPlacePages(repository?: PublicPlacePagesRepository): Promise<readonly PublicPageDto[]> {
  if (repository === undefined && !hasSupabasePublicPlacePagesEnv()) {
    return listPublishedPublicPages(PUBLIC_SEO_RECORDS).filter((page) => page.type === "place")
  }

  const publicPlacePagesRepository = repository ?? (await createSupabasePublicPlacePagesRepository())
  const rows = await publicPlacePagesRepository.listPublishedPlaces()
  return rows.flatMap((row) => {
    const source = publicPlacePageRowToSource(row)
    return source === null ? [] : listPublishedPublicPages([source])
  })
}

export async function findPublishedPlacePageBySlug(slug: string): Promise<PublicPageDto | undefined> {
  if (!hasSupabasePublicPlacePagesEnv()) {
    return findPublicPageByTypeAndSlug(PUBLIC_SEO_RECORDS, "place", slug)
  }

  const repository = await createSupabasePublicPlacePagesRepository()
  const row = await repository.findPublishedPlaceBySlug(slug)
  if (row === null) {
    return undefined
  }

  const source = publicPlacePageRowToSource(row)
  if (source === null) {
    return undefined
  }

  return findPublicPageByTypeAndSlug([source], "place", slug)
}

export function publicPlacePageRowToSource(row: PublicPlacePageRow): PublicSeoSource | null {
  if (row.page_type !== "place") {
    return null
  }

  const title = row.title ?? row.meta_title ?? row.name
  const description = row.page_description ?? row.meta_description ?? row.place_description
  if (title === null || description === null || row.canonical_url === null) {
    return null
  }

  // 검수 주소 — 등록 장소는 공식 확인된 주소만 공개한다. 등록 값과 현재 이름·slug·주소 원문이 다르면(conflict)
  // 원문 주소로 되돌아가지 않고 이 페이지를 공개 표면에서 내린다: 상세는 notFound, 목록·sitemap·허브에서도 빠진다.
  // 저장된 문장 속 주소를 고쳐 쓰는 것으로는 제목·FAQ·본문에 남은 변형 인용까지 보장할 수 없기 때문이다.
  // DB의 게시 상태는 바꾸지 않는다 — 엔트리를 다시 확인해 갱신하면 다시 공개된다.
  const addressResolution = resolveVerifiedAddress({ placeId: row.place_id, slug: row.place_slug, name: row.name, rawAddress: row.address })
  if (addressResolution.kind === "conflict" || (addressResolution.kind === "matched" && row.page_slug !== row.place_slug)) {
    return null
  }
  const dbLastModifiedAt = row.last_modified_at ?? new Date(0).toISOString()

  return {
    id: row.seo_page_id,
    type: "place",
    slug: row.page_slug,
    path: row.path,
    // 공개 안전 뷰에서 온 실제 게시 데이터 — sitemap 포함 판정의 근거가 된다.
    dataOrigin: "database",
    status: "published",
    title,
    description,
    canonicalUrl: row.canonical_url,
    priority: row.priority,
    changeFrequency: row.change_frequency,
    // 검수 주소가 실제로 적용된 페이지만 엔트리 수정 시각을 반영한다.
    lastModifiedAt: addressResolution.kind === "matched" && Date.parse(addressResolution.contentUpdatedAt) > Date.parse(dbLastModifiedAt) ? addressResolution.contentUpdatedAt : dbLastModifiedAt,
    region: row.region,
    city: row.city,
    district: row.district,
    // 이후 단계(public-pages)의 축약·꼬리 정리 정책은 이 값에 그대로 적용된다 — 검수 주소가 기존 축약을 풀지 않는다.
    address: addressResolution.kind === "matched" ? addressResolution.address : row.address,
    homepage: row.homepage,
    ctaUrl: row.order_url,
    place: row.name === null || row.category === null ? null : { name: row.name, category: row.category, detailCategory: row.detail_category },
    content: parsePublicSeoContent(row),
    // 장소 본문은 별도 필드로 전달한다 — description은 SEO 설명 체인(page ?? meta ?? place) 그대로 유지.
    placeBody: row.place_description,
  }
}

function hasSupabasePublicPlacePagesEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["NEXT_PUBLIC_SUPABASE_URL"] !== undefined && env["SUPABASE_SERVICE_ROLE_KEY"] !== undefined
}

async function createSupabasePublicPlacePagesRepository(): Promise<PublicPlacePagesRepository> {
  const { createSupabaseServiceRoleClient } = await import("@/lib/supabase/server")
  const client = createSupabaseServiceRoleClient()

  return {
    async findPublishedPlaceBySlug(slug: string): Promise<PublicPlacePageRow | null> {
      const { data, error } = await client.from("published_place_pages").select("*").eq("page_type", "place").eq("page_slug", slug).maybeSingle()
      if (error !== null) {
        throw new PublicPlacePagesReadError(error.message)
      }
      return data
    },
    async listPublishedPlaces(): Promise<readonly PublicPlacePageRow[]> {
      const { data, error } = await client.from("published_place_pages").select("*").eq("page_type", "place").order("path", { ascending: true })
      if (error !== null) {
        throw new PublicPlacePagesReadError(error.message)
      }
      return data
    },
  }
}

function parsePublicSeoContent(row: PublicPlacePageRow): PublicSeoContent {
  const parsed = PublicSeoContentSchema.safeParse({ faq: row.faq, keywords: row.keywords, internalLinks: row.internal_links })
  if (parsed.success) {
    return parsed.data
  }
  return { faq: [], keywords: [], internalLinks: [] }
}

class PublicPlacePagesReadError extends Error {
  readonly name = "PublicPlacePagesReadError"

  constructor(readonly detail: string) {
    super(`Failed to read public place pages: ${detail}`)
  }
}
