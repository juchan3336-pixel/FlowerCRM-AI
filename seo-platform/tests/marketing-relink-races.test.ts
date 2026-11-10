import { describe, expect, it } from "vitest"

import { createInMemoryMarketingRepository } from "@/lib/marketing/in-memory-repository"
import { createMarketingService } from "@/lib/marketing/marketing-service"
import type { MarketingRepository } from "@/lib/marketing/repository"

// 상품 주소 저장과 다른 저장이 겹치는 순서를 저장소 호출 사이에 끼워 넣어 재현한다.
const ADMIN = "admin@example.com"
const COPY = { title: "근조화환 주문 전에 확인할 세 가지", body: "장례식장으로 근조화환을 보내실 때는 빈소 호실과 상주 성함, 리본 문구를 먼저 확인해 두시면 주문이 수월합니다." }
const X = "https://smartstore.naver.com/free77888/products/111"
const Y = "https://smartstore.naver.com/free77888/products/222"

async function setup() {
  const repo = createInMemoryMarketingRepository()
  const service = createMarketingService(repo)
  const campaign = await service.createCampaign({ code: "condolence-guide-01", name: "근조 주문 준비 안내", mode: "condolence", actor: ADMIN })
  if (!campaign.ok) {
    throw new Error("campaign expected")
  }
  const id = campaign.campaign.id
  const variant = await service.createVariant({ campaignId: id, code: "blog-w1", channel: "naver_blog", copy: COPY, actor: ADMIN })
  if (!variant.ok) {
    throw new Error("variant expected")
  }
  return { repo, service, id, variantId: variant.variant.id }
}

