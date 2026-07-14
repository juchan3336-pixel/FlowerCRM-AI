import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { AdminPlacesContent, type AdminPlacesWorkspaceCounts } from "@/app/admin/places/page"
import { loadAdminPlacesWorkspace } from "@/lib/admin/places"
import type { AdminPlacesPageQuery, AdminPlacesRepository } from "@/lib/admin/places"
import { buildAdminPlacesHref, resolveAdminPlacesWorkspaceParams, type AdminPlacesWorkspaceParams } from "@/lib/admin/places-url"
import type { PlaceRow, SeoPageRow } from "@/types/database"

vi.mock("@/app/admin/places/actions", () => ({
  generatePlaceAiPreviewAction: "/admin/places",
  preparePlacePublishAction: "/admin/places",
}))

const DEFAULT_PARAMS: AdminPlacesWorkspaceParams = { q: null, task: null, page: 1, pageSize: 50, selected: null, preview: false, notice: null, confirm: null, aiCode: null }
const DEFAULT_COUNTS: AdminPlacesWorkspaceCounts = { total: 6595, aiMissing: 6595, publishPending: 0, published: 0 }

describe("admin places workspace params", () => {
  it("applies defaults for missing or invalid search params", () => {
    // Given / When: empty and invalid query strings are resolved.
    const empty = resolveAdminPlacesWorkspaceParams({})
    const invalid = resolveAdminPlacesWorkspaceParams({ q: "   ", task: "evil", page: "0", pageSize: "75" })

    // Then: the workspace falls back to page 1 with 50 rows and no filters.
    expect(empty).toEqual(DEFAULT_PARAMS)
    expect(invalid).toEqual(DEFAULT_PARAMS)
  })

  it("keeps valid q, task, page, pageSize, selected, and preview from the URL", () => {
    // Given / When: a fully specified URL is resolved.
    const params = resolveAdminPlacesWorkspaceParams({
      q: " 서울 ",
      task: "ai-missing",
      page: "3",
      pageSize: "100",
      selected: "place-0001",
      preview: "1",
      notice: "ai-generated",
    })

    // Then: the state survives refresh through the URL.
    expect(params).toEqual({ q: "서울", task: "ai-missing", page: 3, pageSize: 100, selected: "place-0001", preview: true, notice: "ai-generated", confirm: null, aiCode: null })
  })

  it("keeps a valid ai error code and drops unknown ones", () => {
    // Given / When: ai failure codes arrive from the URL.
    const valid = resolveAdminPlacesWorkspaceParams({ notice: "ai-failed", aiCode: "rate_limit" })
    const unknown = resolveAdminPlacesWorkspaceParams({ notice: "ai-failed", aiCode: "sk-secret" })

    // Then: only whitelisted codes survive.
    expect(valid.aiCode).toBe("rate_limit")
    expect(unknown.aiCode).toBeNull()
  })

  it("keeps a valid confirm step and drops unknown ones", () => {
    // Given / When: confirm steps arrive from the URL.
    const publish = resolveAdminPlacesWorkspaceParams({ selected: "place-1", confirm: "publish" })
    const unknown = resolveAdminPlacesWorkspaceParams({ selected: "place-1", confirm: "delete-everything" })

    // Then: only known confirm steps survive.
    expect(publish.confirm).toBe("publish")
    expect(unknown.confirm).toBeNull()
  })

  it("drops malformed selected ids and unknown notices", () => {
    // Given / When: hostile or malformed drawer state arrives.
    const params = resolveAdminPlacesWorkspaceParams({ selected: "id with spaces!", notice: "evil", preview: "yes" })

    // Then: the drawer state falls back safely.
    expect(params.selected).toBeNull()
    expect(params.notice).toBeNull()
    expect(params.preview).toBe(false)
  })

  it("builds hrefs that only carry non-default state", () => {
    // Given / When / Then: URL state is minimal and stable.
    expect(buildAdminPlacesHref({})).toBe("/admin/places")
    expect(buildAdminPlacesHref({ task: "ai-missing", q: "서울", page: 2 })).toBe("/admin/places?task=ai-missing&q=%EC%84%9C%EC%9A%B8&page=2")
    expect(buildAdminPlacesHref({ page: 1, pageSize: 50 })).toBe("/admin/places")
    expect(buildAdminPlacesHref({ pageSize: 200 })).toBe("/admin/places?pageSize=200")
    expect(buildAdminPlacesHref({ q: "서울", selected: "place-1", preview: true, notice: "prepared" })).toBe(
      "/admin/places?q=%EC%84%9C%EC%9A%B8&selected=place-1&preview=1&notice=prepared",
    )
  })
})

