import "server-only"

// Batch 게시 오케스트레이션 — 클라이언트가 순차 호출하는 단건 처리 구조 (생성 배치와 동일 패턴).
// 승인 1회 시점에 item별 스냅샷(generation id·seo_page id·content hash)을 고정하고,
// 실제 게시 직전 해시를 재계산해 다르면 해당 item만 publish_failed로 남기고 다음으로 진행한다.
// 게시 코어는 PR #25의 runPlacePublish(RPC → revalidate → after() 비동기 공개 검증)를 그대로 재사용한다.
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { BatchRunItemRow, BatchRunRow, PlaceRow, SeoPageRow } from "@/types/database"
import { summarizeBatchTotals, totalsToJson } from "./batch-view"
import { computePlaceContentHash, isApprovalStillValid, type ApprovalSnapshot } from "./content-hash"
import { decidePublishCandidate, planPublishBatchStart, type PublishCandidateDecision } from "./publish-candidate-policy"
import { createSupabaseBatchRepository } from "./supabase-batch-repository"
import { BATCH_MAX_ITEMS, type BatchPublishRunSettings } from "./types"

export type PublishCandidateView = {
  readonly placeId: string
  readonly seoPageId: string
  readonly name: string
  readonly region: string
  readonly path: string
  readonly decision: PublishCandidateDecision
}

// 선택 화면용: ready 상태 seo_page + draft 장소 후보와 판정 결과.
export async function listBatchPublishCandidates(): Promise<readonly PublishCandidateView[]> {
  const client = createSupabaseServiceRoleClient()
  const { data: seoPages, error } = await client.from("seo_pages").select("*").eq("status", "ready").order("updated_at", { ascending: false }).limit(50)
  if (error !== null) {
    throw new Error(`Failed to list publish candidate pages: ${error.message}`)
  }
  const views: PublishCandidateView[] = []
  for (const seoPage of seoPages) {
    if (seoPage.place_id === null) {
      continue
    }
    const { data: place } = await client.from("places").select("*").eq("id", seoPage.place_id).maybeSingle()
    if (place === null) {
      continue
    }
    const latestGenerationId = await findLatestGenerationId(place.id)
    views.push({
      placeId: place.id,
      seoPageId: seoPage.id,
      name: place.name,
      region: [place.region, place.district].filter((v) => v !== null).join(" "),
      path: seoPage.path,
      decision: decidePublishCandidate({ place, seoPage, latestGenerationId }),
    })
  }
  return views
}

async function findLatestGenerationId(placeId: string): Promise<string | null> {
  const client = createSupabaseServiceRoleClient()
  const { data, error } = await client
    .from("ai_generations")
    .select("id")
    .eq("place_id", placeId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error !== null) {
    throw new Error(`Failed to find latest generation: ${error.message}`)
  }
  return data?.id ?? null
}

export type StartPublishBatchResult =
  | { readonly kind: "started"; readonly batchId: string }
  | { readonly kind: "already-running" }
  | { readonly kind: "invalid"; readonly reason: string }

export async function startPublishBatch(input: Readonly<{ placeIds: readonly string[]; createdBy: string | null; publishApproved: boolean }>): Promise<StartPublishBatchResult> {
  const client = createSupabaseServiceRoleClient()
  const unique = [...new Set(input.placeIds)]
  const { data: places, error } = await client.from("places").select("*").in("id", unique)
  if (error !== null) {
    throw new Error(`Failed to load publish batch places: ${error.message}`)
  }

  // 판정 컨텍스트: place별 ready seo_page + 최신 generation
  const contexts = new Map<string, { readonly place: PlaceRow; readonly seoPage: SeoPageRow; readonly generationId: string | null }>()
  const decisions = new Map<string, PublishCandidateDecision>()
  for (const place of places) {
    const { data: seoPage } = await client.from("seo_pages").select("*").eq("place_id", place.id).maybeSingle()
    const generationId = await findLatestGenerationId(place.id)
    if (seoPage !== null) {
      contexts.set(place.id, { place, seoPage, generationId })
      decisions.set(place.id, decidePublishCandidate({ place, seoPage, latestGenerationId: generationId }))
    } else {
      decisions.set(place.id, { eligible: false, reason: "seo-not-ready" })
    }
  }

  const plan = planPublishBatchStart({ placeIds: input.placeIds, decisions, publishApproved: input.publishApproved, maxItems: BATCH_MAX_ITEMS })
  if (plan.kind === "invalid") {
    return { kind: "invalid", reason: plan.reason }
  }

  const approvedAt = new Date().toISOString()
  const settings: BatchPublishRunSettings = {
    max_items: plan.placeIds.length,
    publish_approved: true,
    approved_by: input.createdBy,
    approved_at: approvedAt,
  }

  const repository = createSupabaseBatchRepository()
  const created = await repository.createRun({
    kind: "publish",
    createdBy: input.createdBy,
    settings,
    items: plan.placeIds.map((placeId, index) => {
      const context = contexts.get(placeId)
      if (context === undefined) {
        throw new Error(`Publish batch context missing for place ${placeId}`)
      }
      const snapshot: ApprovalSnapshot = {
        generation_id: context.generationId ?? "",
        seo_page_id: context.seoPage.id,
        content_hash: computePlaceContentHash(context.place),
        approved_by: input.createdBy ?? "",
        approved_at: approvedAt,
      }
      return {
        placeId,
        sequence: index + 1,
        // 게시 배치 item은 ready에서 시작한다 — 상태 머신의 게시 claim 전이(ready→processing) 대상.
        initialStatus: "ready" as const,
        inputSnapshot: {
          name: context.place.name,
          slug: context.place.slug,
          path: context.seoPage.path,
        },
        approvalSnapshot: snapshot,
      }
    }),
  })
  if (created.kind === "already-running") {
    return { kind: "already-running" }
  }
  return { kind: "started", batchId: created.run.id }
}

