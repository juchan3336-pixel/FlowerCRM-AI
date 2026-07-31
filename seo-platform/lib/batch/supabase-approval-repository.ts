import "server-only"

// 승인 Batch 자동 생성 v1 — 승인 저장소 (PR-A).
// 모든 상태 전이는 "기대 상태 일치 시에만" 갱신하는 조건부 UPDATE로 수행한다.
// 기대 상태가 다르면 0행 갱신(no-op)이며, 이것이 중복 활성화·중복 tick·경합의 1차 방어선이다.
// 이 모듈은 batch_approvals만 다루고 기존 batch_runs/items/events는 일절 수정하지 않는다.
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { ApprovalPlaceSnapshot } from "./approval-policy"
import type { BatchApprovalRow, Json } from "@/types/database"

const APPROVAL_SELECT = "*"
// 사용자용 오류 메시지는 길이를 제한해 저장한다 (stack trace·원문 저장 금지).
const ERROR_MESSAGE_MAX_LENGTH = 300

export type CreateApprovalInput = {
  readonly approvedBy: string
  readonly approvalExpiresAt: string
  readonly approvedPlaceIds: readonly string[]
  readonly approvedMaxCostUsd: number
  readonly approvalSnapshot: readonly ApprovalPlaceSnapshot[]
  // Activation token의 SHA-256 해시 — 원문은 저장하지 않는다.
  readonly executionTokenHash: string
}

export type CreateApprovalResult =
  | { readonly kind: "created"; readonly approval: BatchApprovalRow }
  // 활성 승인(approved/queued/running)이 이미 존재 — 전역 1건 원칙(partial unique index) 위반.
  | { readonly kind: "already-active" }

