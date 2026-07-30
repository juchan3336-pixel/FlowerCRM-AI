import "server-only"

// 자동 연속 동기화 job의 Supabase 접근 계층.
// 상태 전이는 전부 조건부 UPDATE다 — 읽고-판단하고-쓰는 경로를 만들지 않는다 (동시 chain 경합 방지).
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import { ACTIVE_SYNC_JOB_STATUSES, RESUMABLE_SYNC_JOB_STATUSES, SYNC_JOB_BATCH_SIZE, SYNC_SESSION_MAX_AUTO_JOBS } from "./job-policy"
import type { SyncJobRepository, SyncJobRow } from "./job-service"

const JOB_COLUMNS =
  "id, status, source_sheet_name, batch_size, start_row, current_row, target_last_row, latest_sheet_row, batch_index, processed_count, inserted_count, updated_count, skipped_count, failed_count, remaining_count, root_job_id, parent_job_id, chain_index, auto_continued, session_started_at, total_session_processed, max_auto_jobs, consecutive_error_count, zero_remaining_confirmations, cancel_requested, session_stop_reason, next_tick_token_hash, started_at, last_tick_at, finished_at, last_error_code, last_error_message"

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
          next_tick_token_hash: input.tokenHash,
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

    async claimTick(input): Promise<SyncJobRow | null> {
      // queued|running ∧ 해시 일치일 때만 통과. 성공과 동시에 토큰을 회전시켜 같은 토큰의 재사용을 막는다.
      const { data, error } = await client
        .from("sync_jobs")
        .update({ status: "running", next_tick_token_hash: input.nextTokenHash, last_tick_at: input.nowIso })
        .eq("id", input.jobId)
        .eq("next_tick_token_hash", input.expectedTokenHash)
        .in("status", [...ACTIVE_SYNC_JOB_STATUSES])
        .select(JOB_COLUMNS)
        .maybeSingle()
      if (error !== null) {
        throw new SyncJobWriteError(error.message)
      }
      return toJobRow(data)
    },

    async reviveJob(input): Promise<SyncJobRow | null> {
      // 재개 가능한 종료 상태에서만 running으로 되살린다. 진행 중 job은 유니크 인덱스가 막는다.
      const { data, error } = await client
        .from("sync_jobs")
        .update({ status: "running", next_tick_token_hash: input.nextTokenHash, last_tick_at: input.nowIso, finished_at: null, last_error_code: null, last_error_message: null })
        .eq("id", input.jobId)
        .in("status", [...RESUMABLE_SYNC_JOB_STATUSES])
        .select(JOB_COLUMNS)
        .maybeSingle()
      if (error !== null) {
        return null
      }
      return toJobRow(data)
    },

    async recordProgress(input): Promise<void> {
      const { error } = await client
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
      if (error !== null) {
        throw new SyncJobWriteError(error.message)
      }
    },

    async finishJob(input): Promise<void> {
      const { error } = await client
        .from("sync_jobs")
        .update({
          status: input.status,
          finished_at: input.nowIso,
          last_error_code: input.errorCode ?? null,
          last_error_message: input.errorMessage ?? null,
          session_stop_reason: input.sessionStopReason ?? null,
        })
        .eq("id", input.jobId)
        .in("status", [...ACTIVE_SYNC_JOB_STATUSES])
      if (error !== null) {
        throw new SyncJobWriteError(error.message)
      }
    },

    async markInterrupted(input): Promise<void> {
      // chain 발사 실패 표식 — 진행 중일 때만 찍는다. 원문 오류·토큰은 남기지 않는다.
      //
      // expectedTokenHash가 오면 "그 tick이 아직 소진되지 않았을 때만" 찍는 조건부 UPDATE가 된다.
      // 발사한 쪽은 응답을 못 봤어도 상대가 이미 접수(claim)했을 수 있는데, claim은 토큰을 회전시키므로
      // 해시 불일치 = 접수됨 = 표식 금지가 된다. 진행 중인 tick을 interrupted로 덮어 chain을 죽이는
      // 경로를 이 조건 하나로 닫는다 (이번 장애의 재발 방지 지점).
      let query = client
        .from("sync_jobs")
        .update({ status: "interrupted", last_error_code: input.errorCode, last_error_message: null, finished_at: input.nowIso })
        .eq("id", input.jobId)
        .in("status", [...ACTIVE_SYNC_JOB_STATUSES])
      if (input.expectedTokenHash !== undefined) {
        query = query.eq("next_tick_token_hash", input.expectedTokenHash)
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