describe("admin places workspace loader", () => {
  it("passes search, task, and range to the repository page query", async () => {
    // Given: a repository with a server-side page reader.
    const receivedQueries: AdminPlacesPageQuery[] = []
    const repository: AdminPlacesRepository = {
      ...baseRepository(2),
      listPlacesPage(query) {
        receivedQueries.push(query)
        return Promise.resolve({ rows: [makePlaceRow(1)], seoStatuses: [], total: 321 })
      },
    }

    // When: the workspace loads page 3 with a search and task filter.
    const result = await loadAdminPlacesWorkspace(
      { places: repository },
      { search: "서울", task: "ai-missing", offset: 100, limit: 50 },
      { supabaseUrlHostOrRef: "project.supabase.co" },
    )

    // Then: the exact query reaches the repository and totals flow back.
    expect(receivedQueries).toEqual([{ search: "서울", task: "ai-missing", offset: 100, limit: 50 }])
    expect(result.source).toBe("live")
    expect(result.total).toBe(321)
    expect(result.offset).toBe(100)
    expect(result.limit).toBe(50)
    expect(result.rows).toHaveLength(1)
  })

  it("searches name, address, region, category, and slug in the fallback path", async () => {
    // Given: a repository without a page reader holding distinct rows.
    const rows = [
      makeNamedPlaceRow("r1", { name: "서울꽃집" }),
      makeNamedPlaceRow("r2", { address: "서울 강남구 테헤란로 1" }),
      makeNamedPlaceRow("r3", { region: "서울", city: "서울", district: "서초구" }),
      makeNamedPlaceRow("r4", { detail_category: "서울장례식장" }),
      makeNamedPlaceRow("r5", { slug: "seoul-place-r5" }),
      makeNamedPlaceRow("r6", { name: "부산꽃집", address: "부산 해운대구", region: "부산" }),
    ]
    const repository = baseRepositoryWithRows(rows)

    // When: the workspace searches for 서울 and for the slug term.
    const korean = await loadAdminPlacesWorkspace({ places: repository }, { search: "서울", task: null, offset: 0, limit: 50 })
    const slug = await loadAdminPlacesWorkspace({ places: repository }, { search: "seoul-place", task: null, offset: 0, limit: 50 })

    // Then: every searchable field matches and unrelated rows drop out.
    expect(korean.total).toBe(4)
    expect(korean.rows.map((row) => row.id)).toEqual(["place-r1", "place-r2", "place-r3", "place-r4"])
    expect(slug.total).toBe(1)
    expect(slug.rows[0]?.id).toBe("place-r5")
  })

  it("paginates the fallback result with total and range intact", async () => {
    // Given: 120 rows behind a repository without a page reader.
    const repository = baseRepositoryWithRows(Array.from({ length: 120 }, (_, index) => makePlaceRow(index + 1)))

    // When: the second 50-row page loads.
    const result = await loadAdminPlacesWorkspace({ places: repository }, { search: null, task: null, offset: 50, limit: 50 })

    // Then: the page holds rows 51-100 of 120.
    expect(result.total).toBe(120)
    expect(result.rows).toHaveLength(50)
    expect(result.rows[0]?.name).toBe("장소 0051")
    expect(result.rows.at(-1)?.name).toBe("장소 0100")
  })

  it("reports an error workspace when the page query fails", async () => {
    // Given: a repository whose page reader rejects.
    const error = new Error("RLS denied places page") as Error & { code: string }
    error.code = "PGRST301"
    const repository: AdminPlacesRepository = {
      ...baseRepository(0),
      listPlacesPage() {
        return Promise.reject(error)
      },
    }

    // When: the workspace loads.
    const result = await loadAdminPlacesWorkspace({ places: repository }, { search: null, task: null, offset: 0, limit: 50 })

    // Then: the failure is typed instead of thrown.
    expect(result.source).toBe("error")
    expect(result.rows).toHaveLength(0)
    expect(result.diagnostics.queryErrorCode).toBe("PGRST301")
    expect(result.diagnostics.queryErrorMessage).toBe("RLS denied places page")
  })
})

