// 현재 업종 기준 draft 재평가(readiness) — 저장된 quality_status를 그대로 믿고
// 오생성 draft(호텔 페이지에 장례 문구)를 PASS·게시 가능으로 보여주던 결함의 회귀 테스트.
// 서버 최종 방어(checkPublishVocabulary)와 같은 기준을 화면 계층에서 검증한다.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { PlaceDetailDrawer } from "@/components/admin/place-detail-drawer"
import {
  currentReadinessQualityIssues,
  evaluateCurrentDraftReadiness,
  isPublishOpenByReadiness,
  loadAdminPlaceDetail,
  type AdminPlaceContent,
  type AdminPlaceDetail,
  type AdminPlaceDetailRepository,
} from "@/lib/admin/place-detail"
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

const DEFAULT_PARAMS: AdminPlacesWorkspaceParams = { q: null, task: null, page: 1, pageSize: 50, selected: "place-1", preview: false, notice: null, confirm: null, aiCode: null }

// 라마다 오생성과 같은 꼴 — 호텔 콘텐츠에 장례 표현이 필드 전반에 남아 있다.
const FUNERAL_STYLE_CONTENT: AdminPlaceContent = {
  metaTitle: "거제시 장례식장 화환 주문 — 라마다스위츠 거제호텔",
  metaDescription: "화환 주문 안내와 주소, 빈소명 확인 방법을 제공합니다.",
  description: "라마다스위츠 거제호텔로 근조화환을 보내는 방법을 안내합니다. 주문 과정에서 빈소명을 확인할 수 있습니다.",
  faq: [
    { question: "빈소명을 모를 때 어떻게 확인하나요?", answer: "빈소명은 주문 과정에서 확인할 수 있습니다." },
    { question: "장례식장 주소는 어떻게 확인할 수 있나요?", answer: "주문 과정에서 정확한 주소 확인이 가능합니다." },
  ],
  keywords: ["라마다스위츠 거제호텔", "거제 근조화환", "빈소명 확인"],
  internalLinks: [],
}

const CELEBRATION_CONTENT: AdminPlaceContent = {
  metaTitle: "거제시 행사 축하화환 주문 — 라마다스위츠 거제호텔",
  metaDescription: "호텔 행사장으로 보내는 축하화환 주문 안내입니다.",
  description: "라마다스위츠 거제호텔에서 열리는 행사에 축하화환을 보내는 방법을 안내합니다. 리본 문구는 주문 과정에서 정할 수 있습니다.",
  faq: [
    { question: "행사장 수령은 어떻게 하나요?", answer: "주문 과정에서 확인할 수 있습니다." },
    { question: "리본 문구는 바꿀 수 있나요?", answer: "원하는 문구를 주문 시 지정할 수 있습니다." },
  ],
  keywords: ["라마다스위츠 거제호텔", "거제 축하화환"],
  internalLinks: [],
}

const READINESS_BASE = { placeName: "라마다스위츠 거제호텔", regionTokens: ["경남", "거제시"] } as const

describe("evaluateCurrentDraftReadiness — 현재 category 기준 재평가", () => {
  it("호텔(숙박/행사) draft에 장례 표현이 남아 있으면 vocabulary-mismatch다", () => {
    // Given / When: 호텔 업종에 장례식장 스타일 콘텐츠.
    const readiness = evaluateCurrentDraftReadiness({ ...READINESS_BASE, content: FUNERAL_STYLE_CONTENT, category: "숙박/행사" })

    // Then: fail이며, 필드·표현이 그대로 담긴다.
    expect(readiness.kind).toBe("vocabulary-mismatch")
    if (readiness.kind !== "vocabulary-mismatch") return
    expect(readiness.mode).toBe("celebration")
    const byField = readiness.findings.map((finding) => `${finding.field}:${finding.term}`)
    expect(byField).toContain("meta_title:장례식장")
    expect(byField).toContain("meta_description:빈소")
    expect(byField).toContain("description:근조")
    expect(byField).toContain("faq[0].question:빈소")
    expect(byField).toContain("keywords[1]:근조")
    // 게시 진입 차단 + 품질 패널 issue로도 변환된다.
    expect(isPublishOpenByReadiness(readiness)).toBe(false)
    const issues = currentReadinessQualityIssues(readiness)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.every((issue) => issue.level === "fail" && issue.code.startsWith("forbidden-mode-"))).toBe(true)
  })

  it("정상 celebration·corporate-celebration draft는 ok다", () => {
    const hotel = evaluateCurrentDraftReadiness({ ...READINESS_BASE, content: CELEBRATION_CONTENT, category: "숙박/행사" })
    const factory = evaluateCurrentDraftReadiness({ ...READINESS_BASE, content: CELEBRATION_CONTENT, category: "제조" })
    expect(hotel).toEqual({ kind: "ok", mode: "celebration" })
    expect(factory).toEqual({ kind: "ok", mode: "corporate-celebration" })
    expect(isPublishOpenByReadiness(hotel)).toBe(true)
  })

  it("funeral 장소의 근조·빈소 콘텐츠는 회귀 없이 ok다", () => {
    // Given / When: 기존 게시 29곳과 같은 꼴 — condolence 모드에 장례 어휘.
    const readiness = evaluateCurrentDraftReadiness({ ...READINESS_BASE, content: FUNERAL_STYLE_CONTENT, category: "funeral" })

    // Then: condolence에서는 장례 어휘가 금지가 아니다.
    expect(readiness).toEqual({ kind: "ok", mode: "condolence" })
    expect(isPublishOpenByReadiness(readiness)).toBe(true)
  })

  it("모드로 판정할 수 없는 업종은 unsupported-category다", () => {
    const readiness = evaluateCurrentDraftReadiness({ ...READINESS_BASE, content: CELEBRATION_CONTENT, category: "병원" })
    expect(readiness).toEqual({ kind: "unsupported-category", category: "병원" })
    expect(isPublishOpenByReadiness(readiness)).toBe(false)
  })

  it("검사할 draft가 없으면 no-content로 기존 흐름을 막지 않는다", () => {
    const readiness = evaluateCurrentDraftReadiness({ ...READINESS_BASE, content: null, category: "숙박/행사" })
    expect(readiness).toEqual({ kind: "no-content" })
    expect(isPublishOpenByReadiness(readiness)).toBe(true)
  })
})

