import "server-only"

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { BatchItemStatus, BatchItemStep, BatchRunEventRow, BatchRunItemRow, BatchRunKind, BatchRunRow, Json } from "@/types/database"
import { recordBatchEventSafely, type BatchEventInsertRow, type NewBatchEvent } from "./event-log"
import { buildBatchIdempotencyKey } from "./idempotency"
import { claimableStatusesFor, isStaleProcessing } from "./state-machine"
import type { BatchPublishRunSettings, BatchRunSettings } from "./types"

// Batch 오케스트레이션 저장소 — 모든 상태 전이는 "기대 상태 일치 시에만" 갱신하는 조건부 UPDATE로 수행한다.
// 같은 액션이 중복 호출되면 조건이 어긋나 0행 갱신(no-op)이 되므로 중복 생성·중복 게시가 발생하지 않는다.

export type NewBatchItem = {
  readonly placeId: string
  readonly sequence: number
  readonly inputSnapshot: Json
  // 게시 배치 전용: 승인 시점의 generation id·seo_page id·content hash 고정 (생성 배치는 null)
  readonly approvalSnapshot?: Json
  // 시작 상태 — 생성 배치는 queued(기본), 게시 배치는 ready(게시 claim 대상: ready→processing 전이)
  readonly initialStatus?: Extract<BatchItemStatus, "queued" | "ready">
}

export type BatchItemResultPatch = {
  readonly status: BatchItemStatus
  readonly currentStep?: BatchItemStep | null
  readonly generationId?: string | null
  readonly retryGenerationId?: string | null
  readonly qualityStatus?: "pass" | "warn" | "fail" | null
  readonly qualityIssues?: Json | null
  readonly tokensInput?: number | null
  readonly tokensOutput?: number | null
  readonly costUsd?: number | null
  readonly approvalSnapshot?: Json | null
  readonly publishResult?: string | null
  readonly verificationStatus?: "pending" | "verified" | "delayed" | "failed" | null
  readonly skipReason?: string | null
  readonly lastErrorCode?: string | null
  readonly lastErrorMessage?: string | null
  readonly finished?: boolean
}

