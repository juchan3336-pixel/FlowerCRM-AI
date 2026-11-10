import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { MarketingCampaignContent } from "@/app/admin/marketing/[campaignId]/page"
import type { ContentMode } from "@/lib/ai/content-mode"
import { evaluateAdCopy } from "@/lib/marketing/ad-quality"
import { loadCampaignDetail } from "@/lib/marketing/admin-view"
import { createInMemoryMarketingRepository } from "@/lib/marketing/in-memory-repository"
import { createMarketingService } from "@/lib/marketing/marketing-service"
import { ORDER_BANNER_SIZE, orderBannerFileName, orderBannerSpec, orderBannerTexts } from "@/lib/marketing/order-banner"

const ADMIN = "admin@example.com"
const COPY = { title: "근조화환 주문 전에 확인할 세 가지", body: "장례식장으로 근조화환을 보내실 때는 빈소 호실과 상주 성함, 리본 문구를 먼저 확인해 두시면 주문이 수월합니다." }
const PRODUCT = "https://smartstore.naver.com/free77888/products/123"
const MODES: readonly ContentMode[] = ["condolence", "celebration", "corporate-celebration"]

async function setup() {
  const repo = createInMemoryMarketingRepository()
  const service = createMarketingService(repo)
  const campaign = await service.createCampaign({ code: "condolence-guide-01", name: "근조 주문 준비 안내", mode: "condolence", actor: ADMIN })
  if (!campaign.ok) {
    throw new Error("campaign expected")
  }
  const id = campaign.campaign.id
  const make = async (code: string, channel: string, title = COPY.title) => {
    const created = await service.createVariant({ campaignId: id, code, channel, copy: { ...COPY, title }, actor: ADMIN })
    if (!created.ok) {
      throw new Error(`variant expected: ${created.reason}`)
    }
    return created.variant
  }
  const ref = (variantId: string, expectedRevision = 1) => ({ campaignId: id, variantId, expectedRevision, actor: ADMIN })
  return { repo, service, id, make, ref }
}

describe("캠페인 상품 주소를 나중에 넣기", () => {
  it("저장하면 아직 게시하지 않은 소재의 주문 링크가 상품 주소로 다시 만들어진다", async () => {
    const { repo, service, id, make, ref } = await setup()
    const draft = await make("blog-draft", "naver_blog")
    const approved = await make("place-approved", "naver_place", "근조화환 보내기 전 확인 사항")
    await service.requestReview(ref(approved.id))
    await service.approve(ref(approved.id))
    const exported = await service.exportForPosting(ref(approved.id))
    if (!exported.ok) {
      throw new Error("job expected")
    }
    expect(draft.order_url.startsWith("https://smartstore.naver.com/free77888?")).toBe(true)

    const result = await service.updateCampaignProductUrls({ campaignId: id, productUrls: { smartstore: PRODUCT }, actor: ADMIN })
    expect(result).toMatchObject({ ok: true, relinked: 2, keptPosted: 0 })

    const after = await repo.listVariants(id)
    for (const variant of after) {
      expect(variant.order_url.startsWith(`${PRODUCT}?nt_source=`), variant.code).toBe(true)
      // 추적 값은 그대로 유지된다
      expect(variant.order_url).toContain(`nt_detail=condolence-guide-01.${variant.code}`)
      // 승인한 링크와 나가는 링크가 달라지지 않도록 다시 검수받게 된다
      expect(variant).toMatchObject({ revision: 2, review_status: "draft", approval_hash: null })
    }
    // 이전 링크로 내보낸 게시 패키지는 폐기된다
    expect((await repo.findJob(exported.job.id))?.status).toBe("cancelled")
    expect((await repo.listEvents(draft.id)).map((event) => event.event_type)).toContain("relinked")
  })

  it("이미 게시된 소재는 그대로 두고 건수로 알려준다", async () => {
    const { repo, service, id, make, ref } = await setup()
    const posted = await make("blog-posted", "naver_blog")
    await service.requestReview(ref(posted.id))
    await service.approve(ref(posted.id))
    const job = await service.exportForPosting(ref(posted.id))
    if (!job.ok) {
      throw new Error("job expected")
    }
    await service.confirmPosted({ campaignId: id, variantId: posted.id, jobId: job.job.id, postedUrl: "https://blog.naver.com/paldo/1", actor: ADMIN })

    const result = await service.updateCampaignProductUrls({ campaignId: id, productUrls: { smartstore: PRODUCT }, actor: ADMIN })
    expect(result).toMatchObject({ ok: true, relinked: 0, keptPosted: 1 })
    expect(await repo.findVariant(posted.id)).toMatchObject({ revision: 1, order_url: posted.order_url, review_status: "approved" })
    expect((await repo.findJob(job.job.id))?.order_url).toBe(posted.order_url)
  })

  it("링크가 달라지지 않는 소재는 건드리지 않는다", async () => {
    const { repo, service, id, make } = await setup()
    // 자사몰로 가는 소재는 스마트스토어 상품 주소가 바뀌어도 영향이 없다
    const own = await service.createVariant({ campaignId: id, code: "insta", channel: "instagram", copy: COPY, actor: ADMIN })
    await make("blog", "naver_blog")
    const result = await service.updateCampaignProductUrls({ campaignId: id, productUrls: { smartstore: PRODUCT }, actor: ADMIN })
    expect(result).toMatchObject({ ok: true, relinked: 1 })
    expect(own.ok && (await repo.findVariant(own.variant.id))?.revision).toBe(1)
    // 같은 주소로 다시 저장하면 아무것도 바뀌지 않는다
    expect(await service.updateCampaignProductUrls({ campaignId: id, productUrls: { smartstore: PRODUCT }, actor: ADMIN })).toMatchObject({ ok: true, relinked: 0 })
  })

  it("주소를 비우면 스토어 첫 화면으로 돌아간다", async () => {
    const { repo, service, id, make } = await setup()
    const variant = await make("blog", "naver_blog")
    await service.updateCampaignProductUrls({ campaignId: id, productUrls: { smartstore: PRODUCT }, actor: ADMIN })
    await service.updateCampaignProductUrls({ campaignId: id, productUrls: {}, actor: ADMIN })
    expect((await repo.findVariant(variant.id))?.order_url).toBe(variant.order_url)
    expect((await repo.findCampaign(id))?.product_urls).toEqual({})
  })

  it("허용 범위 밖 주소와 없는 캠페인은 거부하고 아무것도 바꾸지 않는다", async () => {
    const { repo, service, id, make } = await setup()
    const variant = await make("blog", "naver_blog")
    for (const bad of ["https://smartstore.naver.com/other-seller/products/1", "http://smartstore.naver.com/free77888/products/1", "https://example.com/x"]) {
      expect(await service.updateCampaignProductUrls({ campaignId: id, productUrls: { smartstore: bad }, actor: ADMIN }), bad).toMatchObject({ ok: false, reason: "order-url" })
    }
    expect(await service.updateCampaignProductUrls({ campaignId: id, productUrls: { imweb: "https://팔도플라워.com.evil.example/shop" }, actor: ADMIN })).toMatchObject({ ok: false, reason: "order-url" })
    expect(await service.updateCampaignProductUrls({ campaignId: "00000000-0000-4000-8000-000000000000", productUrls: { smartstore: PRODUCT }, actor: ADMIN })).toMatchObject({ ok: false, reason: "not-found" })
    expect(await repo.findVariant(variant.id)).toMatchObject({ revision: 1, order_url: variant.order_url })
    expect((await repo.findCampaign(id))?.product_urls).toEqual({})
  })

  it("캠페인 화면에 상품 주소 입력란과 저장된 값, 변경 결과가 보인다", async () => {
    const { repo, service, id, make } = await setup()
    await make("blog", "naver_blog")
    await service.updateCampaignProductUrls({ campaignId: id, productUrls: { smartstore: PRODUCT }, actor: ADMIN })
    const markup = renderToStaticMarkup(
      createElement(MarketingCampaignContent, { detail: await loadCampaignDetail(repo, id), notice: "product-urls-saved", error: null, useSample: false, relink: { relinked: 1, kept: 2 } }),
    )
    expect(markup).toContain("상품 주소 저장")
    expect(markup).toContain(`value="${PRODUCT}"`)
    expect(markup).toContain("상품 주소를 저장했습니다.")
    expect(markup).toContain("게시 전 소재 1개의 주문 링크를 새 주소로 바꿨습니다")
    expect(markup).toContain("이미 게시된 소재 2개는 그대로 두었습니다")
  })
})

