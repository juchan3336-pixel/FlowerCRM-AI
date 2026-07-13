import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { PlaceDetailDrawer } from "@/components/admin/place-detail-drawer"
import { loadAdminPlaceDetail, parseGenerationOutput } from "@/lib/admin/place-detail"
import type { AdminPlaceDetail, AdminPlaceDetailRepository } from "@/lib/admin/place-detail"
import type { AdminPlacesWorkspaceParams } from "@/lib/admin/places-url"
import type { PlaceRow } from "@/types/database"

vi.mock("@/app/admin/places/actions", () => ({
  generatePlaceAiPreviewAction: "/admin/places",
  preparePlacePublishAction: "/admin/places",
}))

const DEFAULT_PARAMS: AdminPlacesWorkspaceParams = { q: null, task: null, page: 1, pageSize: 50, selected: "place-1", preview: false, notice: null }

describe("admin place detail loader", () => {
  it("maps place content, seo page, and generation history", async () => {
    // Given: a repository with an applied place, a ready seo page, and two generations.
    const repository = fakeRepository({
      place: makePlaceRow({ description: "적용된 본문", meta_title: "적용된 제목", faq: [{ question: "질문?", answer: "답변." }] }),
      seoPage: { id: "seo-1", status: "ready", path: "/places/place-1-slug", title: "제목", description: "설명", created_at: "2026-07-10T00:00:00.000Z", last_modified_at: "2026-07-11T00:00:00.000Z" },
      generations: [
        { id: "gen-2", status: "preview", model: "FakeDeterministicAiProvider", created_at: "2026-07-12T00:00:00.000Z", applied_at: null, output: { generated: { description: "미리보기 본문", meta_title: "미리보기 제목", meta_description: "미리보기 메타", faq: [], keywords: ["키워드"] }, after: null } },
        { id: "gen-1", status: "applied", model: "FakeDeterministicAiProvider", created_at: "2026-07-11T00:00:00.000Z", applied_at: "2026-07-11T01:00:00.000Z", output: { generated: { description: "적용된 본문", meta_title: "적용된 제목", meta_description: "메타", faq: [], keywords: [] }, after: null } },
      ],
    })

    // When: the detail loads.
    const result = await loadAdminPlaceDetail(repository, "place-1")

    // Then: everything the drawer needs is mapped with KST timestamps.
    expect(result.kind).toBe("found")
    if (result.kind !== "found") {
      return
    }
    expect(result.detail.aiState).toBe("적용됨")
    expect(result.detail.content.metaTitle).toBe("적용된 제목")
    expect(result.detail.content.faq).toEqual([{ question: "질문?", answer: "답변." }])
    expect(result.detail.seoPage?.status).toBe("ready")
    expect(result.detail.generations).toHaveLength(2)
    expect(result.detail.latestPreview?.id).toBe("gen-2")
    expect(result.detail.latestPreview?.output?.description).toBe("미리보기 본문")
    expect(result.detail.publicPath).toBe("/places/place-1-slug")
    expect(result.detail.isPublic).toBe(false)
  })

  it("reports not-found and error results without throwing", async () => {
    // Given: a repository without the place and one that fails.
    const missing = await loadAdminPlaceDetail(fakeRepository({ place: null, seoPage: null, generations: [] }), "missing")
    const failing = await loadAdminPlaceDetail(
      {
        findPlaceById() {
          return Promise.reject(new Error("RLS denied detail"))
        },
        findPlaceSeoPage() {
          return Promise.resolve(null)
        },
        listAiGenerations() {
          return Promise.resolve([])
        },
      },
      "place-1",
    )

    // Then: both outcomes are typed results.
    expect(missing).toEqual({ kind: "not-found" })
    expect(failing).toEqual({ kind: "error", message: "RLS denied detail" })
  })

  it("marks a place public only when place and seo page are both published", async () => {
    // Given: both statuses published.
    const repository = fakeRepository({
      place: makePlaceRow({ status: "published" }),
      seoPage: { id: "seo-1", status: "published", path: "/places/place-1-slug", title: null, description: null, created_at: "2026-07-10T00:00:00.000Z", last_modified_at: null },
      generations: [],
    })

    // When: the detail loads.
    const result = await loadAdminPlaceDetail(repository, "place-1")

    // Then: the public flag turns on.
    expect(result.kind === "found" && result.detail.isPublic).toBe(true)
  })

  it("parses wrapped and plain generation outputs defensively", () => {
    // Given / When / Then: both storage shapes produce content, junk produces null.
    expect(parseGenerationOutput({ generated: { description: "본문", meta_title: "제목", meta_description: "메타", faq: [], keywords: [] }, after: null })?.metaTitle).toBe("제목")
    expect(parseGenerationOutput({ description: "본문", meta_title: "제목", meta_description: "메타" })?.description).toBe("본문")
    expect(parseGenerationOutput("junk")).toBeNull()
    expect(parseGenerationOutput(null)).toBeNull()
  })
})

