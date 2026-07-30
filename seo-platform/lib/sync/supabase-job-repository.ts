import "server-only"

// 자동 연속 동기화 job의 Supabase 접근 계층.
// 상태 전이는 전부 조건부 UPDATE다 — 읽고-판단하고-쓰는 경로를 만들지 않는다 (동시 chain 경합 방지).
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import { ACTIVE_SYNC_JOB_STATUSES, RESUMABLE_SYNC_JOB_STATUSES, SYNC_JOB_BATCH_SIZE, SYNC_SESSION_MAX_AUTO_JOBS } from "./job-policy"
import type { SyncJobRepository, SyncJobRow } from "./job-service"

const JOB_COLUMNS =
  "id, status, source_sheet_name, batch_size, start_row, current_row, target_last_row, latest_sheet_row, batch_index, processed_count, inserted_count, updated_count, skipped_count, failed_count, remaining_count, root_job_id, parent_job_id, chain_index, auto_continued, session_started_at, total_session_processed, max_auto_jobs, consecutive_error_count, zero_remaining_confirmations, cancel_requested, session_stop_reason, lease_token_hash, lease_expires_at, pump_attempt, started_at, last_tick_at, finished_at, last_error_code, last_error_message"

export function createSupabaseSyncJobRepository(): SyncJobRepository {
  const client = createSupabaseServiceRoleClient()

  return {
    async findActiveJob(): Promise<SyncJobRow | null> {
      const { data, error } = await client.from("sync_jobs").select(JOB_COLUMNS).in("status", [...ACTIVE_SYNC_JOB_STATUSES]).limit(1).maybeSingle()
      if (error !== null) {
        throw new SyncJobWriteError(error.message)
      }
      return toJobRow(data)
    },

    async findJobById(jobId: string): Promise<SyncJobRow | null> {
      const { data, error } = await client.from("sync_jobs").select(JOB_COLUMNS).eq("id", jobId).maybeSingle()
      if (error !== null) {
        throw new SyncJobWriteError(error.message)
      }
      return toJobRow(data)
    },

    async findLatestJob(): Promise<SyncJobRow | null> {
      const { data, error } = await client.from("sync_jobs").select(JOB_COLUMNS).order("started_at", { ascending: false }).limit(1).maybeSingle()
      if (error !== null) {
        throw new SyncJobWriteError(error.message)
      }
      return toJobRow(data)
    },

    async createJob(input): Promise<SyncJobRow | null> {
      const { data, error } = await client
        .from("sync_jobs")
        .insert({
          status: "queued",
          source_sheet_name: input.sourceSheetName,
          created_by: input.createdBy,
          batch_size: SYNC_JOB_BATCH_SIZE,
          start_row: input.startRow,
          current_row: input.startRow,
          target_last_row: input.targetLastRow,
          latest_sheet_row: input.targetLastRow,
          remaining_count: input.remaining,
          root_job_id: input.rootJobId ?? null,
          parent_job_id: input.parentJobId ?? null,
          chain_index: input.chainIndex ?? 0,
          auto_continued: input.autoContinued ?? false,
          session_started_at: input.sessionStartedAt ?? new Date().toISOString(),
          total_session_processed: input.totalSessionProcessed ?? 0,
          max_auto_jobs: input.maxAutoJobs ?? SYNC_SESSION_MAX_AUTO_JOBS,
          consecutive_error_count: input.consecutiveErrorCount ?? 0,
        })
        .select(JOB_COLUMNS)
        .maybeSingle()
      // 진행 중 job 유니크 인덱스 충돌은 오류가 아니라 "동시 클릭에서 졌다"는 정상 결과다 — null로 알린다.
      if (error !== null) {
        return null
      }
      return toJobRow(data)
    },

    async setRootToSelf(jobId): Promise<void> {
      // 최초 사용자 시작 job은 자기 자신이 세션 root다 (insert 시점에는 id를 모르므로 뒤이어 채운다).
      const { error } = await client.from("sync_jobs").update({ root_job_id: jobId }).eq("id", jobId).is("root_job_id", null)
      if (error !== null) {
        throw new SyncJobWriteError(error.message)
      }
    },

    async listSessionJobs(rootJobId): Promise<readonly SyncJobRow[]> {
      const { data, error } = await client.from("sync_jobs").select(JOB_COLUMNS).eq("root_job_id", rootJobId).order("chain_index", { ascending: true })
      if (error !== null) {
        throw new SyncJobWriteError(error.message)
      }
      return data
    },

    async requestCancel(jobId): Promise<SyncJobRow | null> {
      // 진행 중일 때만 표식을 세운다. 진행 중 배치는 끝까지 처리되고, 후속 job만 만들어지지 않는다.
      const { data, error } = await client
        .from("sync_jobs")
        .update({ cancel_requested: true })
        .eq("id", jobId)
        .in("status", [...ACTIVE_SYNC_JOB_STATUSES])
        .select(JOB_COLUMNS)
        .maybeSingle()
      if (error !== null) {
        throw new SyncJobWriteError(error.message)
      }
      return toJobRow(data)
    },

    async claimPumpLease(input): Promise<SyncJobRow | null> {
      // 후보 선택과 lease 기록을 한 원자 연산으로 묶은 RPC. 개별 UPDATE로 나누면 그 사이에
      // 다른 pump가 같은 job을 가져갈 수 있다 (for update skip locked로 승자 1개를 보장한다).
      const { data, error } = await client.rpc("claim_sync_pump_lease", {
        p_now: input.nowIso,
        p_lease_token_hash: input.leaseTokenHash,
        p_lease_seconds: input.leaseSeconds,
      })
      if (error !== null) {
        throw new SyncJobWriteError(error.message)
      }
      const rows = Array.isArray(data) ? data : []
      return rows.length === 0 ? null : toJobRow(rows[0])
    },

    async releaseLease(input): Promise<void> {
      // 내가 아직 소유자일 때만 놓는다. 이미 만료돼 남이 가져갔다면 그 lease를 지워선 안 된다.
      const { error } = await client
        .from("sync_jobs")
        .update({ lease_token_hash: null, lease_expires_at: null, last_tick_at: input.nowIso })
        .eq("id", input.jobId)
        .eq("lease_token_hash", input.leaseTokenHash)
        .in("status", [...ACTIVE_SYNC_JOB_STATUSES])
      if (error !== null) {
        throw new SyncJobWriteError(error.message)
      }
    },

    async reviveJob(input): Promise<SyncJobRow | null> {
      // 재개 가능한 종료 상태에서만 queued로 되살린다 (진행 중 job은 유니크 인덱스가 막는다).
      // running이 아니라 queued로 두는 이유: 배치를 도는 주체는 이 요청이 아니라 다음 Cron이다.
      // lease도 함께 비워 다음 pump가 곧바로 claim할 수 있게 한다.
      const { data, error } = await client
        .from("sync_jobs")
        .update({
          status: "queued",
          last_tick_at: input.nowIso,
          finished_at: null,
          last_error_code: null,
          last_error_message: null,
          lease_token_hash: null,
          lease_expires_at: null,
        })
        .eq("id", input.jobId)
        .in("status", [...RESUMABLE_SYNC_JOB_STATUSES])
        .select(JOB_COLUMNS)
        .maybeSingle()
      if (error !== null) {
        return null
      }
      return toJobRow(data)
    },

    async recordProgress(input): Promise<boolean> {
      // lease 보유자만 쓴다. 조건이 깨지면 0행이 되고 false를 돌려준다 —
      // lease가 만료돼 다른 pump가 이미 같은 job을 가져간 뒤 뒤늦게 끝난 워커가
      // 커서를 두 번 전진시키는 경로를 여기서 닫는다.
      const { data, error } = await client
        .from("sync_jobs")
        .update({
          batch_index: input.progress.batchIndex,
          current_row: input.progress.currentRow,
          latest_sheet_row: input.progress.latestSheetRow,
          processed_count: input.progress.processedCount,
          inserted_count: input.progress.insertedCount,
          updated_count: input.progress.updatedCount,
          skipped_count: input.progress.skippedCount,
          failed_count: input.progress.failedCount,
          remaining_count: input.progress.remainingCount,
          total_session_processed: input.progress.totalSessionProcessed,
          zero_remaining_confirmations: input.progress.zeroRemainingConfirmations,
          consecutive_error_count: input.progress.consecutiveErrorCount,
          last_tick_at: input.nowIso,
        })
        .eq("id", input.jobId)
        .eq("lease_token_hash", input.leaseTokenHash)
        .select("id")
      if (error !== null) {
        throw new SyncJobWriteError(error.message)
      }
      return Array.isArray(data) && data.length > 0
    },

    async finishJob(input): Promise<boolean> {
      // 종료도 lease 보유자만 한다. 끝내면서 lease를 비워 다음 job이 곧바로 claim될 수 있게 한다.
      const { data, error } = await client
        .from("sync_jobs")
        .update({
          status: input.status,
          finished_at: input.nowIso,
          last_error_code: input.errorCode ?? null,
          last_error_message: input.errorMessage ?? null,
          session_stop_reason: input.sessionStopReason ?? null,
          lease_token_hash: null,
          lease_expires_at: null,
        })
        .eq("id", input.jobId)
        .eq("lease_token_hash", input.leaseTokenHash)
        .in("status", [...ACTIVE_SYNC_JOB_STATUSES])
        .select("id")
      if (error !== null) {
        throw new SyncJobWriteError(error.message)
      }
      return Array.isArray(data) && data.length > 0
    },

    async markInterrupted(input): Promise<void> {
      // 배치가 예기치 못하게 터졌을 때의 표식 — 진행 중일 때만 찍는다.
      // leaseTokenHash가 오면 "내가 아직 소유자일 때만"으로 조건화된다: lease가 이미 넘어갔다면
      // 0행이 되어 남의 진행을 interrupted로 덮지 않는다.
      // errorMessage는 상위에서 이미 안전 요약으로 만들어 넘긴다 (원문 오류·토큰·본문은 오지 않는다).
      let query = client
        .from("sync_jobs")
        .update({
          status: "interrupted",
          last_error_code: input.errorCode,
          last_error_message: input.errorMessage ?? null,
          finished_at: input.nowIso,
          lease_token_hash: null,
          lease_expires_at: null,
        })
        .eq("id", input.jobId)
        .in("status", [...ACTIVE_SYNC_JOB_STATUSES])
      if (input.leaseTokenHash !== undefined) {
        query = query.eq("lease_token_hash", input.leaseTokenHash)
      }
      const { error } = await query
      if (error !== null) {
        throw new SyncJobWriteError(error.message)

      }
    },
  }
}

function toJobRow(data: unknown): SyncJobRow | null {
  return data === null || data === undefined ? null : (data as SyncJobRow)
}

export class SyncJobWriteError extends Error {
  readonly name = "SyncJobWriteError"

  constructor(message: string) {
    super(`Supabase sync job write failed: ${message}`)
  }
}