describe("주문 배너", () => {
  it.each(MODES)("%s 배너의 문구는 광고 문안과 같은 품질 검사를 통과한다", (mode) => {
    const [brand, headline, ...rest] = orderBannerTexts(mode)
    const report = evaluateAdCopy({ mode, copy: { title: headline ?? "", body: `${brand ?? ""} ${rest.join(" ")}`, imageTexts: orderBannerTexts(mode) } })
    expect(report, JSON.stringify(report.issues)).toEqual({ status: "pass", issues: [] })
  })

  it("근조 배너에는 축하 표현이 없고, 축하 배너에는 장례 표현이 없다", () => {
    expect(orderBannerTexts("condolence").join(" ")).not.toMatch(/축하|결혼|예식|개업/)
    for (const mode of ["celebration", "corporate-celebration"] as const) {
      expect(orderBannerTexts(mode).join(" ")).not.toMatch(/근조|빈소|장례|조문/)
    }
  })

  it("모드마다 문구와 색이 정해져 있고, 파일 이름으로 어느 소재의 배너인지 알 수 있다", () => {
    expect(ORDER_BANNER_SIZE).toEqual({ width: 1200, height: 400 })
    expect(new Set(MODES.map((mode) => orderBannerSpec(mode).headline)).size).toBe(3)
    for (const mode of MODES) {
      const spec = orderBannerSpec(mode)
      for (const color of [spec.background, spec.foreground, spec.muted, spec.accent, spec.accentText]) {
        expect(color).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
    expect(orderBannerFileName("condolence-guide-01", "blog-w1")).toBe("order-banner-condolence-guide-01-blog-w1.png")
  })

  it("게시 패키지에 주문 배너와 링크 넣는 방법이 함께 나온다", async () => {
    const { repo, service, id, make, ref } = await setup()
    const variant = await make("blog-w1", "naver_blog")
    const before = renderToStaticMarkup(createElement(MarketingCampaignContent, { detail: await loadCampaignDetail(repo, id), notice: null, error: null, useSample: false }))
    expect(before).not.toContain("주문 배너 이미지")

    await service.requestReview(ref(variant.id))
    await service.approve(ref(variant.id))
    await service.exportForPosting(ref(variant.id))
    const markup = renderToStaticMarkup(createElement(MarketingCampaignContent, { detail: await loadCampaignDetail(repo, id), notice: null, error: null, useSample: false }))
    expect(markup).toContain("주문 배너 이미지")
    expect(markup).toContain("배너 이미지 내려받기")
    expect(markup).toContain("배너에 걸 링크 복사")
    expect(markup).toContain('width="1200"')
    expect(markup).toContain("주문 배너 미리보기: 근조화환 주문하기")
  })
})