describe("place detail drawer", () => {
  it("renders every workflow section for a found place", async () => {
    // Given: a found detail with a pending preview.
    const detail = await foundDetail({
      generations: [
        { id: "gen-1", status: "preview", model: "FakeDeterministicAiProvider", created_at: "2026-07-12T00:00:00.000Z", applied_at: null, output: { generated: { description: "미리보기 본문", meta_title: "미리보기 제목", meta_description: "미리보기 메타", faq: [], keywords: [] }, after: null } },
      ],
    })

    // When: the drawer renders.
    const markup = renderToStaticMarkup(createElement(PlaceDetailDrawer, { detail: { kind: "found", detail }, params: DEFAULT_PARAMS }))

    // Then: the eight workflow elements are all present.
    expect(markup).toContain("기본정보")
    expect(markup).toContain("콘텐츠")
    expect(markup).toContain("게시 정보")
    expect(markup).toContain("작업 이력")
    expect(markup).toContain("AI 생성")
    expect(markup).toContain("미리보기")
    expect(markup).toContain("게시 준비")
    expect(markup).toContain("공개 페이지 열기")
    expect(markup).toContain("/places/place-1-slug")
    expect(markup).toContain("AI 미리보기 생성")
  })

  it("disables preview and prepare buttons when no preview generation exists", async () => {
    // Given: a place without any generation.
    const detail = await foundDetail({ generations: [] })

    // When: the drawer renders.
    const markup = renderToStaticMarkup(createElement(PlaceDetailDrawer, { detail: { kind: "found", detail }, params: DEFAULT_PARAMS }))

    // Then: the gated buttons are disabled spans, not forms.
    expect(markup).toContain("aria-disabled")
    expect(markup).toContain("미리보기·게시 준비는 AI 생성 후에 활성화됩니다")
    expect(markup).toContain("아직 적용된 콘텐츠가 없습니다")
  })

  it("keeps the public page button disabled until both statuses are published", async () => {
    // Given: drafts on both sides, then both published.
    const draftDetail = await foundDetail({ generations: [] })
    const publishedDetail = await foundDetail({
      place: makePlaceRow({ status: "published" }),
      seoPage: { id: "seo-1", status: "published", path: "/places/place-1-slug", title: null, description: null, created_at: "2026-07-10T00:00:00.000Z", last_modified_at: null },
      generations: [],
    })

    // When: both drawers render.
    const draftMarkup = renderToStaticMarkup(createElement(PlaceDetailDrawer, { detail: { kind: "found", detail: draftDetail }, params: DEFAULT_PARAMS }))
    const publishedMarkup = renderToStaticMarkup(createElement(PlaceDetailDrawer, { detail: { kind: "found", detail: publishedDetail }, params: DEFAULT_PARAMS }))

    // Then: the public link only appears when both are published.
    expect(draftMarkup).not.toContain('href="/places/place-1-slug"')
    expect(publishedMarkup).toContain('href="/places/place-1-slug"')
    expect(publishedMarkup).toContain("공개 중")
  })

  it("shows the preview content and notice after AI generation", async () => {
    // Given: a preview exists and the URL carries preview + notice state.
    const detail = await foundDetail({
      generations: [
        { id: "gen-1", status: "preview", model: "FakeDeterministicAiProvider", created_at: "2026-07-12T00:00:00.000Z", applied_at: null, output: { generated: { description: "미리보기 본문", meta_title: "미리보기 제목", meta_description: "미리보기 메타", faq: [{ question: "미리보기 질문?", answer: "미리보기 답변." }], keywords: ["미리보기"] }, after: null } },
      ],
    })

    // When: the drawer renders in preview mode with the generated notice.
    const markup = renderToStaticMarkup(
      createElement(PlaceDetailDrawer, { detail: { kind: "found", detail }, params: { ...DEFAULT_PARAMS, preview: true, notice: "ai-generated" } }),
    )

    // Then: preview content and the Korean notice are visible.
    expect(markup).toContain("AI 미리보기가 생성되었습니다")
    expect(markup).toContain("미리보기 제목")
    expect(markup).toContain("미리보기 질문?")
    expect(markup).toContain("현재 적용값 보기")
  })

  it("renders a safe message for not-found and error details", () => {
    // Given / When: the drawer renders failure states.
    const notFound = renderToStaticMarkup(createElement(PlaceDetailDrawer, { detail: { kind: "not-found" }, params: DEFAULT_PARAMS }))
    const failed = renderToStaticMarkup(createElement(PlaceDetailDrawer, { detail: { kind: "error", message: "boom" }, params: DEFAULT_PARAMS }))

    // Then: the drawer explains instead of crashing.
    expect(notFound).toContain("선택한 장소를 찾을 수 없습니다")
    expect(failed).toContain("상세 정보를 불러오지 못했습니다")
  })
})