describe("상품 주소 저장이 다른 저장과 겹칠 때", () => {
  it("늦게 재개된 이전 저장이 최신 주소를 옛 주소로 되돌리지 않는다", async () => {
    const { repo, service, id, variantId } = await setup()
    // 요청 A가 X를 저장한 직후 멈춘 사이, 요청 B가 Y 저장과 재링크를 끝낸다
    let interleaved = false
    const repoA: MarketingRepository = {
      ...repo,
      async updateCampaignProductUrls(campaignId, productUrls) {
        const result = await repo.updateCampaignProductUrls(campaignId, productUrls)
        if (!interleaved) {
          interleaved = true
          await service.updateCampaignProductUrls({ campaignId, productUrls: { smartstore: Y }, actor: ADMIN })
        }
        return result
      },
    }
    const result = await createMarketingService(repoA).updateCampaignProductUrls({ campaignId: id, productUrls: { smartstore: X }, actor: ADMIN })

    expect(result).toMatchObject({ ok: true, pending: 0 })
    expect((await repo.findCampaign(id))?.product_urls).toEqual({ smartstore: Y })
    expect((await repo.findVariant(variantId))?.order_url.startsWith(`${Y}?nt_source=`)).toBe(true)
    // 반환하는 캠페인도 지금 저장된 값이다
    expect(result.ok && result.campaign.product_urls).toEqual({ smartstore: Y })
  })

  it("옛 주소를 읽고 있던 요청이 늦게 재개돼도, 최신 주소로 승인·내보낸 소재를 되돌리지 못한다", async () => {
    const { repo, service, id, variantId } = await setup()
    // 요청 A가 캠페인(X)을 읽은 직후 멈춘 사이, 요청 B가 Y 저장·재링크·검수·승인·내보내기를 모두 끝낸다
    await repo.updateCampaignProductUrls(id, { smartstore: X })
    let interleaved = false
    let exportedJobId = ""
    const repoA: MarketingRepository = {
      ...repo,
      async findCampaign(campaignId) {
        const snapshot = await repo.findCampaign(campaignId)
        if (!interleaved) {
          interleaved = true
          await service.updateCampaignProductUrls({ campaignId, productUrls: { smartstore: Y }, actor: ADMIN })
          const current = await repo.findVariant(variantId)
          const ref = { campaignId, variantId, expectedRevision: current?.revision ?? 0, actor: ADMIN }
          await service.requestReview(ref)
          await service.approve(ref)
          const job = await service.exportForPosting(ref)
          if (!job.ok) {
            throw new Error(`job expected: ${job.reason}`)
          }
          exportedJobId = job.job.id
        }
        // A는 멈추기 전에 읽은 옛 값(X)을 들고 재개한다
        return snapshot
      },
    }
    const before = await repo.findVariant(variantId)
    const result = await createMarketingService(repoA).updateCampaignProductUrls({ campaignId: id, productUrls: { smartstore: X }, actor: ADMIN })
    expect(result.ok).toBe(true)

    // 마지막으로 저장된 주소는 B의 Y다. A가 들고 있던 X 링크는 저장소가 거부하므로
    // B가 Y로 받은 승인과 게시 패키지가 그대로 남는다.
    const campaign = await repo.findCampaign(id)
    const variant = await repo.findVariant(variantId)
    expect(campaign?.product_urls).toEqual({ smartstore: Y })
    expect(variant?.order_url.startsWith(`${Y}?nt_source=`)).toBe(true)
    expect(variant).toMatchObject({ review_status: "approved", link_version: campaign?.product_urls_version })
    expect((await repo.findJob(exportedJobId))?.status).toBe("manual_ready")
    expect(result).toMatchObject({ pending: 0 })
    expect(before?.revision).toBeLessThan(variant?.revision ?? 0)
  })

  it("옛 주소 버전을 든 재링크는 저장소가 거부해, 최신 주소의 승인과 게시 패키지가 그대로 남는다", async () => {
    const { repo, service, id, variantId } = await setup()
    // B: Y 저장 → 재링크 → 검수 → 승인 → 내보내기 완료
    await service.updateCampaignProductUrls({ campaignId: id, productUrls: { smartstore: Y }, actor: ADMIN })
    const relinked = await repo.findVariant(variantId)
    const ref = { campaignId: id, variantId, expectedRevision: relinked?.revision ?? 0, actor: ADMIN }
    await service.requestReview(ref)
    await service.approve(ref)
    const job = await service.exportForPosting(ref)
    if (!job.ok || relinked === null) {
      throw new Error("job expected")
    }
    // A: 버전 1(옛 주소)을 보고 만든 링크를 지금의 최신 revision에 쓰려 한다
    const stale = await repo.reviseVariant(variantId, relinked.revision, {
      destinationCode: "smartstore",
      orderUrl: `${X}?nt_source=naver_blog&nt_medium=organic_social&nt_detail=condolence-guide-01.blog-w1`,
      trackingKind: "naver-nt",
      trackingParams: { nt_source: "naver_blog", nt_medium: "organic_social", nt_detail: "condolence-guide-01.blog-w1" },
      linkVersion: 1,
      title: relinked.title,
      body: relinked.body,
      caption: null,
      imageTexts: [],
      imageRefs: [],
    })
    expect(stale).toEqual({ kind: "campaign-changed" })
    expect(await repo.findVariant(variantId)).toMatchObject({ review_status: "approved", revision: relinked.revision })
    expect((await repo.findVariant(variantId))?.order_url.startsWith(`${Y}?nt_source=`)).toBe(true)
    expect((await repo.findJob(job.job.id))?.status).toBe("manual_ready")
  })

  it("끝내 맞추지 못한 소재는 성공한 척하지 않고 건수로 알린다", async () => {
    const { repo, id, variantId } = await setup()
    const alwaysStale: MarketingRepository = { ...repo, reviseVariant: () => Promise.resolve({ kind: "stale" }) }
    const result = await createMarketingService(alwaysStale).updateCampaignProductUrls({ campaignId: id, productUrls: { smartstore: X }, actor: ADMIN })
    expect(result).toMatchObject({ ok: true, relinked: 0, keptPosted: 0, pending: 1 })
    expect((await repo.findVariant(variantId))?.order_url.startsWith("https://smartstore.naver.com/free77888?")).toBe(true)
  })

  it("링크가 최신 주소와 어긋난 소재는 승인도 내보내기도 되지 않고, 그 자리에서 링크가 맞춰진다", async () => {
    const { repo, service, id, variantId } = await setup()
    const ref = { campaignId: id, variantId, expectedRevision: 1, actor: ADMIN }
    await service.requestReview(ref)
    // 재링크 없이 캠페인 주소만 바뀐 상태(재조정이 실패하고 남은 경우와 같다)
    await repo.updateCampaignProductUrls(id, { smartstore: X })

    expect(await service.approve(ref)).toMatchObject({ ok: false, reason: "link-outdated" })
    const relinked = await repo.findVariant(variantId)
    expect(relinked).toMatchObject({ revision: 2, review_status: "draft" })
    expect(relinked?.order_url.startsWith(`${X}?nt_source=`)).toBe(true)

    // 승인까지 끝난 뒤 주소가 바뀐 경우 — 내보내기에서 막힌다
    const ref2 = { ...ref, expectedRevision: 2 }
    await service.requestReview(ref2)
    expect((await service.approve(ref2)).ok).toBe(true)
    await repo.updateCampaignProductUrls(id, { smartstore: Y })
    expect(await service.exportForPosting(ref2)).toMatchObject({ ok: false, reason: "link-outdated" })
    expect(await repo.listJobs(variantId)).toEqual([])
    expect((await repo.findVariant(variantId))?.order_url.startsWith(`${Y}?nt_source=`)).toBe(true)
  })

  it("문안 수정이 저장되는 사이 주소가 바뀌었으면 수정 결과의 링크도 최신 주소가 된다", async () => {
    const { repo, id, variantId } = await setup()
    let interleaved = false
    // 문안 수정이 캠페인(옛 주소)을 읽은 뒤, 저장하기 전에 주소가 X로 바뀐다
    const repoA: MarketingRepository = {
      ...repo,
      async reviseVariant(targetId, expectedRevision, content) {
        if (!interleaved) {
          interleaved = true
          await repo.updateCampaignProductUrls(id, { smartstore: X })
        }
        return repo.reviseVariant(targetId, expectedRevision, content)
      },
    }
    const result = await createMarketingService(repoA).reviseVariant({ campaignId: id, variantId, expectedRevision: 1, copy: { ...COPY, title: "수정한 제목" }, actor: ADMIN })
    expect(result.ok && result.variant.order_url.startsWith(`${X}?nt_source=`)).toBe(true)
    expect(result.ok && result.variant.title).toBe("수정한 제목")
    expect((await repo.findVariant(variantId))?.order_url.startsWith(`${X}?nt_source=`)).toBe(true)
  })
})
