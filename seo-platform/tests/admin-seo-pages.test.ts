import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import AdminSeoPagesPage, { AdminSeoPagesContent } from "@/app/admin/seo-pages/page"
import { generateSelectedSampleSeoPages, publishSelectedReadySeoPages } from "@/lib/admin/seo-page-actions"
import { loadAdminSeoPages } from "@/lib/admin/seo-pages"
import type { AdminSeoPageActionRepository } from "@/lib/admin/seo-page-actions"
import type { AdminSeoPageSource, AdminSeoPagesRepository } from "@/lib/admin/seo-pages"
import { PUBLIC_SEO_FIXTURES } from "@/lib/public-seo/fixtures"
import { listPublishedPublicPages } from "@/lib/public-seo/public-pages"
import { PRODUCTION_SITE_URL } from "@/lib/site-url"
import type { SeoPageStatus } from "@/lib/domain/constants"
import type { SeoPageForPlaceGeneration, SelectablePlaceForSeoGeneration } from "@/lib/seo-pages/place-generation"

const HEADER_LABELS = ["SEO 페이지", "페이지 유형", "경로", "canonical URL", "상태", "사이트맵", "우선순위", "변경 빈도"] as const
const FILTER_LABELS = ["페이지 유형 필터", "상태 필터", "사이트맵 포함 필터", "canonical 상태 필터"] as const
const CANDIDATE_LABELS = ["후보 품질", "선택 가능", "경고", "차단", "선택 샘플 생성", "선택 ready-page 게시"] as const
const PRIVATE_TOKENS = ["email", "memo", "imported_payload", "synced_at", "service_role", "SUPABASE_SERVICE_ROLE_KEY", "Bearer ", "private@example.com", "010-9999-0000"] as const

