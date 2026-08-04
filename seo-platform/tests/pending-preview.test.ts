// 대기 중 preview 선택 회귀 (2026-08-04 KCC quality-blocked 불일치).
//
// applied보다 오래된 preview(대체된 초안)가 미리보기·게시 준비의 대상이 되면,
// 품질 카드는 적용본 PASS를 보여주는데 게시 준비 게이트는 옛 초안 FAIL로 차단하는
// 모순 표시가 생기고, 게이트가 통과됐다면 옛 초안이 정상 적용본을 덮어썼을 것이다.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { pickPendingPreview } from "@/lib/ai/generation-selection"
import { PlaceDetailDrawer } from "@/components/admin/place-detail-drawer"
import { loadAdminPlaceDetail, type AdminPlaceDetailRepository } from "@/lib/admin/place-detail"
import type { AdminPlacesWorkspaceParams } from "@/lib/admin/places-url"
import type { PlaceRow } from "@/types/database"

vi.mock("@/app/admin/places/actions", () => ({
  generatePlaceAiPreviewAction: "/admin/places",
  preparePlacePublishAction: "/admin/places",
  publishPlacePageAction: "/admin/places",
  archivePlacePageAction: "/admin/places",
  restorePlacePageAction: "/admin/places",
  retryPlaceAiGenerationAction: "/admin/places",
}))

const PARAMS: AdminPlacesWorkspaceParams = { q: null, task: null, page: 1, pageSize: 50, selected: "place-1", preview: false, notice: null, confirm: null, aiCode: null }

describe("pickPendingPreview", () => {
  it("최신이 preview면 그것이 대기 중 preview다", () => {
    const pending = { id: "new", status: "preview" }
    expect(pickPendingPreview([pending, { id: "old", status: "applied" }])).toBe(pending)
  })

  it("최신이 applied면 더 오래된 preview는 대체된 초안 — null", () => {
    expect(pickPendingPreview([{ id: "new", status: "applied" }, { id: "stale", status: "preview" }])).toBeNull()
  })

  it("rejected·failed는 건너뛴다 (품질 패널 대표 선택과 같은 규칙)", () => {
    const pending = { id: "p", status: "preview" }
    expect(pickPendingPreview([{ id: "f", status: "failed" }, { id: "r", status: "rejected" }, pending, { id: "a", status: "applied" }])).toBe(pending)
    expect(pickPendingPreview([{ id: "f", status: "failed" }])).toBeNull()
    expect(pickPendingPreview([])).toBeNull()
  })
})