export type ProcessNextPublishResult = {
  readonly runStatus: BatchRunRow["status"]
  readonly done: boolean
  readonly processed: { readonly placeId: string; readonly status: BatchRunItemRow["status"]; readonly reason: string | null } | null
}

export type PublishBatchDependencies = {
  // next/server의 after — 공개 검증 콜백 등록 (서버 액션 계층에서 주입)
  readonly registerAfter: (callback: () => Promise<void>) => void
}

// 다음 ready/interrupted item 1건 게시. 없으면 run을 completed로 닫는다.
// 실패 정책: 해당 item만 publish_failed로 기록하고 다음 호출에서 다음 item을 처리한다 (자동 재게시 없음).
export async function processNextPublishItem(
  batchId: string,
  dependencies: PublishBatchDependencies,
  options?: Readonly<{ trigger?: "auto" | "resume"; actor?: string | null }>,
): Promise<ProcessNextPublishResult> {
  const repository = createSupabaseBatchRepository()
  const run = await repository.getRun(batchId)
  if (run?.kind !== "publish") {
    return { runStatus: "failed", done: true, processed: null }
  }
  if (run.status !== "running") {
    return { runStatus: run.status, done: true, processed: null }
  }

  const item = await repository.claimNextItem(batchId, "publish", "publishing", { trigger: options?.trigger ?? "auto", actor: options?.actor ?? null })
  if (item === null) {
    const items = await repository.listItems(batchId)
    await repository.finishRun(batchId, "completed", totalsToJson(summarizeBatchTotals(items)))
    const finished = await repository.getRun(batchId)
    return { runStatus: finished?.status ?? "completed", done: true, processed: null }
  }

  const outcome = await publishClaimedItem(repository, item, dependencies)
  return { runStatus: "running", done: false, processed: { placeId: item.place_id, status: outcome.status, reason: outcome.reason } }
}