describe("loadAdminPlaceDetail — readiness 계산", () => {
  it("mode 기록이 없는 과거 generation이라도 현재 category로 판정한다", async () => {
    // Given: 모드 도입 이전에 생성돼 저장 quality가 pass인 applied draft (라마다 케이스).
    const repository = fakeRepository({
      place: makePlaceRow({
        category: "숙박/행사",
        description: FUNERAL_STYLE_CONTENT.description,
        meta_title: FUNERAL_STYLE_CONTENT.metaTitle,
        meta_description: FUNERAL_STYLE_CONTENT.metaDescription,
        faq: FUNERAL_STYLE_CONTENT.faq.map((item) => ({ question: item.question, answer: item.answer })),
        keywords: [...FUNERAL_STYLE_CONTENT.keywords],
      }),
      seoPage: readySeoPage(),
      generations: [appliedGenerationWithStoredPass()],
    })

    // When: 상세를 로드한다.
    const result = await loadAdminPlaceDetail(repository, "place-1")

    // Then: 저장된 pass와 무관하게 현재 업종 기준 mismatch다.
    expect(result.kind).toBe("found")
    if (result.kind !== "found") return
    expect(result.detail.currentReadiness.kind).toBe("vocabulary-mismatch")
  })

  it("적용 전이면 최신 preview 출력을 같은 기준으로 판정한다", async () => {
    // Given: 적용된 콘텐츠 없이 장례 표현이 든 preview만 있는 호텔.
    const repository = fakeRepository({
      place: makePlaceRow({ category: "숙박/행사" }),
      seoPage: null,
      generations: [
        {
          id: "gen-preview",
          status: "preview",
          model: "gpt",
          created_at: "2026-08-01T00:00:00.000Z",
          applied_at: null,
          output: { generated: { description: "근조화환 안내", meta_title: "장례식장 화환 — 테스트", meta_description: "빈소 안내", faq: [], keywords: [] }, after: null, quality: { status: "pass", issues: [] } },
        },
      ],
    })

    // When / Then: preview 출력 기준으로도 mismatch가 잡힌다.
    const result = await loadAdminPlaceDetail(repository, "place-1")
    expect(result.kind === "found" && result.detail.currentReadiness.kind).toBe("vocabulary-mismatch")
  })
})