export function createSupabaseApprovalRepository() {
  const client = createSupabaseServiceRoleClient()

  return {
    async createApproval(input: CreateApprovalInput): Promise<CreateApprovalResult> {
      const { data, error } = await client
        .from("batch_approvals")
        .insert({
          approved_by: input.approvedBy,
          approval_expires_at: input.approvalExpiresAt,
          approved_place_ids: input.approvedPlaceIds as string[],
          approved_max_cost_usd: input.approvedMaxCostUsd,
          approval_snapshot: input.approvalSnapshot as unknown as Json,
          execution_token_hash: input.executionTokenHash,
        })
        .select(APPROVAL_SELECT)
        .single()
      if (error !== null) {
        if (error.code === "23505") {
          return { kind: "already-active" }
        }
        throw new SupabaseApprovalRepositoryError("create approval", error.message)
      }
      return { kind: "created", approval: data }
    },

    // 승인 이력 표시용 — 최신순 목록 (읽기 전용).
    async listApprovals(limit = 20): Promise<readonly BatchApprovalRow[]> {
      const { data, error } = await client.from("batch_approvals").select(APPROVAL_SELECT).order("approved_at", { ascending: false }).limit(limit)
      if (error !== null) {
        throw new SupabaseApprovalRepositoryError("list approvals", error.message)
      }
      return data
    },

    async findApprovalById(approvalId: string): Promise<BatchApprovalRow | null> {
      const { data, error } = await client.from("batch_approvals").select(APPROVAL_SELECT).eq("id", approvalId).maybeSingle()
      if (error !== null) {
        throw new SupabaseApprovalRepositoryError("find approval", error.message)
      }
      return data
    },

    async findApprovalByTokenHash(tokenHash: string): Promise<BatchApprovalRow | null> {
      const { data, error } = await client.from("batch_approvals").select(APPROVAL_SELECT).eq("execution_token_hash", tokenHash).maybeSingle()
      if (error !== null) {
        throw new SupabaseApprovalRepositoryError("find approval by token", error.message)
      }
      return data
    },

    // kick 발사 직전 표시 — approved에서만 queued로 올린다.
    async markQueued(approvalId: string): Promise<BatchApprovalRow | null> {
      const { data, error } = await client
        .from("batch_approvals")
        .update({ status: "queued" })
        .eq("id", approvalId)
        .eq("status", "approved")
        .select(APPROVAL_SELECT)
      if (error !== null) {
        throw new SupabaseApprovalRepositoryError("mark queued", error.message)
      }
      return data[0] ?? null
    },

    // Activation token 소진 — approved|queued에서만, 미소진·미연결·미만료 조건이 전부 맞을 때만
    // running으로 전이하며 activation_consumed_at을 기록한다. 이 조건부 UPDATE 1문이
    // "동일 토큰 재사용 차단"과 "batch_run 연결 후 재활성화 금지"를 원자적으로 보장한다.
    async activateApproval(input: Readonly<{ executionTokenHash: string; nowIso: string }>): Promise<BatchApprovalRow | null> {
      const { data, error } = await client
        .from("batch_approvals")
        .update({ status: "running", activation_consumed_at: input.nowIso })
        .eq("execution_token_hash", input.executionTokenHash)
        .in("status", ["approved", "queued"])
        .is("activation_consumed_at", null)
        .is("batch_run_id", null)
        .gt("approval_expires_at", input.nowIso)
        .select(APPROVAL_SELECT)
      if (error !== null) {
        throw new SupabaseApprovalRepositoryError("activate approval", error.message)
      }
      return data[0] ?? null
    },

    // 활성화 직후 생성된 batch_run 1건을 연결한다 — running이고 아직 미연결일 때만.
    async linkBatchRun(approvalId: string, batchRunId: string): Promise<BatchApprovalRow | null> {
      const { data, error } = await client
        .from("batch_approvals")
        .update({ batch_run_id: batchRunId })
        .eq("id", approvalId)
        .eq("status", "running")
        .is("batch_run_id", null)
        .select(APPROVAL_SELECT)
      if (error !== null) {
        throw new SupabaseApprovalRepositoryError("link batch run", error.message)
      }
      return data[0] ?? null
    },

    // tick CAS — execution_tick이 기대값과 정확히 일치할 때만 +1 전진한다.
    // 중복·지연·재전송 tick은 여기서 0행(no-op)으로 흡수되어 순차성이 보장된다.
    async advanceExecutionTick(
      input: Readonly<{ approvalId: string; expectedTick: number; nowIso: string; previewDeploymentSha?: string | null }>,
    ): Promise<boolean> {
      const { data, error } = await client
        .from("batch_approvals")
        .update({
          execution_tick: input.expectedTick + 1,
          last_tick_at: input.nowIso,
          ...(input.previewDeploymentSha == null ? {} : { preview_deployment_sha: input.previewDeploymentSha }),
        })
        .eq("id", input.approvalId)
        .eq("status", "running")
        .eq("execution_tick", input.expectedTick)
        .select("id")
      if (error !== null) {
        throw new SupabaseApprovalRepositoryError("advance execution tick", error.message)
      }
      return data.length === 1
    },

    async expireApproval(approvalId: string): Promise<BatchApprovalRow | null> {
      const { data, error } = await client
        .from("batch_approvals")
        .update({ status: "expired" })
        .eq("id", approvalId)
        .in("status", ["approved", "queued"])
        .select(APPROVAL_SELECT)
      if (error !== null) {
        throw new SupabaseApprovalRepositoryError("expire approval", error.message)
      }
      return data[0] ?? null
    },

    async cancelApproval(approvalId: string): Promise<BatchApprovalRow | null> {
      const { data, error } = await client
        .from("batch_approvals")
        .update({ status: "cancelled" })
        .eq("id", approvalId)
        .in("status", ["approved", "queued", "running"])
        .select(APPROVAL_SELECT)
      if (error !== null) {
        throw new SupabaseApprovalRepositoryError("cancel approval", error.message)
      }
      return data[0] ?? null
    },

    // kick 실패 보상 — 승인을 approved/queued 상태로 방치하지 않고 취소로 닫으면서 사유를 남긴다.
    // 상태 전이표상 approved→failed는 없으므로 cancelled로 닫는다 (종료 상태 = 같은 토큰 재사용 불가).
    async cancelApprovalWithError(approvalId: string, failure: Readonly<{ code: string; message: string }>): Promise<BatchApprovalRow | null> {
      const { data, error } = await client
        .from("batch_approvals")
        .update({
          status: "cancelled",
          last_error_code: failure.code,
          last_error_message: failure.message.slice(0, ERROR_MESSAGE_MAX_LENGTH),
        })
        .eq("id", approvalId)
        .in("status", ["approved", "queued", "running"])
        .select(APPROVAL_SELECT)
      if (error !== null) {
        throw new SupabaseApprovalRepositoryError("cancel approval with error", error.message)
      }
      return data[0] ?? null
    },

    // ── pump 실행 소유권 (lease) ──────────────────────────────────
    // 후보 선택과 lease 기록을 한 원자 연산으로 묶은 RPC. 개별 UPDATE로 나누면 그 사이가 벌어져
    // 두 pump가 같은 승인을 가져갈 수 있다 (for update skip locked로 승자 1개를 보장한다).
    // approved·queued는 RPC 조건에서 제외돼 있다 — pump가 승인 게이트를 넘지 못하게 하는 지점이다.
    async claimPumpLease(input: Readonly<{ leaseTokenHash: string; leaseSeconds: number; nowIso: string }>): Promise<BatchApprovalRow | null> {
      const { data, error } = await client.rpc("claim_batch_pump_lease", {
        p_now: input.nowIso,
        p_lease_token_hash: input.leaseTokenHash,
        p_lease_seconds: input.leaseSeconds,
      })
      if (error !== null) {
        throw new SupabaseApprovalRepositoryError("claim pump lease", error.message)
      }
      const rows = Array.isArray(data) ? data : []
      return (rows[0] as BatchApprovalRow | undefined) ?? null
    },

    // 내가 아직 소유자일 때만 놓는다. 이미 만료돼 남이 가져갔다면 그 lease를 지워선 안 된다.
    async releasePumpLease(input: Readonly<{ approvalId: string; leaseTokenHash: string }>): Promise<void> {
      const { error } = await client
        .from("batch_approvals")
        .update({ lease_token_hash: null, lease_expires_at: null })
        .eq("id", input.approvalId)
        .eq("lease_token_hash", input.leaseTokenHash)
      if (error !== null) {
        throw new SupabaseApprovalRepositoryError("release pump lease", error.message)
      }
    },

    // lease를 아직 들고 있는지 확인 — 승인 상태를 바꾸기 직전에 쓴다.
    // 만료돼 다른 pump가 가져간 뒤 뒤늦게 끝난 워커가 남의 진행을 덮지 못하게 한다.
    async holdsPumpLease(input: Readonly<{ approvalId: string; leaseTokenHash: string }>): Promise<boolean> {
      const { data, error } = await client
        .from("batch_approvals")
        .select("id")
        .eq("id", input.approvalId)
        .eq("lease_token_hash", input.leaseTokenHash)
      if (error !== null) {
        throw new SupabaseApprovalRepositoryError("check pump lease", error.message)
      }
      return data.length > 0
    },

    async completeApproval(approvalId: string, leaseTokenHash?: string): Promise<BatchApprovalRow | null> {
      let query = client
        .from("batch_approvals")
        .update({ status: "completed", lease_token_hash: null, lease_expires_at: null })
        .eq("id", approvalId)
        .eq("status", "running")
      if (leaseTokenHash !== undefined) {
        query = query.eq("lease_token_hash", leaseTokenHash)
      }
      const { data, error } = await query.select(APPROVAL_SELECT)
      if (error !== null) {
        throw new SupabaseApprovalRepositoryError("complete approval", error.message)
      }
      return data[0] ?? null
    },

    async failApproval(approvalId: string, failure: Readonly<{ code: string; message: string }>): Promise<BatchApprovalRow | null> {
      const { data, error } = await client
        .from("batch_approvals")
        .update({
          status: "failed",
          last_error_code: failure.code,
          last_error_message: failure.message.slice(0, ERROR_MESSAGE_MAX_LENGTH),
        })
        .eq("id", approvalId)
        .in("status", ["queued", "running"])
        .select(APPROVAL_SELECT)
      if (error !== null) {
        throw new SupabaseApprovalRepositoryError("fail approval", error.message)
      }
      return data[0] ?? null
    },

    // self-chain fetch가 실패해 다음 tick 예약이 끊긴 경우의 진단 표식만 남긴다.
    // status는 running 그대로 유지한다 — 자동 전체 재실행 금지 원칙에 따라 사용자가 관리자에서 1회 재개한다.
    async recordChainDispatchError(approvalId: string, code: string, message?: string): Promise<BatchApprovalRow | null> {
      const { data, error } = await client
        .from("batch_approvals")
        .update({
          last_error_code: code,
          last_error_message: (message ?? code).slice(0, ERROR_MESSAGE_MAX_LENGTH),
        })
        .eq("id", approvalId)
        .eq("status", "running")
        .select(APPROVAL_SELECT)
      if (error !== null) {
        throw new SupabaseApprovalRepositoryError("record chain dispatch error", error.message)
      }
      return data[0] ?? null
    },
  }
}

export class SupabaseApprovalRepositoryError extends Error {
  readonly name = "SupabaseApprovalRepositoryError"

  constructor(operation: string, detail: string) {
    super(`Failed to ${operation}: ${detail}`)
  }
}
