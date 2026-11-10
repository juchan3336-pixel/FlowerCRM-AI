import { describe, expect, it } from "vitest"

import { createInMemoryMarketingRepository } from "@/lib/marketing/in-memory-repository"
import { createMarketingService } from "@/lib/marketing/marketing-service"

const ADMIN = "admin@example.com"
const BODY = "장례식장으로 근조화환을 보내실 때는 빈소 호실과 상주 성함, 리본 문구를 먼저 확인해 두시면 주문이 수월합니다."
const COPY = { title: "근조화환 주문 전에 확인할 세 가지", body: BODY, caption: "근조화환 주문 준비 안내" }

async function setup() {
  let tick = 0
  // 시각이 호출마다 1초씩 흐르게 해 "최근 게시" 정렬을 결정적으로 만든다
  const now = () => new Date(Date.UTC(2026, 10, 10, 0, 0, tick++)).toISOString()
  const repo = createInMemoryMarketingRepository(now)
  const service = createMarketingService(repo, now)
  const created = await service.createCampaign({ code: "condolence-guide-01", name: "근조 주문 준비 안내", mode: "condolence", actor: ADMIN })
  if (!created.ok) {
    throw new Error("campaign expected")
  }
  return { repo, service, campaign: created.campaign }
}

describe("광고 배포 업무 흐름", () => {
  it("소재 작성부터 게시 확인까지 한 번에 이어진다", async () => {
    const { repo, service, campaign } = await setup()

    const created = await service.createVariant({ campaignId: campaign.id, code: "blog-v1", channel: "naver_blog", copy: COPY, actor: ADMIN })
    if (!created.ok) {
      throw new Error(`variant expected: ${created.reason}`)
    }
    // 네이버 블로그는 스마트스토어가 기본 목적지이고 nt 파라미터로 추적한다
    expect(created.variant).toMatchObject({ destination_code: "smartstore", tracking_kind: "naver-nt", review_status: "draft", revision: 1 })
    expect(created.variant.order_url).toBe("https://smartstore.naver.com/free77888?nt_source=naver_blog&nt_medium=organic_social&nt_detail=condolence-guide-01.blog-v1")

    const reviewed = await service.requestReview({ campaignId: campaign.id, variantId: created.variant.id, expectedRevision: 1, actor: ADMIN })
    expect(reviewed).toMatchObject({ ok: true, variant: { review_status: "needs_review" }, quality: { status: "pass" } })

    const approved = await service.approve({ campaignId: campaign.id, variantId: created.variant.id, expectedRevision: 1, actor: ADMIN })
    expect(approved).toMatchObject({ ok: true, variant: { review_status: "approved", approved_by: ADMIN } })

    const exported = await service.exportForPosting({ campaignId: campaign.id, variantId: created.variant.id, expectedRevision: 1, actor: ADMIN })
    if (!exported.ok) {
      throw new Error(`job expected: ${exported.reason}`)
    }
    expect(exported.job).toMatchObject({ status: "manual_ready", order_url: created.variant.order_url })
    // 내보내기만으로는 게시 완료가 아니다
    expect(await repo.listPostedPayloads("naver_blog", 10)).toEqual([])

    expect(await service.confirmPosted({ campaignId: campaign.id, variantId: exported.job.variant_id, jobId: exported.job.id, postedUrl: "blog.naver.com/x", actor: ADMIN })).toMatchObject({ ok: false, reason: "posted-url-invalid" })
    const confirmed = await service.confirmPosted({ campaignId: campaign.id, variantId: exported.job.variant_id, jobId: exported.job.id, postedUrl: " https://blog.naver.com/paldo/223000000000 ", actor: ADMIN })
    expect(confirmed).toMatchObject({ ok: true, job: { status: "manual_confirmed", posted_url: "https://blog.naver.com/paldo/223000000000", confirmed_by: ADMIN } })
    // 같은 확인을 두 번 눌러도 한 번만 반영된다
    expect(await service.confirmPosted({ campaignId: campaign.id, variantId: exported.job.variant_id, jobId: exported.job.id, postedUrl: "https://blog.naver.com/paldo/1", actor: ADMIN })).toMatchObject({ ok: false, reason: "stale" })

    expect((await repo.listEvents(created.variant.id)).map((event) => event.event_type)).toEqual(["created", "review_requested", "approved", "exported", "post_confirmed"])
  })

  it("목적지를 자사몰로 고르면 UTM 링크가 된다", async () => {
    const { service, campaign } = await setup()
    const created = await service.createVariant({ campaignId: campaign.id, code: "blog-own", channel: "naver_blog", destination: "imweb", copy: COPY, actor: ADMIN })
    expect(created).toMatchObject({
      ok: true,
      variant: { destination_code: "imweb", tracking_kind: "utm", order_url: "https://팔도플라워.com?utm_source=naver_blog&utm_medium=organic_social&utm_campaign=condolence-guide-01&utm_content=blog-own" },
    })
  })

  it("캠페인에 상품 주소가 있으면 그 주소로, 없으면 스토어 홈으로 보낸다", async () => {
    const { service } = await setup()
    const withProduct = await service.createCampaign({
      code: "wedding-01",
      name: "예식 축하",
      mode: "celebration",
      productUrls: { smartstore: "https://smartstore.naver.com/free77888/products/123" },
      actor: ADMIN,
    })
    if (!withProduct.ok) {
      throw new Error("campaign expected")
    }
    const copy = { title: "예식장 축하화환 리본 문구 정하는 법", body: "결혼식 축하화환은 예식 날짜와 홀 이름, 보내는 분 성함을 정확히 적는 것이 중요합니다." }
    const store = await service.createVariant({ campaignId: withProduct.campaign.id, code: "v1", channel: "naver_blog", copy, actor: ADMIN })
    const own = await service.createVariant({ campaignId: withProduct.campaign.id, code: "v2", channel: "instagram", copy, actor: ADMIN })
    expect(store.ok && store.variant.order_url).toBe("https://smartstore.naver.com/free77888/products/123?nt_source=naver_blog&nt_medium=organic_social&nt_detail=wedding-01.v1")
    expect(own.ok && own.variant.order_url).toBe("https://팔도플라워.com?utm_source=instagram&utm_medium=organic_social&utm_campaign=wedding-01&utm_content=v2")
    // 다른 판매자 스토어 주소는 캠페인에 등록할 수 없다
    expect(await service.createCampaign({ code: "bad-01", name: "x", mode: "celebration", productUrls: { smartstore: "https://smartstore.naver.com/other/products/1" }, actor: ADMIN })).toMatchObject({ ok: false, reason: "order-url" })
  })

  it("품질 검사에 실패한 소재는 검수 대기로 넘어가지 않고 사유가 저장된다", async () => {
    const { repo, service, campaign } = await setup()
    const created = await service.createVariant({ campaignId: campaign.id, code: "bad", channel: "naver_blog", copy: { title: "근조화환 당일 배송 보장", body: "결혼을 축하합니다. 전국 최저가로 보내드립니다." }, actor: ADMIN })
    if (!created.ok) {
      throw new Error("variant expected")
    }
    const reviewed = await service.requestReview({ campaignId: campaign.id, variantId: created.variant.id, expectedRevision: 1, actor: ADMIN })
    expect(reviewed.ok).toBe(false)
    expect(reviewed).toMatchObject({ reason: "quality-fail", quality: { status: "fail" } })
    const stored = await repo.findVariant(created.variant.id)
    expect(stored).toMatchObject({ review_status: "draft", quality_checked_revision: 1 })
    expect(JSON.stringify(stored?.quality_report)).toContain("delivery-guarantee")
    // 검수 대기가 아니므로 승인도, 내보내기도 되지 않는다
    expect((await service.approve({ campaignId: campaign.id, variantId: created.variant.id, expectedRevision: 1, actor: ADMIN })).ok).toBe(false)
    expect(await service.exportForPosting({ campaignId: campaign.id, variantId: created.variant.id, expectedRevision: 1, actor: ADMIN })).toMatchObject({ ok: false, reason: "not-approved" })
  })

  it("수정하면 승인이 풀리고, 이전 승인본의 게시 전 작업은 폐기된다", async () => {
    const { repo, service, campaign } = await setup()
    const created = await service.createVariant({ campaignId: campaign.id, code: "v1", channel: "naver_blog", copy: COPY, actor: ADMIN })
    if (!created.ok) {
      throw new Error("variant expected")
    }
    const id = created.variant.id
    await service.requestReview({ campaignId: campaign.id, variantId: id, expectedRevision: 1, actor: ADMIN })
    await service.approve({ campaignId: campaign.id, variantId: id, expectedRevision: 1, actor: ADMIN })
    const exported = await service.exportForPosting({ campaignId: campaign.id, variantId: id, expectedRevision: 1, actor: ADMIN })
    if (!exported.ok) {
      throw new Error("job expected")
    }

    const revised = await service.reviseVariant({ campaignId: campaign.id, variantId: id, expectedRevision: 1, destination: "imweb", copy: { ...COPY, title: "근조화환 주문 준비 안내" }, actor: ADMIN })
    expect(revised).toMatchObject({ ok: true, cancelledJobs: 1, variant: { revision: 2, review_status: "draft", destination_code: "imweb", tracking_kind: "utm", approval_hash: null } })
    expect((await repo.findJob(exported.job.id))?.status).toBe("cancelled")
    // 폐기된 작업은 게시 확인할 수 없다
    expect(await service.confirmPosted({ campaignId: campaign.id, variantId: exported.job.variant_id, jobId: exported.job.id, postedUrl: "https://blog.naver.com/x/1", actor: ADMIN })).toMatchObject({ ok: false, reason: "stale" })
    // 옛 화면에서 누른 버튼은 반영되지 않는다
    expect(await service.approve({ campaignId: campaign.id, variantId: id, expectedRevision: 1, actor: ADMIN })).toMatchObject({ ok: false, reason: "stale" })
    expect(await service.reviseVariant({ campaignId: campaign.id, variantId: id, expectedRevision: 1, copy: COPY, actor: ADMIN })).toMatchObject({ ok: false, reason: "stale" })
  })

  it("같은 채널에 이미 게시한 글과 같은 본문은 검수에서 막힌다", async () => {
    const { service, campaign } = await setup()
    const first = await service.createVariant({ campaignId: campaign.id, code: "v1", channel: "naver_blog", copy: COPY, actor: ADMIN })
    if (!first.ok) {
      throw new Error("variant expected")
    }
    await service.requestReview({ campaignId: campaign.id, variantId: first.variant.id, expectedRevision: 1, actor: ADMIN })
    await service.approve({ campaignId: campaign.id, variantId: first.variant.id, expectedRevision: 1, actor: ADMIN })
    const job = await service.exportForPosting({ campaignId: campaign.id, variantId: first.variant.id, expectedRevision: 1, actor: ADMIN })
    if (!job.ok) {
      throw new Error("job expected")
    }
    await service.confirmPosted({ campaignId: campaign.id, variantId: job.job.variant_id, jobId: job.job.id, postedUrl: "https://blog.naver.com/paldo/1", actor: ADMIN })

    const copyCat = await service.createVariant({ campaignId: campaign.id, code: "v2", channel: "naver_blog", copy: COPY, actor: ADMIN })
    if (!copyCat.ok) {
      throw new Error("variant expected")
    }
    const reviewed = await service.requestReview({ campaignId: campaign.id, variantId: copyCat.variant.id, expectedRevision: 1, actor: ADMIN })
    expect(reviewed).toMatchObject({ ok: false, reason: "quality-fail" })
    expect(JSON.stringify(reviewed)).toContain("repetition:body")

    // 다른 채널에는 같은 글을 낼 수 있다(채널별 변형)
    const otherChannel = await service.createVariant({ campaignId: campaign.id, code: "v3", channel: "naver_place", copy: COPY, actor: ADMIN })
    if (!otherChannel.ok) {
      throw new Error("variant expected")
    }
    expect((await service.requestReview({ campaignId: campaign.id, variantId: otherChannel.variant.id, expectedRevision: 1, actor: ADMIN })).ok).toBe(true)
  })

  it("다른 캠페인의 소재·다른 소재의 작업을 폼 값만 바꿔서 처리할 수 없다", async () => {
    const { repo, service, campaign } = await setup()
    const other = await service.createCampaign({ code: "other-01", name: "다른 캠페인", mode: "condolence", actor: ADMIN })
    if (!other.ok) {
      throw new Error("campaign expected")
    }
    const mine = await service.createVariant({ campaignId: campaign.id, code: "mine", channel: "naver_blog", copy: COPY, actor: ADMIN })
    const theirs = await service.createVariant({ campaignId: other.campaign.id, code: "theirs", channel: "naver_place", copy: { ...COPY, title: "근조화환 보내기 전 확인 사항" }, actor: ADMIN })
    if (!mine.ok || !theirs.ok) {
      throw new Error("variants expected")
    }
    // 캠페인 A 화면에서 캠페인 B의 소재 id를 넣어 보낸 경우
    const crossed = { campaignId: campaign.id, variantId: theirs.variant.id, expectedRevision: 1, actor: ADMIN }
    expect(await service.requestReview(crossed)).toMatchObject({ ok: false, reason: "not-found" })
    expect(await service.approve(crossed)).toMatchObject({ ok: false, reason: "not-found" })
    expect(await service.exportForPosting(crossed)).toMatchObject({ ok: false, reason: "not-found" })
    expect(await service.reviseVariant({ ...crossed, copy: COPY })).toMatchObject({ ok: false, reason: "not-found" })
    expect(await repo.findVariant(theirs.variant.id)).toMatchObject({ review_status: "draft", revision: 1, quality_checked_revision: null })

    // 소재 A의 화면에서 소재 B의 작업 id를 넣어 게시 확인을 보낸 경우
    const theirsRef = { campaignId: other.campaign.id, variantId: theirs.variant.id, expectedRevision: 1, actor: ADMIN }
    await service.requestReview(theirsRef)
    await service.approve(theirsRef)
    const theirJob = await service.exportForPosting(theirsRef)
    if (!theirJob.ok) {
      throw new Error("job expected")
    }
    expect(await service.confirmPosted({ campaignId: campaign.id, variantId: mine.variant.id, jobId: theirJob.job.id, postedUrl: "https://blog.naver.com/x/1", actor: ADMIN })).toMatchObject({ ok: false, reason: "not-found" })
    expect((await repo.findJob(theirJob.job.id))?.status).toBe("manual_ready")
  })

  it("게시가 확인된 소재는 화면을 거치지 않고 직접 요청해도 고칠 수 없다", async () => {
    const { repo, service, campaign } = await setup()
    const created = await service.createVariant({ campaignId: campaign.id, code: "v1", channel: "naver_blog", copy: COPY, actor: ADMIN })
    if (!created.ok) {
      throw new Error("variant expected")
    }
    const ref = { campaignId: campaign.id, variantId: created.variant.id, expectedRevision: 1, actor: ADMIN }
    await service.requestReview(ref)
    await service.approve(ref)
    const job = await service.exportForPosting(ref)
    if (!job.ok) {
      throw new Error("job expected")
    }
    await service.confirmPosted({ campaignId: campaign.id, variantId: created.variant.id, jobId: job.job.id, postedUrl: "https://blog.naver.com/paldo/1", actor: ADMIN })

    expect(await service.reviseVariant({ ...ref, copy: { ...COPY, title: "게시 후 바꾼 제목" } })).toMatchObject({ ok: false, reason: "already-posted" })
    expect(await repo.findVariant(created.variant.id)).toMatchObject({ revision: 1, review_status: "approved", title: COPY.title })
  })

  it("캠페인 지역명은 금지어 오탐에서 빼고, 지역이 없으면 그대로 막는다", async () => {
    const { service } = await setup()
    const copy = { title: "상주시 예식장 축하화환 안내", body: "상주시 예식장으로 축하화환을 보내실 때는 예식 날짜와 홀 이름을 확인해 주세요." }
    const withRegion = await service.createCampaign({ code: "wedding-sangju", name: "상주 예식", mode: "celebration", region: "상주시", actor: ADMIN })
    const noRegion = await service.createCampaign({ code: "wedding-any", name: "예식 일반", mode: "celebration", actor: ADMIN })
    if (!withRegion.ok || !noRegion.ok) {
      throw new Error("campaigns expected")
    }
    const ok = await service.createVariant({ campaignId: withRegion.campaign.id, code: "v1", channel: "naver_blog", copy, actor: ADMIN })
    const blocked = await service.createVariant({ campaignId: noRegion.campaign.id, code: "v1", channel: "naver_place", copy, actor: ADMIN })
    if (!ok.ok || !blocked.ok) {
      throw new Error("variants expected")
    }
    const okRef = { campaignId: withRegion.campaign.id, variantId: ok.variant.id, expectedRevision: 1, actor: ADMIN }
    expect((await service.requestReview(okRef)).ok).toBe(true)
    // 승인 때의 재검사도 같은 지역 맥락을 쓴다
    expect((await service.approve(okRef)).ok).toBe(true)
    expect(await service.requestReview({ campaignId: noRegion.campaign.id, variantId: blocked.variant.id, expectedRevision: 1, actor: ADMIN })).toMatchObject({ ok: false, reason: "quality-fail" })
    // 지역명과 무관한 장례 표현은 지역이 있어도 그대로 막힌다
    const funeral = await service.createVariant({ campaignId: withRegion.campaign.id, code: "v2", channel: "naver_place", copy: { title: "상주시 예식장 안내", body: "빈소로 보내는 화환도 함께 준비됩니다." }, actor: ADMIN })
    if (!funeral.ok) {
      throw new Error("variant expected")
    }
    expect(await service.requestReview({ campaignId: withRegion.campaign.id, variantId: funeral.variant.id, expectedRevision: 1, actor: ADMIN })).toMatchObject({ ok: false, reason: "quality-fail" })
  })

  it("먼저 승인해 둔 같은 글은, 다른 소재가 먼저 게시되면 내보내기에서 막힌다", async () => {
    const { repo, service, campaign } = await setup()
    const first = await service.createVariant({ campaignId: campaign.id, code: "v1", channel: "naver_blog", copy: COPY, actor: ADMIN })
    const second = await service.createVariant({ campaignId: campaign.id, code: "v2", channel: "naver_blog", copy: COPY, actor: ADMIN })
    if (!first.ok || !second.ok) {
      throw new Error("variants expected")
    }
    const firstRef = { campaignId: campaign.id, variantId: first.variant.id, expectedRevision: 1, actor: ADMIN }
    const secondRef = { campaignId: campaign.id, variantId: second.variant.id, expectedRevision: 1, actor: ADMIN }
    for (const ref of [firstRef, secondRef]) {
      await service.requestReview(ref)
      expect((await service.approve(ref)).ok).toBe(true)
    }
    const job = await service.exportForPosting(firstRef)
    if (!job.ok) {
      throw new Error("job expected")
    }
    await service.confirmPosted({ campaignId: campaign.id, variantId: first.variant.id, jobId: job.job.id, postedUrl: "https://blog.naver.com/paldo/1", actor: ADMIN })

    const blocked = await service.exportForPosting(secondRef)
    expect(blocked).toMatchObject({ ok: false, reason: "quality-fail" })
    expect(JSON.stringify(blocked)).toContain("repetition:body")
    expect(await repo.listJobs(second.variant.id)).toEqual([])

    // 같은 소재를 다른 계정으로 한 번 더 내보내는 것은 복제가 아니다
    await service.setChannel({ channel: "naver_blog", accountRef: "second-blog" })
    expect(await service.exportForPosting(firstRef)).toMatchObject({ ok: true, job: { channel_account: "second-blog" } })
  })

  it("감사 기록 저장이 실패해도 이미 끝난 상태 변경은 성공으로 돌려준다", async () => {
    const { repo, service, campaign } = await setup()
    const created = await service.createVariant({ campaignId: campaign.id, code: "v1", channel: "naver_blog", copy: COPY, actor: ADMIN })
    if (!created.ok) {
      throw new Error("variant expected")
    }
    const failing = createMarketingService({ ...repo, appendEvent: () => Promise.reject(new Error("events table unavailable")) })
    const ref = { campaignId: campaign.id, variantId: created.variant.id, expectedRevision: 1, actor: ADMIN }
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args)
    }
    try {
      expect((await failing.requestReview(ref)).ok).toBe(true)
      expect((await failing.approve(ref)).ok).toBe(true)
    } finally {
      console.error = original
    }
    expect(await repo.findVariant(created.variant.id)).toMatchObject({ review_status: "approved" })
    // 누락은 서버 로그에 남는다
    expect(errors).toHaveLength(2)
  })

  it("잘못된 입력은 사유와 함께 거부한다", async () => {
    const { service, campaign } = await setup()
    const base = { campaignId: campaign.id, channel: "naver_blog", copy: COPY, actor: ADMIN }
    expect(await service.createVariant({ ...base, code: "한글코드" })).toMatchObject({ ok: false, reason: "code-format" })
    expect(await service.createVariant({ ...base, code: "v1", channel: "tistory" })).toMatchObject({ ok: false, reason: "channel-unknown" })
    expect(await service.createVariant({ ...base, code: "v1", copy: { title: " ", body: BODY } })).toMatchObject({ ok: false, reason: "empty-copy" })
    expect(await service.createVariant({ ...base, code: "v1", campaignId: "00000000-0000-4000-8000-000000000000" })).toMatchObject({ ok: false, reason: "not-found" })
    expect((await service.createVariant({ ...base, code: "v1" })).ok).toBe(true)
    expect(await service.createVariant({ ...base, code: "v1" })).toMatchObject({ ok: false, reason: "code-taken" })
    expect(await service.createCampaign({ code: "condolence-guide-01", name: "중복", mode: "condolence", actor: ADMIN })).toMatchObject({ ok: false, reason: "code-taken" })
  })

  it("채널을 중지하면 내보내기가 막히고, 계정을 설정하면 작업에 기록된다", async () => {
    const { service, campaign } = await setup()
    const created = await service.createVariant({ campaignId: campaign.id, code: "v1", channel: "naver_blog", copy: COPY, actor: ADMIN })
    if (!created.ok) {
      throw new Error("variant expected")
    }
    await service.requestReview({ campaignId: campaign.id, variantId: created.variant.id, expectedRevision: 1, actor: ADMIN })
    await service.approve({ campaignId: campaign.id, variantId: created.variant.id, expectedRevision: 1, actor: ADMIN })

    expect((await service.setChannel({ channel: "naver_blog", publishMode: "disabled" })).ok).toBe(true)
    expect(await service.exportForPosting({ campaignId: campaign.id, variantId: created.variant.id, expectedRevision: 1, actor: ADMIN })).toMatchObject({ ok: false, reason: "channel-disabled" })

    expect(await service.setChannel({ channel: "naver_blog", accountRef: "paldo blog" })).toMatchObject({ ok: false, reason: "account-format" })
    expect((await service.setChannel({ channel: "naver_blog", publishMode: "manual", accountRef: "paldo-blog" })).ok).toBe(true)
    expect(await service.exportForPosting({ campaignId: campaign.id, variantId: created.variant.id, expectedRevision: 1, actor: ADMIN })).toMatchObject({ ok: true, job: { channel_account: "paldo-blog" } })
  })
})
