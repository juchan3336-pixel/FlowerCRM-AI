import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { approveVariant, computeVariantApprovalHash, confirmManualPost, isVariantApprovalValid } from "@/lib/marketing/approval"
import { listMarketingChannels } from "@/lib/marketing/channel-policy"
import { canTransitionJob, combinedDistributionStatus, listJobTransitions } from "@/lib/marketing/distribution-state"
import { createInMemoryMarketingRepository } from "@/lib/marketing/in-memory-repository"
import { listOrderDestinations } from "@/lib/marketing/order-destination"
import { metricDimensionKey, variantPayload, variantRowToDraft, type MarketingRepository, type VariantContent } from "@/lib/marketing/repository"
import { buildTrackedOrderUrl } from "@/lib/marketing/tracking-url"
import type { MarketingImageRow, MarketingVariantRow } from "@/types/database"

const MIGRATION = readFileSync(join(process.cwd(), "supabase/migrations/202611100001_marketing_distribution.sql"), "utf8")
const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)
const ADMIN = "admin@example.com"
const AT = "2026-11-10T09:00:00+09:00"
const SMARTSTORE_HOME = "https://smartstore.naver.com/free77888"

type Seeded = { readonly repo: MarketingRepository; readonly variant: MarketingVariantRow; readonly image: MarketingImageRow; readonly content: (overrides?: Partial<VariantContent>) => VariantContent }

async function registerImage(repo: MarketingRepository, path: string, hash: string): Promise<MarketingImageRow> {
  const result = await repo.registerImage({ storagePath: path, contentHash: hash, kind: "photo", isRealPhoto: true, rightsStatus: "owned", createdBy: ADMIN })
  if (result.kind !== "created") {
    throw new Error("image expected")
  }
  return result.image
}

async function seed(): Promise<Seeded> {
  const repo = createInMemoryMarketingRepository()
  const image = await registerImage(repo, "marketing/condolence/a.webp", HASH_A)
  const tracked = buildTrackedOrderUrl({ channel: "naver_blog", destination: "smartstore", baseUrl: SMARTSTORE_HOME, campaignCode: "condolence-guide-01", variantCode: "v1" })
  const content = (overrides: Partial<VariantContent> = {}): VariantContent => ({
    destinationCode: "smartstore",
    orderUrl: tracked.url,
    trackingKind: tracked.trackingKind,
    trackingParams: tracked.params,
    linkVersion: 1,
    title: "근조화환 주문 전에 확인할 세 가지",
    body: "장례식장으로 근조화환을 보내실 때는 빈소 호실과 상주 성함, 리본 문구를 먼저 확인해 두시면 주문이 수월합니다.",
    caption: null,
    imageTexts: ["근조화환 주문 준비"],
    imageRefs: [{ image_id: image.id, content_hash: image.content_hash }],
    ...overrides,
  })
  const campaign = await repo.createCampaign({ code: "condolence-guide-01", name: "근조 주문 준비 안내", mode: "condolence", createdBy: ADMIN })
  if (campaign.kind !== "created") {
    throw new Error("campaign expected")
  }
  const variant = await repo.createVariant({ ...content(), campaignId: campaign.campaign.id, code: "v1", channelCode: "naver_blog", mode: "condolence", createdBy: ADMIN })
  if (variant.kind !== "created") {
    throw new Error("variant expected")
  }
  return { repo, variant: variant.variant, image, content }
}

// 검수 통과 → 승인까지 진행한다. revision은 현재 소재의 것을 쓴다.
async function approve(repo: MarketingRepository, variant: MarketingVariantRow): Promise<MarketingVariantRow> {
  await repo.recordReview(variant.id, variant.revision, { status: "pass", issues: [] }, true)
  const result = await repo.approveVariant(variant.id, variant.revision, { approvalHash: computeVariantApprovalHash(variantRowToDraft(variant)), approvedBy: ADMIN, approvedAt: AT })
  if (result.kind !== "updated") {
    throw new Error("approval expected")
  }
  return result.row
}

