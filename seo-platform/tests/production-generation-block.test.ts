// Production 수동 AI 생성·복구 재시도 하드 차단 + fake preview 표시 우선순위 회귀.
// 2026-08-04 KCC 실측: Production(AI_PROVIDER=fake)에서 AI 생성·복구 재시도 클릭으로
// fake 초안 2건(1f199bd5·de0c6547)이 생겨 품질 카드가 샘플 FAIL로 뒤집혔다.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

import { excludeSupersededFakePreviews, pickPendingPreview } from "@/lib/ai/generation-selection"
import { resolveManualGenerationEnvironment, resolvePublishEnvironment } from "@/lib/admin/publish-environment"
import { loadAdminPlaceDetail, resolveGenerationQualityPanelState, type AdminPlaceDetailRepository, type AdminPlaceGenerationView } from "@/lib/admin/place-detail"
import { PlaceDetailDrawer } from "@/components/admin/place-detail-drawer"
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

afterEach(() => {
  delete process.env["VERCEL_ENV"]
})

describe("환경 판정 — 수동 생성은 Production만 차단", () => {
  it("production 차단, preview·development·local 허용 (기존 게시 판정 재사용)", () => {
    expect(resolveManualGenerationEnvironment("production")).toEqual({ environment: "production", allowed: false })
    expect(resolveManualGenerationEnvironment("preview")).toEqual({ environment: "preview", allowed: true })
    expect(resolveManualGenerationEnvironment("development")).toEqual({ environment: "development", allowed: true })
    expect(resolveManualGenerationEnvironment(undefined)).toEqual({ environment: "local", allowed: true })
    // 게시 판정은 그대로 반대 방향을 유지한다 (회귀 없음).
    expect(resolvePublishEnvironment("production").allowed).toBe(true)
    expect(resolvePublishEnvironment("preview").allowed).toBe(false)
  })
})

describe("fake preview 표시 우선순위", () => {
  it("applied가 있으면 fake preview는 대표·대기 선택에서 빠진다", () => {
    const rows = [
      { id: "fake-2", status: "preview", provider: "fake" },
      { id: "fake-1", status: "preview", provider: "fake" },
      { id: "real", status: "applied", provider: "openai" },
    ]
    const filtered = excludeSupersededFakePreviews(rows)
    expect(filtered.map((r) => r.id)).toEqual(["real"])
    expect(pickPendingPreview(filtered)).toBeNull()
  })

  it("applied가 없으면(로컬 개발 흐름) fake preview 검토 흐름을 유지한다", () => {
    const rows = [{ id: "fake-1", status: "preview", provider: "fake" }]
    expect(excludeSupersededFakePreviews(rows)).toEqual(rows)
    expect(pickPendingPreview(rows)?.id).toBe("fake-1")
  })

  it("openai pending preview는 applied가 있어도 기존 검토 흐름 유지", () => {
    const rows = [
      { id: "pending", status: "preview", provider: "openai" },
      { id: "old", status: "applied", provider: "openai" },
    ]
    expect(pickPendingPreview(excludeSupersededFakePreviews(rows))?.id).toBe("pending")
  })

  it("품질 패널 대표: 샘플 FAIL이 적용본 PASS를 덮지 않는다", () => {
    const panel = resolveGenerationQualityPanelState({
      generations: [
        makeGenView({ id: "fake", status: "preview", provider: "fake", quality: { status: "fail", issues: [] } }),
        makeGenView({ id: "applied", status: "applied", provider: "openai", quality: { status: "pass", issues: [] } }),
      ],
      isPublished: true,
    })
    expect(panel?.generation.id).toBe("applied")
    expect(panel?.quality.status).toBe("pass")
  })
})

