import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { approveVariant, computeVariantApprovalHash, confirmManualPost, isVariantApprovalValid } from "@/lib/marketing/approval"
import { listMarketingChannels } from "@/lib/marketing/channel-policy"
import { canTransitionJob, combinedDistributionStatus } from "@/lib/marketing/distribution-state"
import { createInMemoryMarketingRepository } from "@/lib/marketing/in-memory-repository"
import { listOrderDestinations } from "@/lib/marketing/order-destination"
import { metricDimensionKey, variantRowToDraft, type CreateVariantInput, type MarketingRepository, type VariantContent } from "@/lib/marketing/repository"
import { buildTrackedOrderUrl } from "@/lib/marketing/tracking-url"
import type { Json, MarketingVariantRow } from "@/types/database"

const MIGRATION = readFileSync(join(process.cwd(), "supabase/migrations/202611100001_marketing_distribution.sql"), "utf8")
const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)
const ADMIN = "admin@example.com"
const AT = "2026-11-10T09:00:00+09:00"

function content(overrides: Partial<VariantContent> = {}): VariantContent {
  const tracked = buildTrackedOrderUrl({ channel: "naver_blog", destination: "smartstore", baseUrl: "https://smartstore.naver.com/free77888", campaignCode: "condolence-guide-01", variantCode: "v1" })
  return {
    destinationCode: "smartstore",
    orderUrl: tracked.url,
    trackingKind: tracked.trackingKind,
    trackingParams: tracked.params,
    title: "근조화환 주문 전에 확인할 세 가지",
    body: "장례식장으로 근조화환을 보내실 때는 빈소 호실과 상주 성함, 리본 문구를 먼저 확인해 두시면 주문이 수월합니다.",
    caption: null,
    imageTexts: ["근조화환 주문 준비"],
    imageRefs: [{ image_id: "img-1", content_hash: HASH_A }],
    ...overrides,
  }
}

async function seed(repo: MarketingRepository): Promise<MarketingVariantRow> {
  const campaign = await repo.createCampaign({ code: "condolence-guide-01", name: "근조 주문 준비 안내", mode: "condolence", createdBy: ADMIN })
  if (campaign.kind !== "created") {
    throw new Error("campaign expected")
  }
  const input: CreateVariantInput = { ...content(), campaignId: campaign.campaign.id, code: "v1", channelCode: "naver_blog", mode: "condolence", createdBy: ADMIN }
  const variant = await repo.createVariant(input)
  if (variant.kind !== "created") {
    throw new Error("variant expected")
  }
  return variant.variant
}

// 검수 통과 → 승인까지 진행한 소재를 돌려준다
async function approved(repo: MarketingRepository): Promise<MarketingVariantRow> {
  const variant = await seed(repo)
  await repo.recordReview(variant.id, 1, { status: "pass", issues: [] }, true)
  const result = await repo.approveVariant(variant.id, 1, { approvalHash: computeVariantApprovalHash(variantRowToDraft(variant)), approvedBy: ADMIN, approvedAt: AT })
  if (result.kind !== "updated") {
    throw new Error("approval expected")
  }
  return result.row
}