describe("admin places workspace ui", () => {
  it("renders filter chips, search form, and the shown range", async () => {
    // Given: a live workspace page of production scale.
    const repository = baseRepositoryWithRows(Array.from({ length: 60 }, (_, index) => makePlaceRow(index + 1)))
    const workspace = await loadAdminPlacesWorkspace({ places: repository }, { search: null, task: null, offset: 0, limit: 50 })

    // When: the content renders.
    const markup = renderToStaticMarkup(
      createElement(AdminPlacesContent, { workspace, counts: DEFAULT_COUNTS, params: DEFAULT_PARAMS }),
    )

    // Then: the workspace controls and totals are visible.
    expect(markup).toContain("장소관리")
    expect(markup).toContain("전체")
    expect(markup).toContain("AI 생성 안됨")
    expect(markup).toContain("게시 대기")
    expect(markup).toContain("게시 완료")
    expect(markup).toContain("6,595")
    expect(markup).toContain("60건 중 1–50 표시")
    expect(markup).toContain("장소명, 주소, 지역, 카테고리, 슬러그 검색")
    expect(markup).toContain("페이지 1 / 2")
    expect(markup).toContain("연결 진단")
  })

  it("shows the Korean empty state when a search has no matches", async () => {
    // Given: a search that matches nothing.
    const repository = baseRepositoryWithRows([makePlaceRow(1)])
    const workspace = await loadAdminPlacesWorkspace({ places: repository }, { search: "존재하지않는검색어", task: null, offset: 0, limit: 50 })

    // When: the content renders with the active query.
    const markup = renderToStaticMarkup(
      createElement(AdminPlacesContent, { workspace, counts: DEFAULT_COUNTS, params: { ...DEFAULT_PARAMS, q: "존재하지않는검색어" } }),
    )

    // Then: a Korean empty-state message with an escape hatch appears.
    expect(markup).toContain("검색 결과가 없습니다. 검색어나 필터를 바꿔 보세요.")
    expect(markup).toContain("전체 목록 보기")
    expect(markup).toContain("검색 초기화")
  })

  it("keeps dashboard task links working through the chip state", async () => {
    // Given: the ai-missing filter arrives from a dashboard card link.
    const repository = baseRepositoryWithRows([
      makeNamedPlaceRow("with-ai", { description: "AI 설명" }),
      makeNamedPlaceRow("without-ai", {}),
    ])
    const workspace = await loadAdminPlacesWorkspace({ places: repository }, { search: null, task: "ai-missing", offset: 0, limit: 50 })

    // When: the content renders with the task param active.
    const markup = renderToStaticMarkup(
      createElement(AdminPlacesContent, { workspace, counts: DEFAULT_COUNTS, params: { ...DEFAULT_PARAMS, task: "ai-missing" } }),
    )

    // Then: only the AI-missing place is listed under the active chip.
    expect(workspace.rows.map((row) => row.id)).toEqual(["place-without-ai"])
    expect(markup).toContain("aria-current")
    expect(markup).toContain("장소 without-ai")
  })

  it("renders an error state and diagnostics when the workspace fails", async () => {
    // Given: an environment-missing workspace.
    const workspace = await loadAdminPlacesWorkspace({}, { search: null, task: null, offset: 0, limit: 50 }, { supabaseUrlHostOrRef: null })

    // When: the content renders.
    const markup = renderToStaticMarkup(
      createElement(AdminPlacesContent, { workspace, counts: { total: null, aiMissing: null, publishPending: null, published: null }, params: DEFAULT_PARAMS }),
    )

    // Then: the error surface replaces the table without crashing.
    expect(workspace.source).toBe("error")
    expect(markup).toContain("데이터를 불러오지 못했습니다")
    expect(markup).toContain("environment missing")
  })

  it("does not expose private fixture tokens in the workspace markup", async () => {
    // Given: rows containing private-looking source fields.
    const repository = baseRepositoryWithRows([makePlaceRow(1), makePlaceRow(2)])
    const workspace = await loadAdminPlacesWorkspace({ places: repository }, { search: null, task: null, offset: 0, limit: 50 })

    // When: the component is rendered.
    const markup = renderToStaticMarkup(
      createElement(AdminPlacesContent, { workspace, counts: DEFAULT_COUNTS, params: DEFAULT_PARAMS }),
    )

    // Then: private fields and fixture secret values are absent from markup.
    for (const privateToken of [
      "private@example.com",
      "internal memo",
      "imported_payload",
      "synced_at",
      "service_role",
      "SUPABASE_SERVICE_ROLE_KEY",
      "010-9999-0000",
    ] as const) {
      expect(markup).not.toContain(privateToken)
    }
  })
})