describe("admin SEO pages overview", () => {
  it("renders fixture-backed headers and safe public rows when Supabase env is absent", async () => {
    // Given: the SEO pages admin overview server component.
    const pages = listPublishedPublicPages(PUBLIC_SEO_FIXTURES)

    // When: the page renders from public SEO DTO fixtures.
    const markup = renderToStaticMarkup(await AdminSeoPagesPage())

    // Then: table headers and every published public fixture row are visible.
    for (const label of HEADER_LABELS) {
      expect(markup).toContain(label)
    }
		for (const page of pages) {
			expect(markup).toContain(page.type)
			expect(markup).toContain(page.path)
			expect(markup).toContain(page.canonicalUrl)
	      expect(markup).toContain(String(page.priority))
	      expect(markup).toContain(page.changeFrequency)
	    }
  })

  it("loads Supabase public view rows through the read-only SEO pages seam", async () => {
    // Given: a credential-free fake repository matching the public-safe view shape.
    const repository: AdminSeoPagesRepository = {
      listPublishedPlacePages() {
        return Promise.resolve([
          {
            seo_page_id: "seo_live_1",
            page_type: "hospital",
            page_slug: "hospital-live-test",
            path: "/hospital/hospital-live-test",
            title: "Live hospital page",
            page_description: "Public description",
            canonical_url: "https://seo.paldoflower.test/hospital/hospital-live-test",
            priority: 0.8,
            change_frequency: "weekly",
            last_modified_at: "2026-07-03T00:00:00.000Z",
            place_id: "place_live_1",
            name: "라이브 병원",
            category: "hospital",
            detail_category: "종합병원",
            region: "서울 강남구",
            city: "서울",
            district: "강남구",
            address: "서울 강남구 테헤란로 1",
            homepage: null,
            place_slug: "live-place",
            order_url: null,
            place_description: "Place description",
            meta_title: "Meta title",
            meta_description: "Meta description",
            faq: [],
            keywords: [],
            internal_links: [],
          },
        ])
      },
      listAdminSeoPages() {
        return Promise.resolve([
          {
            id: "seo_live_1",
            place_id: "place_live_1",
            page_type: "hospital",
            slug: "hospital-live-test",
            path: "/hospital/hospital-live-test",
            title: "Live hospital page",
            description: "Public description",
            canonical_url: "https://seo.paldoflower.test/hospital/hospital-live-test",
            status: "published",
            priority: 0.8,
            change_frequency: "weekly",
            last_modified_at: "2026-07-03T00:00:00.000Z",
          },
        ])
      },
      listCandidatePlaces() {
        return Promise.resolve([])
      },
      listPlaceSeoPageContexts() {
        return Promise.resolve([])
      },
    }

    // When: SEO pages are loaded and rendered through the same admin content component.
    const seoPages = await loadAdminSeoPages(repository)
    const markup = renderToStaticMarkup(createElement(AdminSeoPagesContent, { seoPages }))

    // Then: public view values render without live Supabase credentials.
    expect(seoPages.source).toBe("supabase")
    expect(markup).toContain("Supabase 공개 안전 뷰")
    expect(markup).toContain("hospital")
    expect(markup).toContain("/hospital/hospital-live-test")
    expect(markup).toContain(`${PRODUCTION_SITE_URL}/hospital/hospital-live-test`)
    expect(markup).toContain("weekly")
  })

  it("renders filters plus selected generation and selected publish controls", async () => {
    // Given: fixture-backed admin page filters and operator-controlled forms.
    // When: the page renders as static markup.
    const markup = renderToStaticMarkup(await AdminSeoPagesPage())

    // Then: filters remain visible and the page exposes only selected-action controls.
    for (const label of FILTER_LABELS) {
      expect(markup).toContain(label)
    }
    for (const label of CANDIDATE_LABELS) {
      expect(markup).toContain(label)
    }
    expect(markup).toContain('name="placeId"')
    expect(markup).toContain("ready-page 샘플 생성을 위해 선택 가능 또는 경고 후보 5~100개를 고르세요")
    expect(markup).not.toContain("Select 1-100 eligible or warning candidates")
    expect(markup).toContain('name="seoPageId"')
    expect(markup).not.toContain("Generate all")
    expect(markup).not.toContain("Publish all")
  })

  it("computes candidate quality counts from the admin loader seam", async () => {
    // Given: one eligible, one warning-only, and one blocked candidate.
    const repository: AdminSeoPagesRepository = createAdminRepository({
      places: [
        placeCandidate({ id: "place_eligible", name: "Eligible Hall", slug: "eligible-hall", city: "Busan", district: "Haeundae" }),
        placeCandidate({ id: "place_warning", name: "Warning Hall", slug: "warning-hall", city: null, district: null }),
        placeCandidate({ id: "place_blocked", name: "Blocked Hall", slug: "blocked-hall", city: "Busan", district: "Suyeong" }),
      ],
      seoPages: [seoPageContext({ id: "seo_blocker", place_id: "place_blocked", path: "/places/blocked-hall", status: "ready" })],
    })

    // When: the loader classifies candidates for the admin page.
    const seoPages = await loadAdminSeoPages(repository)
    const markup = renderToStaticMarkup(createElement(AdminSeoPagesContent, { seoPages }))

    // Then: counts and row-level quality states are deterministic without Supabase env.
    expect(seoPages.candidates.counts).toEqual({ eligible: 1, warning: 1, blocked: 1 })
    expect(markup).toContain("Eligible Hall")
    expect(markup).toContain("warning")
    expect(markup).toContain("existing_place_page")
  })

  it("rejects 101 selected sample candidates before writing", async () => {
    // Given: an authenticated action seam with too many selected place IDs.
    const repository = new ActionRepositoryStub([])
    const placeIds = Array.from({ length: 101 }, (_, index) => `place_${String(index)}`)

    // When: selected generation runs through the server-side action helper.
    const result = await generateSelectedSampleSeoPages({ repository, placeIds, assertAllowed: allowAdmin })

    // Then: it returns a safe typed rejection and performs no writes.
    expect(result).toMatchObject({ kind: "rejected", reason: "SampleLimitExceeded", selected: 101, created: 0 })
    expect(repository.insertedPages).toEqual([])
    expect(repository.authChecks).toBe(1)
  })

  it("rejects 4 selected sample candidates before writing", async () => {
    // Given: an authenticated action seam with too few selected place IDs.
    const repository = new ActionRepositoryStub([])
    const placeIds = Array.from({ length: 4 }, (_, index) => `place_${String(index)}`)

    // When: selected generation runs through the server-side action helper.
    const result = await generateSelectedSampleSeoPages({ repository, placeIds, assertAllowed: allowAdmin })

    // Then: it returns a safe typed rejection and performs no writes.
    expect(result).toMatchObject({ kind: "rejected", reason: "SampleMinimumNotMet", selected: 4, created: 0 })
    expect(repository.insertedPages).toEqual([])
    expect(repository.authChecks).toBe(1)
  })

  it("publishes only selected ready SEO pages through the action repository seam", async () => {
    // Given: selected ready, draft, and archived pages in the action repository.
    const repository = new ActionRepositoryStub([
      { id: "seo_ready", status: "ready" },
      { id: "seo_draft", status: "draft" },
      { id: "seo_archived", status: "archived" },
    ])

    // When: all three IDs are submitted for selected publish.
    const result = await publishSelectedReadySeoPages({ repository, seoPageIds: ["seo_ready", "seo_draft", "seo_archived"], assertAllowed: allowAdmin })

    // Then: only the ready row transitions to published.
    expect(result).toEqual({ kind: "published", selected: 3, published: 1 })
    expect(repository.statusOf("seo_ready")).toBe("published")
    expect(repository.statusOf("seo_draft")).toBe("draft")
    expect(repository.statusOf("seo_archived")).toBe("archived")
    expect(repository.authChecks).toBe(1)
  })

  it("shows sitemap inclusion and canonical health without private tokens", async () => {
    // Given: public SEO fixtures include private source fields outside DTOs.
    // When: the admin overview renders public DTO and sitemap-derived state.
    const markup = renderToStaticMarkup(await AdminSeoPagesPage())

    // Then: sitemap/canonical status is visible and private/service-role tokens never render.
    expect(markup).toContain("사이트맵 포함")
    expect(markup).toContain("canonical 정상")
    for (const token of PRIVATE_TOKENS) {
      expect(markup).not.toContain(token)
    }
  })
})

