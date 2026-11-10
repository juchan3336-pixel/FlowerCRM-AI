import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { MarketingCampaignContent } from "@/app/admin/marketing/[campaignId]/page"
import { MarketingMetricsContent } from "@/app/admin/marketing/metrics/page"
import { MarketingOverviewContent } from "@/app/admin/marketing/page"
import { ADMIN_NAV_ITEMS, isAdminNavItemActive } from "@/components/admin/admin-data"
import { failureMessage, loadCampaignDetail, loadMarketingOverview, metricsByDestination, noticeMessage, parseQualityReport, sumMetrics } from "@/lib/marketing/admin-view"
import { createInMemoryMarketingRepository } from "@/lib/marketing/in-memory-repository"
import { createMarketingService } from "@/lib/marketing/marketing-service"

const ADMIN = "admin@example.com"
const COPY = { title: "근조화환 주문 전에 확인할 세 가지", body: "장례식장으로 근조화환을 보내실 때는 빈소 호실과 상주 성함, 리본 문구를 먼저 확인해 두시면 주문이 수월합니다." }

async function setup() {
  const repo = createInMemoryMarketingRepository()
  const service = createMarketingService(repo)
  const campaign = await service.createCampaign({ code: "condolence-guide-01", name: "근조 주문 준비 안내", mode: "condolence", actor: ADMIN })
  if (!campaign.ok) {
    throw new Error("campaign expected")
  }
  const variant = await service.createVariant({ campaignId: campaign.campaign.id, code: "blog-v1", channel: "naver_blog", copy: COPY, actor: ADMIN })
  if (!variant.ok) {
    throw new Error("variant expected")
  }
  const render = async (options: { notice?: string; error?: string; useSample?: boolean } = {}) =>
    renderToStaticMarkup(
      createElement(MarketingCampaignContent, {
        detail: await loadCampaignDetail(repo, campaign.campaign.id),
        notice: options.notice ?? null,
        error: options.error ?? null,
        useSample: options.useSample ?? false,
      }),
    )
  return { repo, service, campaignId: campaign.campaign.id, variantId: variant.variant.id, render }
}

describe("광고 배포 메뉴", () => {
  it("관리자 메뉴에 등록되고 하위 화면에서도 활성 표시된다", () => {
    const item = ADMIN_NAV_ITEMS.find((entry) => entry.href === "/admin/marketing")
    if (item === undefined) {
      throw new Error("nav item missing")
    }
    expect(item.label).toBe("광고 배포")
    expect(isAdminNavItemActive(item, "/admin/marketing")).toBe(true)
    expect(isAdminNavItemActive(item, "/admin/marketing/metrics")).toBe(true)
    expect(isAdminNavItemActive(item, "/admin/search-report")).toBe(false)
  })
})