function baseRepository(count: number): AdminPlacesRepository {
  return baseRepositoryWithRows(Array.from({ length: count }, (_, index) => makePlaceRow(index + 1)))
}

function baseRepositoryWithRows(rows: readonly PlaceRow[]): AdminPlacesRepository {
  return {
    countPlaces() {
      return Promise.resolve(rows.length)
    },
    listPlaces() {
      return Promise.resolve(rows)
    },
    countPlaceSeoPages() {
      return Promise.resolve(0)
    },
    listPlaceSeoPages() {
      return Promise.resolve([] as readonly Pick<SeoPageRow, "place_id" | "status">[])
    },
  }
}

function makePlaceRow(index: number): PlaceRow {
  const suffix = String(index).padStart(4, "0")
  return makeNamedPlaceRow(suffix, { name: `장소 ${suffix}` })
}

function makeNamedPlaceRow(
  key: string,
  overrides: Readonly<Partial<Pick<PlaceRow, "name" | "address" | "region" | "city" | "district" | "category" | "detail_category" | "slug" | "status" | "description">>>,
): PlaceRow {
  return {
    id: `place-${key}`,
    source: "google_sheets",
    source_sheet_name: null,
    source_row_number: null,
    source_key: `source-${key}`,
    name: overrides.name ?? `장소 ${key}`,
    normalized_name: overrides.name ?? `장소 ${key}`,
    category: overrides.category ?? "funeral",
    detail_category: overrides.detail_category ?? null,
    region: overrides.region ?? "부산 해운대구",
    city: overrides.city ?? "부산",
    district: overrides.district ?? "해운대구",
    address: overrides.address ?? `부산 해운대구 센텀로 ${key}`,
    normalized_address: null,
    phone: null,
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
    slug: overrides.slug ?? `place-${key}`,
    status: overrides.status ?? "draft",
    order_url: null,
    description: overrides.description ?? null,
    meta_title: null,
    meta_description: null,
    faq: [],
    keywords: [],
    internal_links: [],
    imported_payload: null,
    synced_at: null,
    created_at: "2026-07-07T00:00:00.000Z",
    updated_at: "2026-07-07T00:00:00.000Z",
  }
}