describe("KCC형 상태 — 적용본 PASS + 대체된 오생성 preview", () => {
  // KCC 실측 재현: 8/4 corporate 적용본(pass) + 8/1 funeral 오생성 preview(fail)가 함께 있는 장소.
  const KCC_LIKE = {
    place: makePlaceRow({
      category: "제조",
      description: "울산 동구 사업장으로 축하화환을 보내는 안내입니다. 수령 위치는 주문 과정에서 확인할 수 있습니다.",
      meta_title: "울산 동구 사업장 행사 화환 주문 정보",
      meta_description: "사업장 행사 화환 주문 안내입니다.",
    }),
    seoPage: { id: "seo-1", status: "ready" as const, path: "/places/place-1-slug", title: "제목", description: "설명", created_at: "2026-08-04T04:30:44.000Z", last_modified_at: null, published_at: null },
    generations: [
      {
        id: "gen-applied-new",
        status: "applied",
        model: "gpt-4.1-mini",
        created_at: "2026-08-04T04:30:25.000Z",
        applied_at: "2026-08-04T04:30:43.000Z",
        output: {
          generated: { description: "축하화환 안내", meta_title: "울산 동구 사업장 행사 화환 주문 정보", meta_description: "메타", faq: [], keywords: [] },
          after: null,
          quality: { status: "pass", issues: [] },
        },
      },
      {
        id: "gen-stale-preview",
        status: "preview",
        model: "gpt-4.1-mini",
        created_at: "2026-08-01T06:48:10.000Z",
        applied_at: null,
        output: {
          generated: { description: "근조화환 주문 안내입니다.", meta_title: "빈소 화환 주문 가이드", meta_description: "빈소 안내", faq: [], keywords: [] },
          after: null,
          quality: { status: "fail", issues: [{ level: "fail", code: "forbidden-mode-term:meta_title:빈소", message: "빈소" }] },
        },
      },
    ],
  }

  it("latestPreview가 null이 되어 미리보기·게시 준비가 닫히고, 카드는 적용본 PASS·게시하기는 열린다", async () => {
    const result = await loadAdminPlaceDetail(fakeRepository(KCC_LIKE), "place-1")
    expect(result.kind).toBe("found")
    if (result.kind !== "found") return
    // 대체된 초안은 더 이상 준비 대상이 아니다.
    expect(result.detail.latestPreview).toBeNull()
    // readiness는 적용본(corporate 정상) 기준 ok.
    expect(result.detail.currentReadiness).toEqual({ kind: "ok", mode: "corporate-celebration" })

    const markup = renderToStaticMarkup(createElement(PlaceDetailDrawer, { detail: result, params: PARAMS }))
    // 게시 준비·미리보기 비활성 (stale 초안으로 되돌아갈 진입점 제거)
    expect(markup).toContain("aria-disabled")
    expect(markup).not.toContain("AI 미리보기</")
    // 품질 카드는 대표(적용본) PASS — FAIL 카드가 아니다.
    expect(markup).not.toContain("실패 — 게시 준비 차단")
    // ready이므로 게시하기 진입은 그대로 열려 있다 (게시 자체는 원래 차단된 적 없음).
    expect(markup).toContain('aria-controls="confirm-panel-publish"')
    expect(markup).toContain("최종 게시 승인")
  })

  it("최신이 preview인 정상 흐름은 그대로다 (회귀 없음)", async () => {
    const [appliedGen, staleGen] = KCC_LIKE.generations
    if (appliedGen === undefined || staleGen === undefined) throw new Error("fixture")
    const pendingFirst = {
      ...KCC_LIKE,
      generations: [
        { ...staleGen, id: "gen-pending", created_at: "2026-08-05T00:00:00.000Z", output: { generated: { description: "새 초안", meta_title: "새 제목", meta_description: "메타", faq: [], keywords: [] }, after: null, quality: { status: "pass", issues: [] } } },
        appliedGen,
      ],
    }
    const result = await loadAdminPlaceDetail(fakeRepository(pendingFirst), "place-1")
    expect(result.kind === "found" && result.detail.latestPreview?.id).toBe("gen-pending")
  })
})

type FakeInput = Readonly<{
  place: PlaceRow
  seoPage: { id: string; status: "draft" | "ready" | "published" | "archived"; path: string; title: string | null; description: string | null; created_at: string; last_modified_at: string | null; published_at: string | null } | null
  generations: readonly { id: string; status: string; model: string | null; created_at: string; applied_at: string | null; output: unknown }[]
}>

function fakeRepository(input: FakeInput): AdminPlaceDetailRepository {
  return {
    findPlaceById: () => Promise.resolve(input.place),
    findPlaceSeoPage: () => Promise.resolve(input.seoPage),
    listAiGenerations: () => Promise.resolve(input.generations as never),
  }
}

function makePlaceRow(overrides: Readonly<Partial<PlaceRow>>): PlaceRow {
  return {
    id: "place-1",
    source: "google_sheets",
    source_sheet_name: null,
    source_row_number: null,
    source_key: "source-place-1",
    name: "KCC형 사업장",
    normalized_name: "KCC형 사업장",
    category: "제조",
    detail_category: "제조업 / 공장",
    region: null,
    city: "울산",
    district: "동구",
    address: "울산 동구 방어진순환도로 30",
    normalized_address: null,
    phone: "052-000-0000",
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