describe("migration과 코드의 정합성", () => {
  it("채널 시드가 코드의 채널 목록과 한 줄씩 일치한다", () => {
    for (const channel of listMarketingChannels()) {
      const row = `('${channel.code}', '${channel.label}', '${channel.tier}', '${channel.publishMode}', '${channel.medium}', '${channel.defaultDestination}')`
      expect(MIGRATION, channel.code).toContain(row)
    }
    const seeded = MIGRATION.match(/^ {2}\('[a-z_]+', '[^']+', '(?:primary|secondary)'/gm) ?? []
    expect(seeded).toHaveLength(listMarketingChannels().length)
  })

  it("목적지 시드가 코드의 두 목적지와 일치한다", () => {
    for (const destination of listOrderDestinations()) {
      expect(MIGRATION).toContain(`('${destination.code}', '${destination.label}', '${destination.baseUrl}')`)
    }
  })

  it("추적 코드 규칙이 코드와 같다 — 마침표 금지", () => {
    expect(MIGRATION.match(/code ~ '\^\[A-Za-z0-9_-\]\{1,50\}\$'/g)).toHaveLength(2)
    expect(() => buildTrackedOrderUrl({ channel: "naver_blog", destination: "smartstore", baseUrl: "https://smartstore.naver.com/free77888", campaignCode: "a.b", variantCode: "v1" })).toThrow()
  })

  it("모든 신규 테이블에 RLS를 켜고 공개 역할 권한을 회수한다", () => {
    const tables = [...MIGRATION.matchAll(/create table if not exists public\.(marketing_[a-z_]+)/g)].map((match) => match[1])
    expect(tables).toHaveLength(8)
    for (const table of tables) {
      expect(MIGRATION).toContain(`alter table public.${String(table)} enable row level security;`)
      expect(MIGRATION.split("revoke all on table")[1]).toContain(`public.${String(table)}`)
    }
    expect(MIGRATION).not.toMatch(/create policy/i)
    // 기존 공개 SEO 테이블은 건드리지 않는다
    expect(MIGRATION).not.toMatch(/alter table public\.(places|seo_pages|batch_)/)
  })
})

describe("저장소 계약 (메모리 구현)", () => {
  it("채널 11개와 목적지 2곳이 시드되어 있다", async () => {
    const repo = createInMemoryMarketingRepository()
    expect(await repo.listChannels()).toHaveLength(11)
    expect((await repo.listDestinations()).map((row) => row.base_url)).toEqual(["https://팔도플라워.com", "https://smartstore.naver.com/free77888"])
  })

  it("캠페인 코드와 캠페인 내 소재 코드는 유일하다", async () => {
    const repo = createInMemoryMarketingRepository()
    const variant = await seed(repo)
    expect(await repo.createCampaign({ code: "condolence-guide-01", name: "중복", mode: "condolence", createdBy: ADMIN })).toEqual({ kind: "code-taken" })
    expect(await repo.createVariant({ ...content(), campaignId: variant.campaign_id, code: "v1", channelCode: "naver_place", mode: "condolence", createdBy: ADMIN })).toEqual({ kind: "code-taken" })
    expect((await repo.createVariant({ ...content(), campaignId: variant.campaign_id, code: "v2", channelCode: "naver_place", mode: "condolence", createdBy: ADMIN })).kind).toBe("created")
  })

  it("검수 실패는 draft에 머물고, 통과해야 검수 대기로 넘어간다", async () => {
    const repo = createInMemoryMarketingRepository()
    const variant = await seed(repo)
    const failed = await repo.recordReview(variant.id, 1, { status: "fail", issues: [] }, false)
    expect(failed).toMatchObject({ kind: "updated", row: { review_status: "draft", quality_checked_revision: 1 } })
    // 품질 검사를 통과하지 않은 소재는 승인할 수 없다
    expect(await repo.approveVariant(variant.id, 1, { approvalHash: HASH_A, approvedBy: ADMIN, approvedAt: AT })).toEqual({ kind: "stale" })

    const passed = await repo.recordReview(variant.id, 1, { status: "pass", issues: [] }, true)
    expect(passed).toMatchObject({ kind: "updated", row: { review_status: "needs_review" } })
  })

  it("승인은 현재 revision에만 붙고, 수정하면 승인·품질 결과가 지워진다", async () => {
    const repo = createInMemoryMarketingRepository()
    const row = await approved(repo)
    expect(row).toMatchObject({ review_status: "approved", approved_revision: 1, approved_by: ADMIN })

    const revised = await repo.reviseVariant(row.id, 1, content({ body: "수정한 본문입니다. 빈소 호실을 먼저 확인해 주세요." }))
    expect(revised).toMatchObject({ kind: "updated", row: { revision: 2, review_status: "draft", approved_revision: null, approval_hash: null, quality_report: null, quality_checked_revision: null } })
  })

  it("옛 revision을 기준으로 한 수정·검수·승인은 반영되지 않는다", async () => {
    const repo = createInMemoryMarketingRepository()
    const variant = await seed(repo)
    await repo.reviseVariant(variant.id, 1, content({ title: "먼저 저장한 제목" }))
    expect(await repo.reviseVariant(variant.id, 1, content({ title: "늦게 온 수정" }))).toEqual({ kind: "stale" })
    expect(await repo.recordReview(variant.id, 1, {}, true)).toEqual({ kind: "stale" })
    expect(await repo.approveVariant(variant.id, 1, { approvalHash: HASH_A, approvedBy: ADMIN, approvedAt: AT })).toEqual({ kind: "stale" })
    expect((await repo.findVariant(variant.id))?.title).toBe("먼저 저장한 제목")
  })

  it("저장된 소재로 계산한 승인 해시는 이미지 내용이 바뀌면 달라진다", async () => {
    const repo = createInMemoryMarketingRepository()
    const row = await approved(repo)
    const snapshot = { revision: 1, approvalHash: row.approval_hash ?? "", approvedBy: ADMIN, approvedAt: AT }
    expect(isVariantApprovalValid(snapshot, variantRowToDraft(row))).toBe(true)
    // 같은 image_id에 다른 파일(다른 해시)이 연결되면 승인이 무효다
    const swapped: MarketingVariantRow = { ...row, image_refs: [{ image_id: "img-1", content_hash: HASH_B }] as Json }
    expect(isVariantApprovalValid(snapshot, variantRowToDraft(swapped))).toBe(false)
  })

  it("저장된 샘플 소재는 승인 규칙(품질·주문 링크)을 그대로 통과한다", async () => {
    const repo = createInMemoryMarketingRepository()
    const variant = await seed(repo)
    expect(approveVariant({ variant: variantRowToDraft(variant), approvedBy: ADMIN, approvedAt: AT }).ok).toBe(true)
  })

  it("같은 승인본을 같은 계정·목적지로 두 번 내보낼 수 없다", async () => {
    const repo = createInMemoryMarketingRepository()
    const row = await approved(repo)
    const input = { variantId: row.id, variantRevision: 1, approvalHash: row.approval_hash ?? "", channelCode: row.channel_code, destinationCode: row.destination_code, orderUrl: row.order_url, publishMode: "manual", createdBy: ADMIN } as const
    expect(await repo.createJob(input)).toMatchObject({ kind: "created", job: { status: "manual_ready", channel_account: "" } })
    expect(await repo.createJob(input)).toEqual({ kind: "duplicate" })
    // 다른 계정으로는 별도 작업이다
    expect((await repo.createJob({ ...input, channelAccount: "paldo-blog-2" })).kind).toBe("created")
  })

  it("게시 확인은 한 번만 반영되고, 게시 주소 없이는 완료되지 않는다", async () => {
    const repo = createInMemoryMarketingRepository()
    const row = await approved(repo)
    const created = await repo.createJob({ variantId: row.id, variantRevision: 1, approvalHash: row.approval_hash ?? "", channelCode: row.channel_code, destinationCode: row.destination_code, orderUrl: row.order_url, publishMode: "manual", createdBy: ADMIN })
    if (created.kind !== "created") {
      throw new Error("job expected")
    }
    await expect(repo.transitionJob(created.job.id, "manual_ready", "manual_confirmed")).rejects.toThrow("confirmed_check")
    expect((await repo.findJob(created.job.id))?.status).toBe("manual_ready")

    const decision = confirmManualPost({
      snapshot: { revision: 1, approvalHash: row.approval_hash ?? "", approvedBy: ADMIN, approvedAt: AT },
      current: variantRowToDraft(row),
      postedUrl: "https://blog.naver.com/paldo/223000000000",
      confirmedBy: ADMIN,
      confirmedAt: AT,
    })
    if (!decision.ok) {
      throw new Error("confirmation expected")
    }
    const patch = { postedUrl: decision.confirmation.postedUrl, confirmedBy: ADMIN, confirmedAt: AT }
    expect(await repo.transitionJob(created.job.id, "manual_ready", "manual_confirmed", patch)).toMatchObject({ kind: "updated", row: { status: "manual_confirmed", posted_url: patch.postedUrl } })
    // 같은 버튼을 다시 눌러도 두 번 반영되지 않는다
    expect(await repo.transitionJob(created.job.id, "manual_ready", "manual_confirmed", patch)).toEqual({ kind: "stale" })
  })

  it("사람 게시 작업은 API 상태로 갈 수 없다", async () => {
    const repo = createInMemoryMarketingRepository()
    const row = await approved(repo)
    const created = await repo.createJob({ variantId: row.id, variantRevision: 1, approvalHash: HASH_A, channelCode: row.channel_code, destinationCode: row.destination_code, orderUrl: row.order_url, publishMode: "manual", createdBy: ADMIN })
    if (created.kind !== "created") {
      throw new Error("job expected")
    }
    await expect(repo.transitionJob(created.job.id, "manual_ready", "published")).rejects.toThrow("mode_status_check")
  })

  it("소재 수정 시 게시 전 작업만 폐기되고 게시된 기록은 남는다", async () => {
    const repo = createInMemoryMarketingRepository()
    const row = await approved(repo)
    const base = { variantId: row.id, variantRevision: 1, approvalHash: HASH_A, channelCode: row.channel_code, destinationCode: row.destination_code, orderUrl: row.order_url, publishMode: "manual", createdBy: ADMIN } as const
    const posted = await repo.createJob(base)
    const waiting = await repo.createJob({ ...base, channelAccount: "second" })
    if (posted.kind !== "created" || waiting.kind !== "created") {
      throw new Error("jobs expected")
    }
    await repo.transitionJob(posted.job.id, "manual_ready", "manual_confirmed", { postedUrl: "https://blog.naver.com/x/1", confirmedBy: ADMIN, confirmedAt: AT })

    expect(await repo.cancelOpenJobs(row.id)).toBe(1)
    expect((await repo.findJob(posted.job.id))?.status).toBe("manual_confirmed")
    expect((await repo.findJob(waiting.job.id))?.status).toBe("cancelled")
    expect(await repo.cancelOpenJobs(row.id)).toBe(0)
  })

  it("감사 기록은 소재별로 쌓인다", async () => {
    const repo = createInMemoryMarketingRepository()
    const variant = await seed(repo)
    await repo.appendEvent({ variantId: variant.id, eventType: "created", actor: ADMIN, variantRevision: 1 })
    await repo.appendEvent({ variantId: variant.id, eventType: "review_requested", fromStatus: "draft", toStatus: "needs_review", actor: ADMIN, variantRevision: 1 })
    expect((await repo.listEvents(variant.id)).map((event) => event.event_type)).toEqual(["created", "review_requested"])
    expect(await repo.listEvents("other")).toEqual([])
  })

  it("같은 보고서를 다시 가져와도 성과 행이 늘지 않고, 미수집 지표는 null로 남는다", async () => {
    const repo = createInMemoryMarketingRepository()
    const variant = await seed(repo)
    const observation = { date: "2026-11-09", source: "smartstore_report", channelCode: "naver_blog", campaignId: variant.campaign_id, variantId: variant.id, destinationCode: "smartstore", visits: 12, orders: 1, revenueKrw: 89000 } as const
    expect(await repo.upsertMetrics([observation])).toBe(1)
    expect(await repo.upsertMetrics([{ ...observation, orders: 2, revenueKrw: 178000 }])).toBe(1)

    const rows = await repo.listMetrics({ from: "2026-11-01", to: "2026-11-30" })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ orders: 2, revenue_krw: 178000, visits: 12, clicks: null, ad_cost_krw: null })
  })

  it("출처·목적지·집계 단위가 다르면 따로 쌓인다", async () => {
    const repo = createInMemoryMarketingRepository()
    const day = "2026-11-09"
    await repo.upsertMetrics([
      { date: day, source: "smartstore_report", destinationCode: "smartstore", orders: 3 },
      { date: day, source: "imweb_report", destinationCode: "imweb", orders: 1 },
      { date: day, source: "naver_ads_report", channelCode: "naver_search_ad", adCostKrw: 15000, clicks: 40 },
      // 한 번의 호출에 같은 관측이 두 번 오면 마지막 값만 남는다
      { date: day, source: "manual", channelCode: "naver_blog", workMinutes: 30 },
      { date: day, source: "manual", channelCode: "naver_blog", workMinutes: 45 },
    ])
    const rows = await repo.listMetrics({ from: day, to: day })
    expect(rows).toHaveLength(4)
    expect(rows.find((row) => row.source === "manual")?.work_minutes).toBe(45)
    expect(metricDimensionKey({ date: day, source: "manual", channelCode: "naver_blog" })).toBe("naver_blog|||")
    expect(await repo.listMetrics({ from: "2026-12-01", to: "2026-12-31" })).toEqual([])
  })
})

