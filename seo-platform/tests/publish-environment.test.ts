import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { NoticeToast, resolveNoticeToast } from "@/components/admin/notice-toast"
import { ADMIN_PLACES_NOTICES } from "@/lib/admin/places-url"
import { resolvePublishEnvironment } from "@/lib/admin/publish-environment"

describe("publish environment gate", () => {
  it("allows publish actions only on production or local", () => {
    // Given / When / Then: Vercel 배포 환경별 허용 여부 — Preview/Development는 운영 캐시를 갱신할 수 없어 차단한다.
    expect(resolvePublishEnvironment("production")).toEqual({ environment: "production", allowed: true })
    expect(resolvePublishEnvironment("preview")).toEqual({ environment: "preview", allowed: false })
    expect(resolvePublishEnvironment("development")).toEqual({ environment: "development", allowed: false })
    expect(resolvePublishEnvironment(undefined)).toEqual({ environment: "local", allowed: true })
  })
})

describe("cache failure notices", () => {
  it("registers the two new notices in the workspace url contract", () => {
    // Given / When / Then: URL notice 계약에 신규 2종이 포함된다.
    expect(ADMIN_PLACES_NOTICES).toContain("env-blocked")
    expect(ADMIN_PLACES_NOTICES).toContain("cache-refresh-failed")
  })

  it("maps env-blocked and cache-refresh-failed to persistent failure toasts", () => {
    // Given / When: 두 실패 notice의 Toast 매핑.
    const envBlocked = resolveNoticeToast("env-blocked", null)
    const cacheFailed = resolveNoticeToast("cache-refresh-failed", null)

    // Then: 실패 톤(자동 닫힘 없음)으로 표시되고, DB 성공/캐시 실패 분리가 문구에 드러난다.
    expect(envBlocked?.tone).toBe("failure")
    expect(envBlocked?.message).toContain("Preview 환경")
    expect(cacheFailed?.tone).toBe("failure")
    expect(cacheFailed?.message).toContain("DB 처리는 완료")
    expect(cacheFailed?.message).toContain("캐시 갱신 확인에 실패")
  })

  it("renders cache-refresh-failed as a persistent failure toast", () => {
    // Given: cache-refresh-failed notice 렌더.
    const markup = renderToStaticMarkup(createElement(NoticeToast, { notice: "cache-refresh-failed", aiCode: null }))

    // Then: 실패 표기(⚠/실패)와 함께 노출되어 게시 성공으로 오인되지 않는다.
    expect(markup).toContain("⚠")
    expect(markup).toContain("실패")
    expect(markup).toContain("캐시 갱신 확인에 실패")
  })
})