async function manualJob(repo: MarketingRepository, variant: MarketingVariantRow, channelAccount?: string) {
  const created = await repo.createJob({ variantId: variant.id, expectedRevision: variant.revision, createdBy: ADMIN, ...(channelAccount === undefined ? {} : { channelAccount }) })
  if (created.kind !== "created") {
    throw new Error(`job expected, got ${created.kind}`)
  }
  return created.job
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
  })

  it("DB 트리거의 작업 전이 목록이 코드의 전이표와 같다", () => {
    const guard = MIGRATION.split("create or replace function public.marketing_distribution_jobs_guard()")[1]?.split("$$;")[0] ?? ""
    const inSql = [...guard.matchAll(/'([a-z_]+>[a-z_]+)'/g)].map((match) => match[1])
    expect([...inSql].sort()).toEqual([...listJobTransitions()].sort())
  })

  it("함수 본문 구분자($$)가 짝이 맞는다", () => {
    // 치환 도구가 "$$"를 "$"로 줄여 SQL이 깨진 적이 있다 — 함수 6개 × 여닫기 2개.
    expect(MIGRATION.match(/\$\$/g)).toHaveLength(12)
    expect(MIGRATION).not.toMatch(/^as \$$/m)
    expect(MIGRATION).not.toMatch(/^\$;$/m)
  })

  it("승인 CHECK는 null revision을 통과시키지 않도록 not null을 명시한다", () => {
    const check = MIGRATION.split("constraint marketing_variants_approval_check check (")[1]?.split("\n  )")[0] ?? ""
    for (const column of ["approved_revision", "quality_checked_revision", "quality_report", "approval_hash", "approved_by", "approved_at"]) {
      expect(check, column).toContain(`${column} is not null`)
    }
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
    expect((await repo.listDestinations()).map((row) => row.base_url)).toEqual(["https://팔도플라워.com", SMARTSTORE_HOME])
  })

  it("DB 제약과 같은 입력을 같은 이유로 거부한다", async () => {
    const { repo, variant, content } = await seed()
    expect(await repo.createCampaign({ code: "a.b", name: "마침표", mode: "condolence", createdBy: ADMIN })).toEqual({ kind: "invalid", reason: "code-format" })
    expect(await repo.createCampaign({ code: "c2", name: "기간", mode: "condolence", startsOn: "2026-11-11", endsOn: "2026-11-10", createdBy: ADMIN })).toEqual({ kind: "invalid", reason: "period" })
    expect(await repo.createCampaign({ code: "c3", name: "예산", mode: "condolence", budgetCapKrw: -1, createdBy: ADMIN })).toEqual({ kind: "invalid", reason: "budget" })
    expect(await repo.createCampaign({ code: "c4", name: "상품", mode: "condolence", productUrls: { smartstore: "https://smartstore.naver.com/other/products/1" }, createdBy: ADMIN })).toEqual({ kind: "invalid", reason: "order-url" })

    const base = { ...content(), campaignId: variant.campaign_id, channelCode: "naver_blog", mode: "condolence", createdBy: ADMIN } as const
    expect(await repo.createVariant({ ...base, code: "한글" })).toEqual({ kind: "invalid", reason: "code-format" })
    expect(await repo.createVariant({ ...base, code: "v9", campaignId: "00000000-0000-4000-8000-000000000000" })).toEqual({ kind: "invalid", reason: "reference-not-found" })
    expect(await repo.createVariant({ ...base, code: "v9", orderUrl: "https://example.com/shop" })).toEqual({ kind: "invalid", reason: "order-url" })
    expect(await repo.registerImage({ storagePath: "x.webp", contentHash: "not-a-hash", kind: "photo", isRealPhoto: false, rightsStatus: "unverified", createdBy: ADMIN })).toEqual({ kind: "invalid", reason: "content-hash" })
  })

  it("캠페인 코드와 캠페인 내 소재 코드는 유일하다", async () => {
    const { repo, variant, content } = await seed()
    expect(await repo.createCampaign({ code: "condolence-guide-01", name: "중복", mode: "condolence", createdBy: ADMIN })).toEqual({ kind: "code-taken" })
    const base = { ...content(), campaignId: variant.campaign_id, channelCode: "naver_place", mode: "condolence", createdBy: ADMIN } as const
    expect(await repo.createVariant({ ...base, code: "v1" })).toEqual({ kind: "code-taken" })
    expect((await repo.createVariant({ ...base, code: "v2" })).kind).toBe("created")
  })

  it("같은 경로나 같은 내용의 이미지는 다시 올릴 수 없다", async () => {
    const { repo } = await seed()
    const input = { kind: "photo", isRealPhoto: true, rightsStatus: "owned", createdBy: ADMIN } as const
    expect(await repo.registerImage({ ...input, storagePath: "marketing/condolence/a.webp", contentHash: HASH_B })).toEqual({ kind: "duplicate" })
    expect(await repo.registerImage({ ...input, storagePath: "marketing/other.webp", contentHash: HASH_A })).toEqual({ kind: "duplicate" })
  })

  it("등록되지 않은 이미지나 해시가 다른 이미지는 소재에 넣을 수 없다", async () => {
    const { repo, variant, image, content } = await seed()
    const unknown = content({ imageRefs: [{ image_id: "00000000-0000-4000-8000-000000000000", content_hash: HASH_A }] })
    const wrongHash = content({ imageRefs: [{ image_id: image.id, content_hash: HASH_B }] })
    expect(await repo.reviseVariant(variant.id, 1, unknown)).toEqual({ kind: "invalid", reason: "image-ref" })
    expect(await repo.reviseVariant(variant.id, 1, wrongHash)).toEqual({ kind: "invalid", reason: "image-ref" })
    expect((await repo.findVariant(variant.id))?.revision).toBe(1)
  })

  it("검수 실패는 draft에 머물고, 통과해야 검수 대기로 넘어간다", async () => {
    const { repo, variant } = await seed()
    const failed = await repo.recordReview(variant.id, 1, { status: "fail", issues: [] }, false)
    expect(failed).toMatchObject({ kind: "updated", row: { review_status: "draft", quality_checked_revision: 1 } })
    // 검수 대기 상태가 아닌 소재는 승인할 수 없다
    expect(await repo.approveVariant(variant.id, 1, { approvalHash: HASH_A, approvedBy: ADMIN, approvedAt: AT })).toEqual({ kind: "stale" })

    const passed = await repo.recordReview(variant.id, 1, { status: "pass", issues: [] }, true)
    expect(passed).toMatchObject({ kind: "updated", row: { review_status: "needs_review" } })
  })

  it("승인은 현재 revision에만 붙고, 수정하면 승인·품질 결과가 지워진다", async () => {
    const { repo, variant, content } = await seed()
    const row = await approve(repo, variant)
    expect(row).toMatchObject({ review_status: "approved", approved_revision: 1, approved_by: ADMIN })

    const revised = await repo.reviseVariant(row.id, 1, content({ body: "수정한 본문입니다. 빈소 호실을 먼저 확인해 주세요." }))
    expect(revised).toMatchObject({ kind: "updated", cancelledJobs: 0, row: { revision: 2, review_status: "draft", approved_revision: null, approval_hash: null, quality_report: null, quality_checked_revision: null } })
  })

  it("옛 revision을 기준으로 한 수정·검수·승인은 반영되지 않는다", async () => {
    const { repo, variant, content } = await seed()
    await repo.reviseVariant(variant.id, 1, content({ title: "먼저 저장한 제목" }))
    expect(await repo.reviseVariant(variant.id, 1, content({ title: "늦게 온 수정" }))).toEqual({ kind: "stale" })
    expect(await repo.recordReview(variant.id, 1, {}, true)).toEqual({ kind: "stale" })
    expect(await repo.approveVariant(variant.id, 1, { approvalHash: HASH_A, approvedBy: ADMIN, approvedAt: AT })).toEqual({ kind: "stale" })
    expect((await repo.findVariant(variant.id))?.title).toBe("먼저 저장한 제목")
  })

  it("승인 해시는 이미지의 내용뿐 아니라 어느 이미지인지도 포함한다", async () => {
    const { repo, variant, image } = await seed()
    const row = await approve(repo, variant)
    const snapshot = { revision: 1, approvalHash: row.approval_hash ?? "", approvedBy: ADMIN, approvedAt: AT }
    expect(isVariantApprovalValid(snapshot, variantRowToDraft(row))).toBe(true)
    // 같은 이미지 id에 다른 내용 해시
    expect(isVariantApprovalValid(snapshot, variantRowToDraft({ ...row, image_refs: [{ image_id: image.id, content_hash: HASH_B }] }))).toBe(false)
    // 같은 내용 해시인데 다른 이미지 id
    expect(isVariantApprovalValid(snapshot, variantRowToDraft({ ...row, image_refs: [{ image_id: "other-image", content_hash: image.content_hash }] }))).toBe(false)
  })

  it("저장된 샘플 소재는 승인 규칙(품질·주문 링크)을 그대로 통과한다", async () => {
    const { variant } = await seed()
    expect(approveVariant({ variant: variantRowToDraft(variant), approvedBy: ADMIN, approvedAt: AT }).ok).toBe(true)
  })

  it("작업은 현재 승인본에서만 만들어지고, 승인본의 내용을 그대로 복사한다", async () => {
    const { repo, variant } = await seed()
    // 승인 전
    expect(await repo.createJob({ variantId: variant.id, expectedRevision: 1, createdBy: ADMIN })).toEqual({ kind: "not-approved" })
    expect(await repo.createJob({ variantId: "missing", expectedRevision: 1, createdBy: ADMIN })).toEqual({ kind: "not-approved" })

    const row = await approve(repo, variant)
    // 호출자가 다른 revision을 보고 있었다
    expect(await repo.createJob({ variantId: row.id, expectedRevision: 99, createdBy: ADMIN })).toEqual({ kind: "not-approved" })

    const job = await manualJob(repo, row)
    expect(job).toMatchObject({
      status: "manual_ready",
      publish_mode: "manual",
      variant_revision: 1,
      approval_hash: row.approval_hash,
      channel_code: "naver_blog",
      destination_code: "smartstore",
      order_url: row.order_url,
      channel_account: "",
    })
    expect(job.payload).toEqual(variantPayload(row))
  })

  it("같은 승인본을 같은 계정·목적지로 두 번 내보낼 수 없다", async () => {
    const { repo, variant } = await seed()
    const row = await approve(repo, variant)
    await manualJob(repo, row)
    expect(await repo.createJob({ variantId: row.id, expectedRevision: 1, createdBy: ADMIN })).toEqual({ kind: "duplicate" })
    // 다른 계정으로는 별도 작업이다
    expect((await manualJob(repo, row, "paldo-blog-2")).channel_account).toBe("paldo-blog-2")
  })

  it("계정을 지정하지 않으면 그 시점의 채널 계정이 작업에 고정된다", async () => {
    const { repo, variant } = await seed()
    const row = await approve(repo, variant)
    await repo.updateChannel("naver_blog", { accountRef: "blog-a" })
    expect((await manualJob(repo, row)).channel_account).toBe("blog-a")
    expect(await repo.createJob({ variantId: row.id, expectedRevision: 1, createdBy: ADMIN })).toEqual({ kind: "duplicate" })
    // 같은 계정을 명시해도 같은 작업이다
    expect(await repo.createJob({ variantId: row.id, expectedRevision: 1, channelAccount: "blog-a", createdBy: ADMIN })).toEqual({ kind: "duplicate" })

    // 채널 계정을 바꾸면 새 계정으로는 별도 작업이고, 먼저 만든 작업의 계정은 그대로 남는다
    await repo.updateChannel("naver_blog", { accountRef: "blog-b" })
    expect((await manualJob(repo, row)).channel_account).toBe("blog-b")
    expect((await repo.listJobs(row.id)).map((job) => job.channel_account).sort()).toEqual(["blog-a", "blog-b"])
  })

  it("게시 계정 이름은 다듬지 않고 형식으로만 받는다 — 공백·탭·개행이 든 값은 거부", async () => {
    const { repo, variant } = await seed()
    const row = await approve(repo, variant)
    for (const bad of ["\t", " ", "blog-a ", " blog-a", "blog\na", "blog a"]) {
      expect(await repo.updateChannel("naver_blog", { accountRef: bad }), JSON.stringify(bad)).toEqual({ kind: "invalid", reason: "account-format" })
      expect(await repo.createJob({ variantId: row.id, expectedRevision: 1, channelAccount: bad, createdBy: ADMIN }), JSON.stringify(bad)).toEqual({ kind: "invalid-account" })
    }
    expect((await repo.updateChannel("kakao_channel", { accountRef: "@팔도플라워" })).kind).toBe("updated")
    expect(await repo.listJobs(row.id)).toEqual([])
    // DB의 CHECK·함수가 같은 정규식을 쓴다
    expect(MIGRATION.match(/\^\[0-9A-Za-z가-힣\._@-\]\{1,100\}\$/g)).toHaveLength(3)
    expect(MIGRATION).not.toMatch(/trim\(p_channel_account\)|trim\(v_account_ref\)/)
  })

  it("이미지 크기는 없거나 양의 정수여야 한다", async () => {
    const repo = createInMemoryMarketingRepository()
    const input = { storagePath: "size.webp", contentHash: HASH_A, kind: "photo", isRealPhoto: false, rightsStatus: "unverified", createdBy: ADMIN } as const
    expect(await repo.registerImage({ ...input, width: 0 })).toEqual({ kind: "invalid", reason: "image-size" })
    expect(await repo.registerImage({ ...input, height: 0 })).toEqual({ kind: "invalid", reason: "image-size" })
    expect(await repo.registerImage({ ...input, width: 1080.5, height: 1080 })).toEqual({ kind: "invalid", reason: "image-size" })
    expect(await repo.registerImage({ ...input, width: -1 })).toEqual({ kind: "invalid", reason: "image-size" })
    expect((await repo.registerImage({ ...input, width: 1080, height: 1080 })).kind).toBe("created")
  })

  it("채널이 중지되어 있으면 작업이 만들어지지 않고, 게시 방식은 DB의 채널 설정을 따른다", async () => {
    const { repo, variant } = await seed()
    const row = await approve(repo, variant)
    await repo.updateChannel("naver_blog", { publishMode: "disabled" })
    expect(await repo.createJob({ variantId: row.id, expectedRevision: 1, createdBy: ADMIN })).toEqual({ kind: "channel-disabled" })

    await repo.updateChannel("naver_blog", { publishMode: "api", accountRef: "paldo-blog" })
    const created = await repo.createJob({ variantId: row.id, expectedRevision: 1, createdBy: ADMIN })
    expect(created).toMatchObject({ kind: "created", job: { publish_mode: "api", status: "queued" } })
    expect((await repo.listChannels()).find((channel) => channel.code === "naver_blog")).toMatchObject({ publish_mode: "api", account_ref: "paldo-blog" })
  })

  it("수정 후에는 이전 승인으로 작업을 만들 수 없다", async () => {
    const { repo, variant, content } = await seed()
    const row = await approve(repo, variant)
    await repo.reviseVariant(row.id, 1, content({ title: "수정된 제목" }))
    expect(await repo.createJob({ variantId: row.id, expectedRevision: 1, createdBy: ADMIN })).toEqual({ kind: "not-approved" })
    expect(await repo.createJob({ variantId: row.id, expectedRevision: 2, createdBy: ADMIN })).toEqual({ kind: "not-approved" })
  })

  it("게시 확인은 한 번만 반영되고, 게시 주소 없이는 완료되지 않는다", async () => {
    const { repo, variant } = await seed()
    const row = await approve(repo, variant)
    const job = await manualJob(repo, row)
    await expect(repo.transitionJob(job.id, "manual_ready", "manual_confirmed")).rejects.toThrow("confirmed_check")
    expect((await repo.findJob(job.id))?.status).toBe("manual_ready")

    const decision = confirmManualPost({
      snapshot: { revision: job.variant_revision, approvalHash: job.approval_hash, approvedBy: ADMIN, approvedAt: AT },
      current: variantRowToDraft(row),
      postedUrl: "https://blog.naver.com/paldo/223000000000",
      confirmedBy: ADMIN,
      confirmedAt: AT,
    })
    if (!decision.ok) {
      throw new Error("confirmation expected")
    }
    const patch = { postedUrl: decision.confirmation.postedUrl, confirmedBy: ADMIN, confirmedAt: AT }
    expect(await repo.transitionJob(job.id, "manual_ready", "manual_confirmed", patch)).toMatchObject({ kind: "updated", row: { status: "manual_confirmed", posted_url: patch.postedUrl } })
    // 같은 버튼을 다시 눌러도 두 번 반영되지 않는다
    expect(await repo.transitionJob(job.id, "manual_ready", "manual_confirmed", patch)).toEqual({ kind: "stale" })
  })

  it("옛 상품 주소 버전으로 만든 링크는 저장되지 않는다", async () => {
    const { repo, variant, content } = await seed()
    const updated = await repo.updateCampaignProductUrls(variant.campaign_id, { smartstore: "https://smartstore.naver.com/free77888/products/9" })
    expect(updated).toMatchObject({ kind: "updated", campaign: { product_urls_version: 2 } })
    // 버전 1을 보고 만든 수정·새 소재는 거부된다
    expect(await repo.reviseVariant(variant.id, 1, content({ title: "옛 주소를 보고 만든 수정" }))).toEqual({ kind: "campaign-changed" })
    expect(await repo.createVariant({ ...content(), campaignId: variant.campaign_id, code: "late", channelCode: "naver_place", mode: "condolence", createdBy: ADMIN })).toEqual({ kind: "campaign-changed" })
    expect((await repo.findVariant(variant.id))?.revision).toBe(1)
    // 현재 버전을 보고 만든 것은 저장된다
    expect(await repo.reviseVariant(variant.id, 1, content({ title: "새 주소를 보고 만든 수정", linkVersion: 2 }))).toMatchObject({ kind: "updated", row: { revision: 2, link_version: 2 } })
    // 주소를 저장할 때마다 버전이 오른다
    expect(await repo.updateCampaignProductUrls(variant.campaign_id, {})).toMatchObject({ kind: "updated", campaign: { product_urls_version: 3 } })
  })

  it("게시 결과를 확인 중인(외부에 접수된) 소재도 고칠 수 없다", async () => {
    const { repo, variant, content } = await seed()
    const row = await approve(repo, variant)
    await repo.updateChannel("naver_blog", { publishMode: "api" })
    const created = await repo.createJob({ variantId: row.id, expectedRevision: 1, createdBy: ADMIN })
    if (created.kind !== "created") {
      throw new Error("job expected")
    }
    // 큐에만 있을 때는 고칠 수 있지만(작업은 폐기), 접수된 뒤에는 잠긴다
    await repo.transitionJob(created.job.id, "queued", "publishing")
    expect(await repo.reviseVariant(row.id, 1, content({ title: "접수 후 수정" }))).toEqual({ kind: "locked" })
    await repo.transitionJob(created.job.id, "publishing", "unknown")
    expect(await repo.reviseVariant(row.id, 1, content({ title: "결과 불명 중 수정" }))).toEqual({ kind: "locked" })
    // 조회로 실패가 확인되면 다시 고칠 수 있다
    await repo.transitionJob(created.job.id, "unknown", "failed")
    expect((await repo.reviseVariant(row.id, 1, content({ title: "실패 확인 후 수정" }))).kind).toBe("updated")
  })

  it("게시된 작업의 내용 목록은 어느 소재의 것인지 함께 돌려준다", async () => {
    const { repo, variant } = await seed()
    const row = await approve(repo, variant)
    const job = await manualJob(repo, row)
    expect(await repo.listPostedPayloads("naver_blog", 10)).toEqual([])
    await repo.transitionJob(job.id, "manual_ready", "manual_confirmed", { postedUrl: "https://blog.naver.com/x/1", confirmedBy: ADMIN, confirmedAt: AT })
    expect(await repo.listPostedPayloads("naver_blog", 10)).toEqual([{ variantId: row.id, payload: job.payload }])
    expect(await repo.listPostedPayloads("naver_place", 10)).toEqual([])
  })

  it("금지된 작업 전이는 저장되지 않는다", async () => {
    const { repo, variant } = await seed()
    const row = await approve(repo, variant)
    await repo.updateChannel("naver_blog", { publishMode: "api" })
    const created = await repo.createJob({ variantId: row.id, expectedRevision: 1, createdBy: ADMIN })
    if (created.kind !== "created") {
      throw new Error("job expected")
    }
    const id = created.job.id
    await repo.transitionJob(id, "queued", "publishing")
    await repo.transitionJob(id, "publishing", "unknown")
    // 결과가 불명확한 작업을 다시 큐에 넣거나 재게시할 수 없다
    expect(await repo.transitionJob(id, "unknown", "queued")).toEqual({ kind: "forbidden" })
    expect(await repo.transitionJob(id, "unknown", "publishing")).toEqual({ kind: "forbidden" })
    expect((await repo.findJob(id))?.status).toBe("unknown")

    await repo.transitionJob(id, "unknown", "failed", { lastErrorCode: "not-found-after-lookup" })
    expect(await repo.transitionJob(id, "failed", "queued")).toEqual({ kind: "forbidden" })
    expect(await repo.transitionJob(id, "failed", "published")).toEqual({ kind: "forbidden" })
    // 사람 게시 경로로 넘어가는 것도 전이표에 없다
    expect(await repo.transitionJob(id, "failed", "manual_ready")).toEqual({ kind: "forbidden" })
    expect((await repo.findJob(id))?.status).toBe("failed")
  })

  it("수정하면 이전 revision의 게시 전 작업만 폐기되고, 새 revision의 작업은 남는다", async () => {
    const { repo, variant, content } = await seed()
    const rev1 = await approve(repo, variant)
    const waiting = await manualJob(repo, rev1)
    const waitingSecond = await manualJob(repo, rev1, "second")

    const revised = await repo.reviseVariant(rev1.id, 1, content({ title: "두 번째 제목" }))
    if (revised.kind !== "updated") {
      throw new Error("revision expected")
    }
    expect(revised.cancelledJobs).toBe(2)
    expect((await repo.findJob(waiting.id))?.status).toBe("cancelled")
    expect((await repo.findJob(waitingSecond.id))?.status).toBe("cancelled")
    // 폐기된(이전 revision의) 작업은 게시 확인으로 되살릴 수 없다
    expect(await repo.transitionJob(waiting.id, "manual_ready", "manual_confirmed", { postedUrl: "https://blog.naver.com/x/1", confirmedBy: ADMIN, confirmedAt: AT })).toEqual({ kind: "stale" })

    // 새 revision을 승인하고 작업을 만든 뒤, 옛 revision 기준의 수정이 늦게 도착해도 새 작업은 그대로다
    const rev2 = await approve(repo, revised.row)
    const fresh = await manualJob(repo, rev2)
    expect(await repo.reviseVariant(rev1.id, 1, content({ title: "늦게 도착한 수정" }))).toEqual({ kind: "stale" })
    expect((await repo.findJob(fresh.id))?.status).toBe("manual_ready")
  })

  it("게시된 소재는 고칠 수 없고, 게시한 문안과 이미지 구성이 작업에 그대로 남는다", async () => {
    const { repo, variant, content } = await seed()
    const rev1 = await approve(repo, variant)
    const job = await manualJob(repo, rev1)
    await repo.transitionJob(job.id, "manual_ready", "manual_confirmed", { postedUrl: "https://blog.naver.com/x/1", confirmedBy: ADMIN, confirmedAt: AT })

    const other = await registerImage(repo, "marketing/condolence/b.webp", HASH_B)
    const revised = await repo.reviseVariant(rev1.id, 1, content({ title: "바뀐 제목", body: "바뀐 본문입니다. 빈소 호실을 확인해 주세요.", imageRefs: [{ image_id: other.id, content_hash: HASH_B }] }))
    expect(revised).toEqual({ kind: "locked" })
    expect(await repo.findVariant(rev1.id)).toMatchObject({ revision: 1, review_status: "approved", title: rev1.title })

    const kept = await repo.findJob(job.id)
    expect(kept?.payload).toMatchObject({ title: rev1.title, body: rev1.body, image_refs: rev1.image_refs, image_texts: ["근조화환 주문 준비"] })
    expect(kept?.order_url).toBe(rev1.order_url)
  })

  it("감사 기록은 소재별로 쌓인다", async () => {
    const { repo, variant } = await seed()
    await repo.appendEvent({ variantId: variant.id, eventType: "created", actor: ADMIN, variantRevision: 1 })
    await repo.appendEvent({ variantId: variant.id, eventType: "review_requested", fromStatus: "draft", toStatus: "needs_review", actor: ADMIN, variantRevision: 1 })
    expect((await repo.listEvents(variant.id)).map((event) => event.event_type)).toEqual(["created", "review_requested"])
    expect(await repo.listEvents("other")).toEqual([])
  })

  it("같은 보고서를 다시 가져와도 성과 행이 늘지 않고, 미수집 지표는 null로 남는다", async () => {
    const { repo, variant } = await seed()
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
