import { createElement, isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { NoticeToast } from "@/components/admin/notice-toast"
import { PlaceDetailDrawer } from "@/components/admin/place-detail-drawer"
import type { AdminPlaceDetailResult } from "@/lib/admin/place-detail"
import type { AdminPlacesWorkspaceParams } from "@/lib/admin/places-url"

const DETAIL: AdminPlaceDetailResult = {
  kind: "found",
  detail: {
    id: "place-1",
    name: "테스트 장례식장",
    category: "전문장례식장",
    region: "경남 · 진주시",
    address: "경남 진주시 강남로 79",
    phone: null,
    homepage: null,
    slug: "place-1-slug",
    status: "draft",
    aiState: "적용됨",
    content: { description: "본문", metaTitle: "제목", metaDescription: "메타", faq: [], keywords: [], internalLinks: [] },
    seoPage: {
      id: "seo-1",
      status: "ready",
      path: "/places/place-1-slug",
      title: "제목",
      description: "메타",
      createdAt: "2026-07-20 09:00 KST",
      lastModifiedAt: null,
      publishedAt: null,
      verificationStatus: null,
      verificationCheckedAt: null,
      verificationAttempts: null,
      lastHttpStatus: null,
    },
    latestPreview: null,
    generations: [],
    publicPath: "/places/place-1-slug",
    isPublic: false,
  },
}

function makeParams(overrides: Partial<AdminPlacesWorkspaceParams> = {}): AdminPlacesWorkspaceParams {
  return { q: null, task: null, page: 1, pageSize: 50, selected: "place-1", preview: false, notice: null, confirm: null, aiCode: null, ...overrides }
}

// 서버 컴포넌트 함수를 직접 호출해 엘리먼트 트리에서 NoticeToast의 key를 추출한다.
function findNoticeToastKey(node: ReactNode): string | null | undefined {
  if (!isValidElement(node)) {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findNoticeToastKey(child as ReactNode)
        if (found !== undefined) {
          return found
        }
      }
    }
    return undefined
  }
  const element = node as ReactElement<{ children?: ReactNode }>
  if (element.type === NoticeToast) {
    return element.key
  }
  return findNoticeToastKey(element.props.children ?? null)
}

function drawerToastKey(params: AdminPlacesWorkspaceParams): string | null | undefined {
  const tree = PlaceDetailDrawer({ detail: DETAIL, params }) as ReactElement<{ children?: ReactNode }>
  return findNoticeToastKey(tree)
}

describe("notice toast remount key", () => {
  it("keys the drawer toast by notice and aiCode so a new notice forces a remount", () => {
    // Given / When / Then: notice·aiCode 조합마다 key가 달라져 소프트 내비게이션에서도 재마운트된다.
    expect(drawerToastKey(makeParams())).toBe("none:none")
    expect(drawerToastKey(makeParams({ notice: "published" }))).toBe("published:none")
    expect(drawerToastKey(makeParams({ notice: "env-blocked" }))).toBe("env-blocked:none")
    expect(drawerToastKey(makeParams({ notice: "cache-refresh-failed" }))).toBe("cache-refresh-failed:none")
    expect(drawerToastKey(makeParams({ notice: "ai-failed", aiCode: "rate_limit" }))).toBe("ai-failed:rate_limit")
    expect(drawerToastKey(makeParams({ notice: "ai-failed", aiCode: "timeout" }))).toBe("ai-failed:timeout")
  })

  it("keeps the same key for identical notice params so re-renders do not duplicate the toast", () => {
    // Given: 동일 notice로 두 번 렌더.
    const first = drawerToastKey(makeParams({ notice: "published" }))
    const second = drawerToastKey(makeParams({ notice: "published" }))

    // Then: key가 동일해 재마운트(중복 토스트)가 발생하지 않는다.
    expect(first).toBe(second)
  })

  it("renders each remounted toast visibly on mount for success and failure notices", () => {
    // Given / When / Then: 재마운트된 토스트는 마운트 시점 초기화로 즉시 표시된다 (성공 자동닫힘/실패 지속은 기존 동작).
    const published = renderToStaticMarkup(createElement(NoticeToast, { notice: "published", aiCode: null }))
    expect(published).toContain("게시가 완료되었습니다.")
    const envBlocked = renderToStaticMarkup(createElement(NoticeToast, { notice: "env-blocked", aiCode: null }))
    expect(envBlocked).toContain("실패")
    expect(envBlocked).toContain("Preview 환경")
    const cacheFailed = renderToStaticMarkup(createElement(NoticeToast, { notice: "cache-refresh-failed", aiCode: null }))
    expect(cacheFailed).toContain("게시 데이터는 저장됐지만")
    const aiFailed = renderToStaticMarkup(createElement(NoticeToast, { notice: "ai-failed", aiCode: "rate_limit" }))
    expect(aiFailed).toContain("오류 코드: rate_limit")
    // notice 제거 시 토스트 미렌더 (published → 제거)
    expect(renderToStaticMarkup(createElement(NoticeToast, { notice: null, aiCode: null }))).toBe("")
  })
})