describe("전체 현황 화면", () => {
  it("테이블을 읽지 못하면 적용할 SQL 파일을 안내한다", () => {
    const markup = renderToStaticMarkup(createElement(MarketingOverviewContent, { overview: null, notice: null, error: null }))
    expect(markup).toContain("202611100001_marketing_distribution.sql")
    expect(markup).toContain("verify_marketing_distribution_migration.sql")
    expect(markup).not.toContain("캠페인 만들기")
  })

  it("주문 목적지 2곳, 채널 11개, 캠페인 집계와 만들기 폼을 보여준다", async () => {
    const { repo, service, variantId } = await setup()
    await service.requestReview({ variantId, expectedRevision: 1, actor: ADMIN })
    await service.approve({ variantId, expectedRevision: 1, actor: ADMIN })
    await service.exportForPosting({ variantId, expectedRevision: 1, actor: ADMIN })

    const overview = await loadMarketingOverview(repo)
    expect(overview.campaigns[0]).toMatchObject({ variantCount: 1, waitingCount: 1, postedCount: 0 })

    const markup = renderToStaticMarkup(createElement(MarketingOverviewContent, { overview, notice: "channel-saved", error: null }))
    expect(markup).toContain("https://팔도플라워.com")
    expect(markup).toContain("https://smartstore.naver.com/free77888")
    expect(markup).toContain("근조 주문 준비 안내")
    expect(markup).toContain("캠페인 만들기")
    expect(markup).toContain("채널 설정을 저장했습니다.")
    expect(markup.match(/name="channel" value="/g)).toHaveLength(11)
    expect(markup).toContain("네이버 블로그")
  })
})

describe("캠페인 상세 화면 — 상태마다 다음 할 일 하나만 보여준다", () => {
  it("작성 중: 검수 요청 버튼과 추적 주문 링크", async () => {
    const { render } = await setup()
    const markup = await render()
    expect(markup).toContain("작성 중")
    expect(markup).toContain("검수 요청 (품질 검사)")
    expect(markup).toContain("nt_source=naver_blog&amp;nt_medium=organic_social&amp;nt_detail=condolence-guide-01.blog-v1")
    expect(markup).not.toContain("게시 패키지 내보내기")
    expect(markup).not.toContain("올린 글의 주소")
  })

  it("품질 검사 실패: 걸린 사유를 그대로 보여주고 검수 대기로 넘어가지 않는다", async () => {
    const { service, campaignId, render } = await setup()
    const bad = await service.createVariant({ campaignId, code: "bad", channel: "naver_place", copy: { title: "근조화환 안내", body: "결혼을 축하합니다. 당일 배송을 보장합니다." }, actor: ADMIN })
    if (!bad.ok) {
      throw new Error("variant expected")
    }
    await service.requestReview({ variantId: bad.variant.id, expectedRevision: 1, actor: ADMIN })
    const markup = await render({ error: "quality-fail" })
    expect(markup).toContain("품질 검사에서 걸렸습니다")
    expect(markup).toContain("품질 검사에서 걸린 항목")
    expect(markup).toContain("배송 확정·보장 표현 금지")
    expect(markup).toContain("근조 소재에 쓸 수 없는 축하 표현")
  })

  it("검수 대기 → 승인됨 → 게시 대기 → 게시 확인됨 순서로 버튼이 바뀐다", async () => {
    const { service, variantId, render } = await setup()

    await service.requestReview({ variantId, expectedRevision: 1, actor: ADMIN })
    let markup = await render({ notice: "review-passed" })
    expect(markup).toContain("검수 대기")
    expect(markup).toContain("제목·본문·주문 링크를 직접 읽고 확인했습니다")
    expect(markup).not.toContain("검수 요청 (품질 검사)")

    await service.approve({ variantId, expectedRevision: 1, actor: ADMIN })
    markup = await render()
    expect(markup).toContain("게시 패키지 내보내기")
    expect(markup).not.toContain("올린 글의 주소")

    const exported = await service.exportForPosting({ variantId, expectedRevision: 1, actor: ADMIN })
    if (!exported.ok) {
      throw new Error("job expected")
    }
    markup = await render({ notice: "exported" })
    expect(markup).toContain("게시 대기(내보냄)")
    expect(markup).toContain("제목+본문+주문 링크 복사")
    expect(markup).toContain("복사만으로는 게시 완료가 아닙니다")
    expect(markup).toContain("올린 글의 주소")
    expect(markup).toContain(`name="jobId" value="${exported.job.id}"`)

    await service.confirmPosted({ jobId: exported.job.id, postedUrl: "https://blog.naver.com/paldo/223000000000", actor: ADMIN })
    markup = await render({ notice: "confirmed" })
    expect(markup).toContain("게시 확인됨")
    expect(markup).toContain("https://blog.naver.com/paldo/223000000000")
    // 게시가 확인된 소재에는 수정·재게시 버튼이 없다
    expect(markup).not.toContain("수정 저장")
    expect(markup).not.toContain("게시 패키지 내보내기")
  })

  it("예시 문안 채우기는 캠페인 종류에 맞는 문안을 새 소재 폼에 넣는다", async () => {
    const { render } = await setup()
    const markup = await render({ useSample: true })
    expect(markup).toContain("도착 시점은 주문 과정에서 확인하실 수 있습니다.")
    expect(markup).not.toContain("결혼식 축하화환은")
    expect(markup).not.toContain("예시 문안으로 채우기")
  })

  it("중지된 채널은 새 소재의 채널 목록에서 빠진다", async () => {
    const { service, render } = await setup()
    await service.setChannel({ channel: "instagram", publishMode: "disabled" })
    const markup = await render()
    expect(markup).not.toContain('<option value="instagram">')
    expect(markup).toContain('<option value="naver_blog">')
  })

  it("테이블을 읽지 못하면 적용 안내를 보여준다", () => {
    const markup = renderToStaticMarkup(createElement(MarketingCampaignContent, { detail: null, notice: null, error: null, useSample: false }))
    expect(markup).toContain("202611100001_marketing_distribution.sql")
  })
})

describe("성과 화면", () => {
  it("두 쇼핑몰을 따로 합산하고, 수집하지 않은 수치는 '미수집'으로 보여준다", async () => {
    const { repo, campaignId } = await setup()
    await repo.upsertMetrics([
      { date: "2026-11-09", source: "smartstore_report", destinationCode: "smartstore", channelCode: "naver_blog", campaignId, visits: 40, orders: 2, revenueKrw: 178000 },
      { date: "2026-11-10", source: "smartstore_report", destinationCode: "smartstore", channelCode: "naver_blog", campaignId, visits: 25, orders: 1, revenueKrw: 89000 },
      { date: "2026-11-10", source: "naver_ads_report", channelCode: "naver_search_ad", adCostKrw: 15000 },
    ])
    const rows = await repo.listMetrics({ from: "2026-11-01", to: "2026-11-30" })
    expect(metricsByDestination(rows).smartstore).toEqual({ visits: 65, orders: 3, revenueKrw: 267000, adCostKrw: null, workMinutes: null })
    expect(metricsByDestination(rows).imweb).toEqual({ visits: null, orders: null, revenueKrw: null, adCostKrw: null, workMinutes: null })
    expect(sumMetrics(rows).adCostKrw).toBe(15000)

    const markup = renderToStaticMarkup(
      createElement(MarketingMetricsContent, {
        data: { rows, campaigns: await repo.listCampaigns(), channels: await repo.listChannels(), from: "2026-10-12", to: "2026-11-10" },
        notice: "metrics-saved",
        error: null,
      }),
    )
    expect(markup).toContain("267,000원")
    expect(markup).toContain("15,000원")
    expect(markup).toContain("미수집")
    expect(markup).toContain("성과를 기록했습니다.")
    expect(markup).toContain("근조 주문 준비 안내")
  })
})

describe("안내 문구", () => {
  it("알려진 사유는 조치 방법이 든 문구로, 모르는 코드는 일반 문구로 바꾼다", () => {
    expect(failureMessage("code-format")).toContain("마침표")
    expect(failureMessage("order-url")).toContain("free77888")
    expect(failureMessage("server")).toContain("202611100001")
    expect(failureMessage("not-reviewed")).toContain("체크")
    expect(failureMessage("toString")).toBe("처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
    expect(noticeMessage("exported")).toContain("주소를 입력")
    expect(noticeMessage("unknown-code")).toBeNull()
    expect(noticeMessage("constructor")).toBeNull()
  })

  it("저장된 품질 결과가 깨져 있어도 화면이 죽지 않는다", () => {
    expect(parseQualityReport(null)).toEqual({ status: null, issues: [] })
    expect(parseQualityReport("oops")).toEqual({ status: null, issues: [] })
    expect(parseQualityReport({ status: "fail", issues: [{ level: "fail", code: "a", message: "m" }, { level: "x" }, 3] })).toEqual({ status: "fail", issues: [{ level: "fail", code: "a", message: "m" }] })
  })
})