type FakeSeoPageRow = Readonly<{
  id: string
  status: "draft" | "ready" | "published" | "archived"
  path: string
  title: string | null
  description: string | null
  created_at: string
  last_modified_at: string | null
}>

type FakeGenerationRow = {
  readonly id: string
  readonly status: string
  readonly model: string | null
  readonly created_at: string
  readonly applied_at: string | null
  readonly output: unknown
}

type FakeDetailInput = {
  readonly place?: PlaceRow | null
  readonly seoPage?: FakeSeoPageRow | null
  readonly generations: readonly FakeGenerationRow[]
}

async function foundDetail(input: FakeDetailInput): Promise<AdminPlaceDetail> {
  const result = await loadAdminPlaceDetail(
    fakeRepository({ place: input.place ?? makePlaceRow({}), seoPage: input.seoPage ?? null, generations: input.generations }),
    "place-1",
  )
  if (result.kind !== "found") {
    throw new Error(`expected found detail, got ${result.kind}`)
  }
  return result.detail
}

function fakeRepository(input: Readonly<{
  place: PlaceRow | null
  seoPage: FakeSeoPageRow | null
  generations: readonly FakeGenerationRow[]
}>): AdminPlaceDetailRepository {
  return {
    findPlaceById() {
      return Promise.resolve(input.place)
    },
    findPlaceSeoPage() {
      return Promise.resolve(input.seoPage)
    },
    listAiGenerations() {
      return Promise.resolve(input.generations as never)
    },
  }
}

function makePlaceRow(overrides: Readonly<Partial<PlaceRow>>): PlaceRow {
  return {
    id: "place-1",
    source: "google_sheets",
    source_sheet_name: null,
    source_row_number: null,
    source_key: "source-place-1",
    name: "테스트 장소",
    normalized_name: "테스트 장소",
    category: "funeral",
    detail_category: "전문장례식장",
    region: null,
    city: "서울",
    district: "강남구",
    address: "서울 강남구 테헤란로 1",
    normalized_address: null,
    phone: "02-000-0000",
    normalized_phone: null,
    homepage: null,
    email: null,
    source_url: null,
    collected_at: null,
    grade: null,
    sales_status: null,
    memo: null,
    lat: null,
    lng: null,
    slug: "place-1-slug",
    status: "draft",
    order_url: null,
    description: null,
    meta_title: null,
    meta_description: null,
    faq: [],
    keywords: [],
    internal_links: [],
    imported_payload: null,
    synced_at: null,
    created_at: "2026-07-07T00:00:00.000Z",
    updated_at: "2026-07-07T00:00:00.000Z",
    ...overrides,
  }
}