export function createSupabaseBatchRepository() {
  const client = createSupabaseServiceRoleClient()

  // fire-and-forget 이벤트 기록 — 조건부 UPDATE "성공" 직후에만 호출한다 (no-op 전이는 이벤트도 없음).
  const insertEvent = async (row: BatchEventInsertRow): Promise<{ errorCode: string | null }> => {
    const { error } = await client.from("batch_run_events").insert(row)
    return { errorCode: error?.code ?? null }
  }
  const recordEvent = (event: NewBatchEvent): Promise<void> => recordBatchEventSafely(insertEvent, event)

  return {
    // 외부 지점(취소 액션·공개 검증 갱신)에서의 기록용 — 동일 fire-and-forget 계약.
    recordEvent,

    async listEvents(batchId: string, limit = 100): Promise<readonly BatchRunEventRow[]> {
      const { data, error } = await client.from("batch_run_events").select("*").eq("batch_id", batchId).order("created_at", { ascending: false }).limit(limit)
      if (error !== null) {
        // 이벤트 테이블 미적용(migration 전) 배포에서도 상세 화면이 깨지지 않도록 빈 목록으로 강등한다.
        console.error("[batch-events] list failed", { batchId, message: error.message })
        return []
      }
      return data
    },
    // 락: batch_runs_single_running_idx(부분 유니크)가 kind별 동시 running 1개를 DB 수준에서 강제한다.
    // 충돌 시 unique violation(23505)을 "already-running"으로 변환한다.
    async createRun(input: Readonly<{ kind: BatchRunKind; createdBy: string | null; settings: BatchRunSettings | BatchPublishRunSettings; items: readonly NewBatchItem[] }>): Promise<
      { readonly kind: "created"; readonly run: BatchRunRow } | { readonly kind: "already-running" }
    > {
      const { data: run, error } = await client
        .from("batch_runs")
        .insert({ kind: input.kind, status: "running", created_by: input.createdBy, settings: input.settings as unknown as Json })
        .select("*")
        .single()
      if (error !== null) {
        if (error.code === "23505") {
          return { kind: "already-running" }
        }
        throw new SupabaseBatchRepositoryError("create run", error.message)
      }
      const rows = input.items.map((item) => ({
        batch_id: run.id,
        place_id: item.placeId,
        sequence: item.sequence,
        status: item.initialStatus ?? ("queued" as const),
        input_snapshot: item.inputSnapshot,
        ...(item.approvalSnapshot !== undefined ? { approval_snapshot: item.approvalSnapshot } : {}),
        idempotency_key: buildBatchIdempotencyKey(run.id, item.placeId),
      }))
      const { error: itemsError } = await client.from("batch_run_items").insert(rows)
      if (itemsError !== null) {
        // item 생성 실패 시 run을 실패로 닫아 락을 해제한다.
        await client.from("batch_runs").update({ status: "failed", finished_at: new Date().toISOString() }).eq("id", run.id)
        throw new SupabaseBatchRepositoryError("create run items", itemsError.message)
      }
      await recordEvent({ batchId: run.id, eventType: "run_created", toStatus: "running", actor: input.createdBy })
      return { kind: "created", run }
    },

    async getRun(batchId: string): Promise<BatchRunRow | null> {
      const { data, error } = await client.from("batch_runs").select("*").eq("id", batchId).maybeSingle()
      if (error !== null) {
        throw new SupabaseBatchRepositoryError("read run", error.message)
      }
      return data
    },

    async listItems(batchId: string): Promise<readonly BatchRunItemRow[]> {
      const { data, error } = await client.from("batch_run_items").select("*").eq("batch_id", batchId).order("sequence")
      if (error !== null) {
        throw new SupabaseBatchRepositoryError("list items", error.message)
      }
      return data
    },

    // 다음 처리 대상 1건을 원자적으로 점유한다: claim 가능 상태(queued/interrupted 등)에서만
    // processing으로 전이 — 조건부 UPDATE라 동시 호출 중 한쪽만 성공한다(멱등).
    async claimNextItem(batchId: string, kind: BatchRunKind, step: BatchItemStep, audit?: Readonly<{ trigger?: "auto" | "resume"; actor?: string | null }>): Promise<BatchRunItemRow | null> {
      const claimable = claimableStatusesFor(kind)
      const { data: candidates, error } = await client
        .from("batch_run_items")
        .select("*")
        .eq("batch_id", batchId)
        .in("status", [...claimable])
        .order("sequence")
        .limit(1)
      if (error !== null) {
        throw new SupabaseBatchRepositoryError("find next item", error.message)
      }
      const next = candidates[0]
      if (next === undefined) {
        return null
      }
      const { data: claimed, error: claimError } = await client
        .from("batch_run_items")
        .update({ status: "processing", current_step: step, started_at: next.started_at ?? new Date().toISOString() })
        .eq("id", next.id)
        .in("status", [...claimable])
        .select("*")
      if (claimError !== null) {
        throw new SupabaseBatchRepositoryError("claim item", claimError.message)
      }
      const item = claimed[0] ?? null
      if (item !== null) {
        // 최초 claim에서 run_started가 한 번만 남는다 — 이후 claim은 멱등성 키 충돌로 no-op.
        await recordEvent({ batchId, eventType: "run_started", toStatus: "running", actor: audit?.actor ?? null })
        await recordEvent({
          batchId,
          itemId: item.id,
          eventType: "item_claimed",
          fromStatus: next.status,
          toStatus: "processing",
          step,
          actor: audit?.actor ?? null,
          detail: { trigger: audit?.trigger ?? null },
        })
      }
      return item
    },

    // 결과 기록 — processing 상태에서만 종료 상태로 전이한다 (중복 완료 기록 차단).
    async recordItemResult(itemId: string, patch: BatchItemResultPatch): Promise<boolean> {
      const update: Partial<BatchRunItemRow> = {
        status: patch.status,
        ...(patch.currentStep !== undefined ? { current_step: patch.currentStep } : {}),
        ...(patch.generationId !== undefined ? { generation_id: patch.generationId } : {}),
        ...(patch.retryGenerationId !== undefined ? { retry_generation_id: patch.retryGenerationId } : {}),
        ...(patch.qualityStatus !== undefined ? { quality_status: patch.qualityStatus } : {}),
        ...(patch.qualityIssues !== undefined ? { quality_issues: patch.qualityIssues } : {}),
        ...(patch.tokensInput !== undefined ? { tokens_input: patch.tokensInput } : {}),
        ...(patch.tokensOutput !== undefined ? { tokens_output: patch.tokensOutput } : {}),
        ...(patch.costUsd !== undefined ? { cost_usd: patch.costUsd } : {}),
        ...(patch.approvalSnapshot !== undefined ? { approval_snapshot: patch.approvalSnapshot } : {}),
        ...(patch.publishResult !== undefined ? { publish_result: patch.publishResult } : {}),
        ...(patch.verificationStatus !== undefined ? { verification_status: patch.verificationStatus } : {}),
        ...(patch.skipReason !== undefined ? { skip_reason: patch.skipReason } : {}),
        ...(patch.lastErrorCode !== undefined ? { last_error_code: patch.lastErrorCode } : {}),
        ...(patch.lastErrorMessage !== undefined ? { last_error_message: patch.lastErrorMessage } : {}),
        ...(patch.finished === true ? { finished_at: new Date().toISOString() } : {}),
      }
      const { data, error } = await client.from("batch_run_items").update(update).eq("id", itemId).eq("status", "processing").select("id, batch_id")
      if (error !== null) {
        throw new SupabaseBatchRepositoryError("record item result", error.message)
      }
      const updated = data[0]
      if (updated !== undefined) {
        await recordEvent({
          batchId: updated.batch_id,
          itemId,
          eventType: "item_result_recorded",
          fromStatus: "processing",
          toStatus: patch.status,
          detail: {
            error_code: patch.lastErrorCode ?? null,
            skip_reason: patch.skipReason ?? null,
            tokens_input: patch.tokensInput ?? null,
            tokens_output: patch.tokensOutput ?? null,
            cost_usd: patch.costUsd ?? null,
            retry_count: patch.retryGenerationId != null ? 1 : 0,
            verification_status: patch.verificationStatus ?? null,
          },
        })
      }
      return data.length === 1
    },

    // 진행 중 단계 갱신 (processing 유지) — 진행 화면 표시·스테일 판정 기준(updated_at) 갱신용.
    async touchItemStep(itemId: string, step: BatchItemStep): Promise<void> {
      const { data, error } = await client.from("batch_run_items").update({ current_step: step }).eq("id", itemId).eq("status", "processing").select("batch_id")
      if (error !== null) {
        throw new SupabaseBatchRepositoryError("touch item step", error.message)
      }
      const updated = data[0]
      if (updated !== undefined) {
        await recordEvent({ batchId: updated.batch_id, itemId, eventType: "item_step_changed", step })
      }
    },

    // 장시간 멈춘 processing item을 interrupted로 판정한다 (자동 재개 없음 — '이어서 진행' 버튼 대상).
    async markStaleItemsInterrupted(batchId: string, now = new Date().toISOString(), staleMs?: number): Promise<readonly string[]> {
      const { data: processing, error } = await client.from("batch_run_items").select("*").eq("batch_id", batchId).eq("status", "processing")
      if (error !== null) {
        throw new SupabaseBatchRepositoryError("list processing items", error.message)
      }
      const stale = processing.filter((item) => isStaleProcessing({ status: item.status, updatedAt: item.updated_at, now, staleMs }))
      const marked: string[] = []
      for (const item of stale) {
        const { data: updated, error: updateError } = await client
          .from("batch_run_items")
          .update({ status: "interrupted", last_error_code: "interrupted", last_error_message: "processing이 장시간 갱신되지 않아 중단됨으로 판정" })
          .eq("id", item.id)
          .eq("status", "processing")
          .eq("updated_at", item.updated_at)
          .select("id")
        if (updateError !== null) {
          throw new SupabaseBatchRepositoryError("mark interrupted", updateError.message)
        }
        if (updated.length === 1) {
          marked.push(item.id)
          await recordEvent({ batchId, itemId: item.id, eventType: "item_interrupted_marked", fromStatus: "processing", toStatus: "interrupted" })
        }
      }
      return marked
    },

    // 남은 claim 대상 전부를 건너뜀 처리 (중단 버튼·비용 상한 도달).
    async skipRemainingItems(batchId: string, kind: BatchRunKind, skipReason: string): Promise<number> {
      const claimable = claimableStatusesFor(kind)
      const { data, error } = await client
        .from("batch_run_items")
        .update({ status: "skipped", skip_reason: skipReason, finished_at: new Date().toISOString() })
        .eq("batch_id", batchId)
        .in("status", [...claimable])
        .select("id")
      if (error !== null) {
        throw new SupabaseBatchRepositoryError("skip remaining items", error.message)
      }
      if (data.length > 0) {
        await recordEvent({ batchId, eventType: "items_skipped", toStatus: "skipped", detail: { skip_reason: skipReason, skipped_count: data.length } })
      }
      return data.length
    },

    // run 종료 — running 상태에서만 전이 (락 해제).
    async finishRun(batchId: string, status: "completed" | "cancelled" | "failed", totals: Json): Promise<boolean> {
      const { data, error } = await client
        .from("batch_runs")
        .update({ status, totals, finished_at: new Date().toISOString() })
        .eq("id", batchId)
        .eq("status", "running")
        .select("id")
      if (error !== null) {
        throw new SupabaseBatchRepositoryError("finish run", error.message)
      }
      if (data.length === 1) {
        await recordEvent({ batchId, eventType: "run_finished", fromStatus: "running", toStatus: status, detail: { cancelled_by_user: status === "cancelled" } })
      }
      return data.length === 1
    },

    // 지표 집계용 — 여러 run의 item 일괄 조회 (읽기 전용).
    async listItemsForRuns(batchIds: readonly string[]): Promise<readonly BatchRunItemRow[]> {
      if (batchIds.length === 0) {
        return []
      }
      const { data, error } = await client.from("batch_run_items").select("*").in("batch_id", [...batchIds])
      if (error !== null) {
        throw new SupabaseBatchRepositoryError("list items for runs", error.message)
      }
      return data
    },

    // 지표 집계용 — 최근 이벤트 일괄 조회. 테이블 미적용 배포에서는 빈 목록으로 강등.
    async listRecentEvents(limit = 1000): Promise<readonly BatchRunEventRow[]> {
      const { data, error } = await client.from("batch_run_events").select("*").order("created_at", { ascending: false }).limit(limit)
      if (error !== null) {
        console.error("[batch-events] list recent failed", { message: error.message })
        return []
      }
      return data
    },

    // Batch 이력 목록 — 최근 순. 읽기 전용이며 상태 전이와 무관하다.
    async listRuns(limit = 50): Promise<readonly BatchRunRow[]> {
      const { data, error } = await client.from("batch_runs").select("*").order("created_at", { ascending: false }).limit(limit)
      if (error !== null) {
        throw new SupabaseBatchRepositoryError("list runs", error.message)
      }
      return data
    },

    async findRunningRun(kind: BatchRunKind): Promise<BatchRunRow | null> {
      const { data, error } = await client.from("batch_runs").select("*").eq("kind", kind).eq("status", "running").maybeSingle()
      if (error !== null) {
        throw new SupabaseBatchRepositoryError("find running run", error.message)
      }
      return data
    },
  }
}

export type SupabaseBatchRepository = ReturnType<typeof createSupabaseBatchRepository>

export class SupabaseBatchRepositoryError extends Error {
  readonly name = "SupabaseBatchRepositoryError"

  constructor(step: string, readonly detail: string) {
    super(`Failed to ${step}: ${detail}`)
  }
}
