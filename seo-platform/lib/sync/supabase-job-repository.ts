import "server-only"

// 자동 연속 동기화 job의 Supabase 접근 계층.
// 상태 전이는 전부 조건부 UPDATE다 — 읽고-판단하고-쓰는 경로를 만들지 않는다 (동시 chain 경합 방지).
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import { ACTIVE_SYNC_JOB_STATUSES, RESUMABLE_SYNC_JOB_STATUSES, SYNC_JOB_BATCH_SIZE } from "./job-policy"
import type { SyncJobRepository, SyncJobRow } from "./job-service"

const JOB_COLUMNS =
  "id, status, source_sheet_name, batch_size, start_row, current_row, target_last_row, latest_sheet_row, batch_index, processed_count, inserted_count, updated_count, skipped_count, failed_count, remaining_count, next_tick_token_hash, started_at, last_tick_at, finished_at, last_error_code, last_error_message"

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
        })
        .select(JOB_COLUMNS)
        .maybeSingle()
      // 진행 중 job 유니크 인덱스 충돌은 오류가 아니라 "동시 클릭에서 졌다"는 정상 결과다 — null로 알린다.
      if (error !== null) {
        return null
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
        })
        .eq("id", input.jobId)
        .in("status", [...ACTIVE_SYNC_JOB_STATUSES])
      if (error !== null) {
        throw new SyncJobWriteError(error.message)
      }
    },

    async markInterrupted(input): Promise<void> {
      // chain 발사 실패 표식 — 진행 중일 때만 찍는다. 원문 오류·토큰은 남기지 않는다.
      const { error } = await client
        .from("sync_jobs")
        .update({ status: "interrupted", last_error_code: input.errorCode, last_error_message: null, finished_at: input.nowIso })
        .eq("id", input.jobId)
        .in("status", [...ACTIVE_SYNC_JOB_STATUSES])
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