describe("place detail drawer — readiness 게이트", () => {
  it("ready라도 mismatch면 게시 진입이 닫히고 차단 사유·FAIL이 표시된다", async () => {
    // Given: 라마다 케이스 — ready seo page + 저장 quality pass + 호텔 업종의 장례 콘텐츠.
    const detail = await mismatchReadyDetail()

    // When: 드로어가 렌더링된다.
    const markup = renderToStaticMarkup(createElement(PlaceDetailDrawer, { detail: { kind: "found", detail }, params: DEFAULT_PARAMS }))

    // Then: 게시 확인 패널·게시하기 토글이 없고, 차단 사유와 필드·표현, 재검사 FAIL 안내가 보인다.
    expect(markup).not.toContain('aria-controls="confirm-panel-publish"')
    expect(markup).not.toContain("최종 게시 승인")
    expect(markup).toContain("게시하기 — 현재 업종 기준 재검사로 차단됨")
    expect(markup).toContain("게시 차단 — 현재 업종 기준 재검사 FAIL")
    expect(markup).toContain("현재 업종 규칙과 맞지 않습니다")
    expect(markup).toContain("meta_title")
    expect(markup).toContain("장례식장")
    // 품질 패널도 저장된 PASS 대신 FAIL을 대표값으로 보여준다.
    expect(markup).toContain("실패 — 게시 준비 차단")
    expect(markup).toContain("현재 업종 기준 재검사 FAIL로 게시가 차단됩니다")
  })

  it("confirm=publish로 들어와도 mismatch면 게시 확인 패널을 열지 않는다", async () => {
    const detail = await mismatchReadyDetail()
    const markup = renderToStaticMarkup(
      createElement(PlaceDetailDrawer, { detail: { kind: "found", detail }, params: { ...DEFAULT_PARAMS, confirm: "publish" } }),
    )
    expect(markup).not.toContain("공개하는 데 동의합니다")
    expect(markup).not.toContain('name="approve"')
  })

  it("funeral ready 장소는 회귀 없이 게시 진입이 열린다", async () => {
    // Given: 기존 정상 funeral draft.
    const repository = fakeRepository({
      place: makePlaceRow({
        category: "funeral",
        description: FUNERAL_STYLE_CONTENT.description,
        meta_title: FUNERAL_STYLE_CONTENT.metaTitle,
        meta_description: FUNERAL_STYLE_CONTENT.metaDescription,
      }),
      seoPage: readySeoPage(),
      generations: [],
    })
    const result = await loadAdminPlaceDetail(repository, "place-1")
    if (result.kind !== "found") throw new Error("expected found")

    // When / Then: 게시하기 토글과 최종 검토 섹션이 그대로 열린다.
    const markup = renderToStaticMarkup(createElement(PlaceDetailDrawer, { detail: { kind: "found", detail: result.detail }, params: DEFAULT_PARAMS }))
    expect(markup).toContain('aria-controls="confirm-panel-publish"')
    expect(markup).toContain("최종 게시 승인")
    expect(markup).not.toContain("게시 차단")
  })

  it("판정 불가 업종은 게시 불가 안내를 보여준다", async () => {
    // Given: 모드 매핑이 없는 업종의 ready 장소.
    const repository = fakeRepository({
      place: makePlaceRow({ category: "병원", description: "본문", meta_title: "제목", meta_description: "메타" }),
      seoPage: readySeoPage(),
      generations: [],
    })
    const result = await loadAdminPlaceDetail(repository, "place-1")
    if (result.kind !== "found") throw new Error("expected found")

    // When / Then: 업종 판정 불가 차단이 표시되고 게시 진입이 닫힌다.
    const markup = renderToStaticMarkup(createElement(PlaceDetailDrawer, { detail: { kind: "found", detail: result.detail }, params: DEFAULT_PARAMS }))
    expect(markup).toContain("게시 차단 — 업종 판정 불가")
    expect(markup).not.toContain('aria-controls="confirm-panel-publish"')
  })
})

async function mismatchReadyDetail(): Promise<AdminPlaceDetail> {
  const repository = fakeRepository({
    place: makePlaceRow({
      category: "숙박/행사",
      description: FUNERAL_STYLE_CONTENT.description,
      meta_title: FUNERAL_STYLE_CONTENT.metaTitle,
      meta_description: FUNERAL_STYLE_CONTENT.metaDescription,
      faq: FUNERAL_STYLE_CONTENT.faq.map((item) => ({ question: item.question, answer: item.answer })),
      keywords: [...FUNERAL_STYLE_CONTENT.keywords],
    }),
    seoPage: readySeoPage(),
    generations: [appliedGenerationWithStoredPass()],
  })
  const result = await loadAdminPlaceDetail(repository, "place-1")
  if (result.kind !== "found") throw new Error("expected found")
  return result.detail
}

function readySeoPage() {
  return {
    id: "seo-1",
    status: "ready" as const,
    path: "/places/place-1-slug",
    title: "제목",
    description: "설명",
    created_at: "2026-08-01T00:00:00.000Z",
    last_modified_at: null,
    published_at: null,
  }
}

// 모드 도입 이전 저장 형태 — quality는 pass, content_mode 기록 없음 (라마다 22c1d97a와 동일 꼴).
function appliedGenerationWithStoredPass() {
  return {
    id: "gen-applied",
    status: "applied",
    model: "gpt-4.1-mini",
    created_at: "2026-08-01T00:00:00.000Z",
    applied_at: "2026-08-01T00:01:00.000Z",
    output: {
      generated: {
        description: FUNERAL_STYLE_CONTENT.description,
        meta_title: FUNERAL_STYLE_CONTENT.metaTitle,
        meta_description: FUNERAL_STYLE_CONTENT.metaDescription,
        faq: FUNERAL_STYLE_CONTENT.faq.map((item) => ({ question: item.question, answer: item.answer })),
        keywords: [...FUNERAL_STYLE_CONTENT.keywords],
      },
      after: null,
      quality: { status: "pass", issues: [] },
    },
  }
}

function fakeRepository(input: Readonly<{
  place: PlaceRow | null
  seoPage: ReturnType<typeof readySeoPage> | null
  generations: readonly { id: string; status: string; model: string | null; created_at: string; applied_at: string | null; output: unknown }[]
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
    name: "라마다스위츠 거제호텔",
    normalized_name: "라마다스위츠 거제호텔",
    category: "숙박/행사",
    detail_category: "호텔 / 호텔",
    region: null,
    city: "경남",
    district: "거제시",
    address: "경남 거제시 일운면 거제대로 2631",
    normalized_address: null,
    phone: "055-000-0000",
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