async function publishClaimedItem(
  repository: ReturnType<typeof createSupabaseBatchRepository>,
  item: BatchRunItemRow,
  dependencies: PublishBatchDependencies,
): Promise<{ status: BatchRunItemRow["status"]; reason: string | null }> {
  try {
    // 1) 승인 스냅샷 검증 — 승인 이후 콘텐츠·generation이 바뀌었으면 게시하지 않는다 (해당 item만 중단).
    const snapshot = item.approval_snapshot as unknown as ApprovalSnapshot | null
    if (snapshot === null || typeof snapshot !== "object" || typeof snapshot.content_hash !== "string") {
      await repository.recordItemResult(item.id, { status: "publish_failed", currentStep: null, lastErrorCode: "approval-missing", lastErrorMessage: "승인 스냅샷이 없어 게시할 수 없습니다.", finished: true })
      return { status: "publish_failed", reason: "approval-missing" }
    }
    const client = createSupabaseServiceRoleClient()
    const { data: place } = await client.from("places").select("*").eq("id", item.place_id).maybeSingle()
    if (place === null) {
      await repository.recordItemResult(item.id, { status: "publish_failed", currentStep: null, lastErrorCode: "place-missing", lastErrorMessage: "장소를 찾을 수 없습니다.", finished: true })
      return { status: "publish_failed", reason: "place-missing" }
    }
    // 재개 멱등성: 이전 시도에서 게시 RPC까지 성공했지만 기록 전에 끊긴 경우 —
    // 장소가 이미 published면 runPlacePublish가 already-published를 반환해 중복 게시 없이 복구된다.
    const currentGenerationId = await findLatestGenerationId(item.place_id)
    if (place.status !== "published" && !isApprovalStillValid(snapshot, computePlaceContentHash(place), currentGenerationId)) {
      await repository.recordItemResult(item.id, { status: "publish_failed", currentStep: null, lastErrorCode: "content-changed", lastErrorMessage: "승인 이후 콘텐츠 또는 generation이 변경되어 게시를 중단했습니다. 다시 검토·승인하세요.", finished: true })
      return { status: "publish_failed", reason: "content-changed" }
    }

    // 2) 게시 코어 실행 — RPC → revalidate → after() 비동기 공개 검증 예약 (PR #25 흐름 그대로)
    const { runPlacePublish } = await import("@/lib/seo-pages/publish-runner")
    const result = await runPlacePublish(item.place_id, { registerAfter: dependencies.registerAfter })
    if (result.kind === "published" || result.kind === "already-published") {
      await repository.recordItemResult(item.id, {
        status: "published",
        currentStep: null,
        publishResult: result.revalidated ? result.kind : `${result.kind}:cache-refresh-failed`,
        // 공개 검증은 after()에서 seo_pages.verification_*로 기록된다 — item에는 예약 시점 상태(pending)를 남긴다.
        verificationStatus: result.revalidated ? "pending" : null,
        finished: true,
      })
      return { status: "published", reason: result.kind === "already-published" ? "already-published" : null }
    }

    if (result.kind === "vocabulary-blocked") {
      await repository.recordItemResult(item.id, {
        status: "publish_failed",
        currentStep: null,
        publishResult: result.kind,
        lastErrorCode: "forbidden-mode-vocabulary",
        lastErrorMessage: `업종에 맞지 않는 표현이 남아 있어 게시하지 않음 (${result.findings.map((finding) => `${finding.field}: '${finding.term}'`).join(", ")})`,
        finished: true,
      })
      return { status: "publish_failed", reason: "forbidden-mode-vocabulary" }
    }

    const reason = result.kind === "unexpected" ? "publish-unexpected" : "publish-blocked"
    await repository.recordItemResult(item.id, { status: "publish_failed", currentStep: null, publishResult: result.kind, lastErrorCode: reason, lastErrorMessage: "게시 RPC가 게시를 승인하지 않았습니다.", finished: true })
    return { status: "publish_failed", reason }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await repository.recordItemResult(item.id, { status: "publish_failed", currentStep: null, lastErrorCode: "unexpected", lastErrorMessage: message.slice(0, 500), finished: true })
    return { status: "publish_failed", reason: "unexpected" }
  }
}

export async function cancelPublishBatch(batchId: string, actor?: string | null): Promise<void> {
  const repository = createSupabaseBatchRepository()
  await repository.recordEvent({ batchId, eventType: "run_cancel_requested", actor: actor ?? null, detail: { cancelled_by_user: true } })
  await repository.skipRemainingItems(batchId, "publish", "cancelled-by-user")
  const items = await repository.listItems(batchId)
  await repository.finishRun(batchId, "cancelled", totalsToJson(summarizeBatchTotals(items)))
}

// 결과 화면용: 게시 배치 item별 실시간 공개 검증 상태 (seo_pages.verification_*).
export type PublishItemVerification = {
  readonly placeId: string
  readonly seoStatus: SeoPageRow["status"] | null
  readonly verificationStatus: SeoPageRow["verification_status"] | null
  readonly lastHttpStatus: number | null
}

export async function listPublishItemVerifications(placeIds: readonly string[]): Promise<ReadonlyMap<string, PublishItemVerification>> {
  if (placeIds.length === 0) {
    return new Map()
  }
  const client = createSupabaseServiceRoleClient()
  const { data, error } = await client.from("seo_pages").select("place_id, status, verification_status, last_http_status").in("place_id", [...placeIds])
  if (error !== null) {
    throw new Error(`Failed to read publish verifications: ${error.message}`)
  }
  const map = new Map<string, PublishItemVerification>()
  for (const row of data) {
    if (row.place_id !== null) {
      map.set(row.place_id, { placeId: row.place_id, seoStatus: row.status, verificationStatus: row.verification_status, lastHttpStatus: row.last_http_status })
    }
  }
  return map
}