describe("작업 상태 전이와 화면용 합성 상태", () => {
  it("작업은 정해진 길로만 간다", () => {
    expect(canTransitionJob("manual_ready", "manual_confirmed")).toBe(true)
    expect(canTransitionJob("manual_ready", "cancelled")).toBe(true)
    expect(canTransitionJob("queued", "cancelled")).toBe(true)
    // 외부에 접수된 뒤에는 취소할 수 없고 결과로만 정리한다
    expect(canTransitionJob("publishing", "cancelled")).toBe(false)
    expect(canTransitionJob("unknown", "cancelled")).toBe(false)
    expect(canTransitionJob("unknown", "publishing")).toBe(false)
    expect(canTransitionJob("unknown", "published")).toBe(true)
    expect(canTransitionJob("failed", "queued")).toBe(false)
    expect(canTransitionJob("manual_confirmed", "cancelled")).toBe(false)
    expect(canTransitionJob("cancelled", "manual_ready")).toBe(false)
  })

  it("현재 revision의 살아 있는 작업이 있으면 그 상태, 없으면 검수 상태를 보여준다", () => {
    expect(combinedDistributionStatus({ reviewStatus: "approved", revision: 1, jobs: [] })).toBe("approved")
    expect(combinedDistributionStatus({ reviewStatus: "approved", revision: 1, jobs: [{ status: "manual_ready", variantRevision: 1 }] })).toBe("manual_ready")
    expect(combinedDistributionStatus({ reviewStatus: "approved", revision: 1, jobs: [{ status: "cancelled", variantRevision: 1 }] })).toBe("approved")
    // 이전 revision에서 게시된 기록은 수정 중인 현재 상태에 섞이지 않는다
    expect(combinedDistributionStatus({ reviewStatus: "draft", revision: 2, jobs: [{ status: "manual_confirmed", variantRevision: 1 }] })).toBe("draft")
  })
})