describe("드로어 — KCC형 실상태 (published + 이후 fake preview 2건)", () => {
  const KCC_NOW = {
    place: makePlaceRow({
      status: "published",
      category: "제조",
      description: "축하화환 안내입니다. 수령 위치는 주문 과정에서 확인할 수 있습니다.",
      meta_title: "울산 동구 사업장 행사 화환 주문 정보",
      meta_description: "메타",
    }),
    seoPage: { id: "seo-1", status: "published" as const, path: "/places/place-1-slug", title: "제목", description: "설명", created_at: "2026-08-04T04:30:44.000Z", last_modified_at: null, published_at: "2026-08-04T13:01:39.000Z" },
    generations: [
      fakeGenRow("fake-retry", "2026-08-04T13:00:58.000Z"),
      fakeGenRow("fake-first", "2026-08-04T12:45:47.000Z"),
      {
        id: "applied-good",
        status: "applied",
        model: "gpt-4.1-mini",
        created_at: "2026-08-04T04:30:25.000Z",
        applied_at: "2026-08-04T04:30:43.000Z",
        output: { generated: { description: "축하화환 안내", meta_title: "정상 제목", meta_description: "메타", faq: [], keywords: [] }, after: null, provider: "openai", model: "gpt-4.1-mini", quality: { status: "pass", issues: [] } },
      },
    ],
  }

  it("품질 카드는 적용본 PASS, fake는 이력에서 '미적용 샘플 초안'으로 구분된다", async () => {
    const result = await loadAdminPlaceDetail(fakeRepository(KCC_NOW), "place-1")
    expect(result.kind).toBe("found")
    if (result.kind !== "found") return
    // fake preview는 대기 초안이 아니다.
    expect(result.detail.latestPreview).toBeNull()
    const markup = renderToStaticMarkup(createElement(PlaceDetailDrawer, { detail: result, params: PARAMS }))
    // 대표 품질은 적용본 PASS — 샘플 FAIL 배지가 카드를 덮지 않는다.
    expect(markup).not.toContain("실패 — 게시 준비 차단")
    // 이력에는 fake 초안이 구분 표시로 남는다.
    expect(markup).toContain("미적용 샘플 초안 — 게시 대상 아님")
    expect(markup).toContain("샘플 AI")
  })

  it("VERCEL_ENV=production이면 AI 생성 비활성 + 안내 문구", async () => {
    process.env["VERCEL_ENV"] = "production"
    const result = await loadAdminPlaceDetail(fakeRepository(KCC_NOW), "place-1")
    if (result.kind !== "found") throw new Error("expected found")
    const markup = renderToStaticMarkup(createElement(PlaceDetailDrawer, { detail: result, params: PARAMS }))
    expect(markup).toContain("AI 생성 — Production 차단")
    expect(markup).toContain("Production에서는 AI 생성을 실행할 수 없습니다. 고정 Preview에서 생성·검수 후 적용하세요.")
    // 활성 생성 폼 버튼(>AI 생성<)이 렌더되지 않는다 — 이력 라벨("AI 미리보기 생성")과 무관.
    expect(markup).not.toContain(">AI 생성<")
  })

  it("preview 환경에서는 AI 생성 버튼이 그대로 열려 있다", async () => {
    process.env["VERCEL_ENV"] = "preview"
    const result = await loadAdminPlaceDetail(fakeRepository(KCC_NOW), "place-1")
    if (result.kind !== "found") throw new Error("expected found")
    const markup = renderToStaticMarkup(createElement(PlaceDetailDrawer, { detail: result, params: PARAMS }))
    expect(markup).not.toContain("AI 생성 — Production 차단")
    expect(markup).toContain(">AI 생성<")
  })

  it("production에서는 품질 FAIL 복구 재시도 버튼도 노출되지 않는다", async () => {
    process.env["VERCEL_ENV"] = "production"
    // FAIL preview가 대표인 장소 (applied 없음 — 재시도 버튼이 원래 열리는 조건)
    const failPreviewOnly = {
      place: makePlaceRow({}),
      seoPage: null,
      generations: [
        {
          id: "fail-preview",
          status: "preview",
          model: "gpt-4.1-mini",
          created_at: "2026-08-04T04:30:25.000Z",
          applied_at: null,
          output: { generated: { description: "본문", meta_title: "제목", meta_description: "메타", faq: [], keywords: [] }, after: null, provider: "openai", quality: { status: "fail", issues: [{ level: "fail", code: "banned:price:description:가격", message: "가격" }] } },
        },
      ],
    }
    const result = await loadAdminPlaceDetail(fakeRepository(failPreviewOnly), "place-1")
    if (result.kind !== "found") throw new Error("expected found")
    const markup = renderToStaticMarkup(createElement(PlaceDetailDrawer, { detail: result, params: PARAMS }))
    expect(markup).not.toContain("품질 FAIL 복구 재시도")

    delete process.env["VERCEL_ENV"]
    const open = renderToStaticMarkup(createElement(PlaceDetailDrawer, { detail: result, params: PARAMS }))
    expect(open).toContain("품질 FAIL 복구 재시도")
  })
})

function fakeGenRow(id: string, createdAt: string) {
  return {
    id,
    status: "preview",
    model: "FakeDeterministicAiProvider",
    created_at: createdAt,
    applied_at: null,
    output: {
      generated: { description: "개업 축하화환 주문은 공식 CTA를 통해 확인하세요.", meta_title: "샘플 제목", meta_description: "샘플 메타", faq: [], keywords: [] },
      after: null,
      provider: "fake",
      model: "FakeDeterministicAiProvider",
      quality: { status: "fail", issues: [{ level: "fail", code: "banned:cta-term:description:CTA", message: "CTA" }] },
    },
  }
}

function makeGenView(overrides: Partial<AdminPlaceGenerationView>): AdminPlaceGenerationView {
  return {
    id: "gen",
    status: "preview",
    model: "gpt-4.1-mini",
    provider: "openai",
    usage: null,
    estimatedCost: null,
    errorCode: null,
    errorDetail: null,
    createdAt: "2026-08-04 13:00 KST",
    appliedAt: null,
    output: null,
    quality: { status: "pass", issues: [] },
    titleNormalization: null,
    retry: null,
    ...overrides,
  }
}

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