function allowAdmin(repository: ActionRepositoryStub): Promise<void> {
  repository.authChecks += 1
  return Promise.resolve()
}

function createAdminRepository(input: Readonly<{ places: readonly SelectablePlaceForSeoGeneration[]; seoPages: readonly AdminSeoPageSource[] }>): AdminSeoPagesRepository {
  return {
    listPublishedPlacePages() {
      return Promise.resolve([])
    },
    listAdminSeoPages() {
      return Promise.resolve(input.seoPages)
    },
    listCandidatePlaces() {
      return Promise.resolve(input.places)
    },
    listPlaceSeoPageContexts() {
      return Promise.resolve(input.seoPages)
    },
  }
}

function placeCandidate(input: Readonly<{ id: string; name: string; slug: string; city: string | null; district: string | null }>): SelectablePlaceForSeoGeneration {
  return {
    id: input.id,
    name: input.name,
    address: "부산 해운대구 센텀로 1",
    category: "funeral",
    slug: input.slug,
    city: input.city,
    district: input.district,
    description: null,
    meta_title: null,
    meta_description: null,
  }
}

function seoPageContext(input: Readonly<{ id: string; place_id: string | null; path: string; status: SeoPageStatus }>): AdminSeoPageSource {
  return {
    id: input.id,
    place_id: input.place_id,
    page_type: "place",
    slug: input.path.replace("/places/", ""),
    path: input.path,
    title: "SEO title",
    description: "SEO description",
    canonical_url: input.path,
    status: input.status,
    priority: 0.7,
    change_frequency: "weekly",
    last_modified_at: "2026-07-07T00:00:00.000Z",
  }
}

type ActionSeoPage = {
  readonly id: string
  readonly status: SeoPageStatus
}

class ActionRepositoryStub implements AdminSeoPageActionRepository {
  readonly insertedPages: SeoPageForPlaceGeneration[] = []
  authChecks = 0
  private readonly pages: Map<string, SeoPageStatus>

  constructor(pages: readonly ActionSeoPage[]) {
    this.pages = new Map(pages.map((page) => [page.id, page.status]))
  }

  listSelectedPlaces(): Promise<readonly SelectablePlaceForSeoGeneration[]> { return Promise.resolve([]) }

  listPlaceSeoPageContexts(): Promise<readonly SeoPageForPlaceGeneration[]> { return Promise.resolve([]) }

  insertReadyPlaceSeoPages(pages: readonly SeoPageForPlaceGeneration[]): Promise<number> {
    this.insertedPages.push(...pages)
    return Promise.resolve(pages.length)
  }

  publishSelectedReadySeoPages(seoPageIds: readonly string[]): Promise<number> {
    let published = 0
    for (const seoPageId of seoPageIds) {
      if (this.pages.get(seoPageId) === "ready") {
        this.pages.set(seoPageId, "published")
        published += 1
      }
    }
    return Promise.resolve(published)
  }

  statusOf(seoPageId: string): SeoPageStatus | undefined { return this.pages.get(seoPageId) }
}
