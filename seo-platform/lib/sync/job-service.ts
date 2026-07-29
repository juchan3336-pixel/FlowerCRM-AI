// Google Sheets 증분 동기화 자동 연속 처리 — 오케스트레이션.
// 한 tick = 정확히 50건 1배치. 처리 후 시트 마지막 행을 다시 확인해 잔여가 있으면 다음 tick을 예약한다.
// 실제 행 처리는 기존 syncSheetRows를 그대로 재사용한다 (파싱·upsert 계획·slug·오류 기록 전부 기존 경로).
//
// 의존성은 전부 주입받는다 — DB·Google API 없이 단위 테스트할 수 있어야 하기 때문이다.
import {
  computeBatchWindow,
  decideNextStep,
  firstUnsyncedRowNumber,
  hashTickToken,
  lastSheetRowNumber,
  mintTickToken,
  remainingRowCount,
  verifyTickToken,
  SYNC_JOB_BATCH_SIZE,
  type SyncJobStatus,
  type SyncTickOutcome,
} from "./job-policy"
import type { SyncSummary } from "./types"

export type SyncJobRow = {
  readonly id: string
  readonly status: SyncJobStatus
  readonly source_sheet_name: string
  readonly batch_size: number
  readonly start_row: number
  readonly current_row: number
  readonly target_last_row: number
  readonly latest_sheet_row: number
  readonly batch_index: number
  readonly processed_count: number
  readonly inserted_count: number
  readonly updated_count: number
  readonly skipped_count: number
  readonly failed_count: number
  readonly remaining_count: number
  readonly next_tick_token_hash: string | null
  readonly started_at: string
  readonly last_tick_at: string | null
  readonly finished_at: string | null
  readonly last_error_code: string | null
  readonly last_error_message: string | null
}

export type SyncJobProgress = {
  readonly batchIndex: number
  readonly currentRow: number
  readonly latestSheetRow: number
  readonly processedCount: number
  readonly insertedCount: number
  readonly updatedCount: number
  readonly skippedCount: number
  readonly failedCount: number
  readonly remainingCount: number
}

export type SyncJobRepository = {
  readonly findActiveJob: () => Promise<SyncJobRow | null>
  readonly findJobById: (jobId: string) => Promise<SyncJobRow | null>
  readonly findLatestJob: () => Promise<SyncJobRow | null>
  readonly createJob: (input: Readonly<{ sourceSheetName: string; createdBy: string | null; startRow: number; targetLastRow: number; remaining: number; tokenHash: string }>) => Promise<SyncJobRow | null>
  // queued|running ∧ 토큰 해시 일치일 때만 성공하는 조건부 UPDATE. 다음 토큰 해시로 회전시킨다.
  readonly claimTick: (input: Readonly<{ jobId: string; expectedTokenHash: string; nextTokenHash: string; nowIso: string }>) => Promise<SyncJobRow | null>
  // 재개 전용 — partial_completed|interrupted|failed → running. 관리자 인증을 통과한 서버 액션에서만 호출된다.
  readonly reviveJob: (input: Readonly<{ jobId: string; nextTokenHash: string; nowIso: string }>) => Promise<SyncJobRow | null>
  readonly recordProgress: (input: Readonly<{ jobId: string; progress: SyncJobProgress; nowIso: string }>) => Promise<void>
  readonly finishJob: (input: Readonly<{ jobId: string; status: SyncJobStatus; nowIso: string; errorCode?: string | null; errorMessage?: string | null }>) => Promise<void>
  // chain 발사 실패 표식 — 사용자가 재개할 수 있게 원인만 남긴다 (원문·토큰 저장 금지).
  readonly markInterrupted: (input: Readonly<{ jobId: string; errorCode: string; nowIso: string }>) => Promise<void>
}

export type SheetReader = () => Promise<Readonly<{ sheetName: string; rows: readonly Record<string, string | undefined>[] }>>

export type BatchRunner = (
  input: Readonly<{ rows: readonly Record<string, string | undefined>[]; sheetName: string; firstDataRowNumber: number; jobId: string; batchIndex: number }>,
) => Promise<SyncSummary>

export type SyncJobDependencies = {
  readonly repository: SyncJobRepository
  readonly readSheet: SheetReader
  readonly runBatch: BatchRunner
  readonly latestSourceRowNumber: (sheetName: string) => Promise<number | null>
}

export type NextTick = { readonly jobId: string; readonly token: string }

export type SyncTickResult = {
  readonly outcome: SyncTickOutcome
  // 존재하면 route가 after()로 self-chain fetch를 예약한다.
  readonly nextTick: NextTick | null
}

// ── 시작 ─────────────────────────────────────────────────────────
export type StartSyncJobResult =
  | { readonly kind: "started"; readonly jobId: string; readonly token: string; readonly remaining: number }
  // 이미 진행 중 — 중복 클릭·중복 발사는 새 job을 만들지 않고 기존 job을 알려준다.
  | { readonly kind: "already-active"; readonly jobId: string }
  // 미동기화 0건 — job을 만들지 않고 즉시 끝낸다.
  | { readonly kind: "nothing-to-sync" }
  | { readonly kind: "failed"; readonly reason: string }

export async function startSyncJob(
  dependencies: SyncJobDependencies,
  input: Readonly<{ createdBy: string | null; nowIso: string }>,
): Promise<StartSyncJobResult> {
  const active = await dependencies.repository.findActiveJob()
  if (active !== null) {
    return { kind: "already-active", jobId: active.id }
  }

  const sheet = await dependencies.readSheet()
  const latestSheetRow = lastSheetRowNumber(sheet.rows.length)
  const startRow = firstUnsyncedRowNumber(await dependencies.latestSourceRowNumber(sheet.sheetName))
  const remaining = remainingRowCount(startRow, latestSheetRow)
  if (remaining === 0) {
    return { kind: "nothing-to-sync" }
  }

  const minted = mintTickToken()
  const job = await dependencies.repository.createJob({
    sourceSheetName: sheet.sheetName,
    createdBy: input.createdBy,
    startRow,
    targetLastRow: latestSheetRow,
    remaining,
    tokenHash: minted.tokenHash,
  })
  if (job === null) {
    // 유니크 인덱스(진행 중 job 1개) 충돌 — 동시 클릭에서 진 쪽이다. 새 job을 만들지 않는다.
    const current = await dependencies.repository.findActiveJob()
    return current === null ? { kind: "failed", reason: "create-failed" } : { kind: "already-active", jobId: current.id }
  }
  return { kind: "started", jobId: job.id, token: minted.token, remaining }
}

// ── 재개 ─────────────────────────────────────────────────────────
// 상한 도달·chain 유실로 멈춘 job을 사용자가 1회 클릭으로 이어서 진행한다.
// 새 job을 만들지 않고 같은 job의 커서를 그대로 이어받는다 (중복 처리 없음).
export async function resumeSyncJob(
  dependencies: SyncJobDependencies,
  input: Readonly<{ jobId: string; nowIso: string }>,
): Promise<StartSyncJobResult> {
  const active = await dependencies.repository.findActiveJob()
  if (active !== null) {
    return { kind: "already-active", jobId: active.id }
  }
  const job = await dependencies.repository.findJobById(input.jobId)
  if (job === null) {
    return { kind: "failed", reason: "unknown-job" }
  }
  if (job.remaining_count === 0) {
    return { kind: "nothing-to-sync" }
  }

  // 재개는 토큰 원문 없이 진행하는 유일한 경로다 — 그래서 route(공개 endpoint)에는 없고,
  // 관리자 인증을 통과한 서버 액션에서만 호출된다. 여기서 새 토큰을 발급해 chain을 다시 건다.
  const minted = mintTickToken()
  const revived = await dependencies.repository.reviveJob({ jobId: job.id, nextTokenHash: minted.tokenHash, nowIso: input.nowIso })
  if (revived === null) {
    return { kind: "failed", reason: "resume-conflict" }
  }
  return { kind: "started", jobId: job.id, token: minted.token, remaining: job.remaining_count }
}

// ── tick ─────────────────────────────────────────────────────────
export async function executeSyncTick(
  dependencies: SyncJobDependencies,
  input: Readonly<{ jobId: string; token: string; nowIso: string }>,
): Promise<SyncTickResult> {
  const job = await dependencies.repository.findJobById(input.jobId)
  if (job === null) {
    return noChain({ kind: "unauthorized", reason: "unknown-job" })
  }
  // 종료 상태 job에 도착한 지연 chain은 무해한 no-op으로 흡수한다.
  if (job.status !== "queued" && job.status !== "running") {
    return noChain({ kind: "noop", reason: `terminal-${job.status}` })
  }
  if (!verifyTickToken(input.token, job.next_tick_token_hash)) {
    // 이미 회전된 토큰 = 중복·지연 chain. 인증 실패가 아니라 no-op으로 본다 (재시도 유발 금지).
    return noChain({ kind: "noop", reason: "stale-tick-token" })
  }

  // 원자 소진 — queued|running ∧ 해시 일치일 때만 통과하고, 즉시 다음 토큰으로 회전한다.
  // 동시에 도착한 두 chain 중 하나만 통과한다.
  const minted = mintTickToken()
  const claimed = await dependencies.repository.claimTick({
    jobId: job.id,
    expectedTokenHash: hashTickToken(input.token),
    nextTokenHash: minted.tokenHash,
    nowIso: input.nowIso,
  })
  if (claimed === null) {
    return noChain({ kind: "noop", reason: "duplicate-tick" })
  }

  // 매 tick마다 시트를 다시 읽는다 — 동기화 중 늘어난 행을 그대로 따라잡기 위함이다.
  let sheet: Awaited<ReturnType<SheetReader>>
  try {
    sheet = await dependencies.readSheet()
  } catch {
    await dependencies.repository.markInterrupted({ jobId: job.id, errorCode: "sheet-read-failed", nowIso: input.nowIso })
    return noChain({ kind: "failed", errorCode: "sheet-read-failed" })
  }
  const latestSheetRow = lastSheetRowNumber(sheet.rows.length)

  const step = decideNextStep({
    currentRow: claimed.current_row,
    latestSheetRow,
    batchSize: claimed.batch_size,
    batchIndex: claimed.batch_index,
    processedCount: claimed.processed_count,
  })

  if (step.kind === "completed") {
    await dependencies.repository.recordProgress({
      jobId: job.id,
      progress: progressOf(claimed, { latestSheetRow, remaining: 0 }),
      nowIso: input.nowIso,
    })
    await dependencies.repository.finishJob({ jobId: job.id, status: "completed", nowIso: input.nowIso })
    return noChain({ kind: "completed", processed: claimed.processed_count })
  }

  if (step.kind === "limit-reached") {
    await dependencies.repository.recordProgress({
      jobId: job.id,
      progress: progressOf(claimed, { latestSheetRow, remaining: step.remaining }),
      nowIso: input.nowIso,
    })
    // 상한 도달은 실패가 아니다 — 처리분은 그대로 두고 재개 가능 상태로 닫는다.
    await dependencies.repository.finishJob({
      jobId: job.id,
      status: "partial_completed",
      nowIso: input.nowIso,
      errorCode: "batch-limit",
      errorMessage: `자동 연속 처리 상한(${String(claimed.batch_index)} 배치)에 도달해 중단했습니다`,
    })
    return noChain({ kind: "partial", processed: claimed.processed_count, remaining: step.remaining })
  }

  const window = step.window
  const rows = sheet.rows.slice(window.startIndex, window.startIndex + window.count)

  let summary: SyncSummary
  try {
    summary = await dependencies.runBatch({
      rows,
      sheetName: claimed.source_sheet_name,
      firstDataRowNumber: window.startRow,
      jobId: job.id,
      batchIndex: claimed.batch_index + 1,
    })
  } catch {
    // 배치 자체가 터진 경우 — 커서를 전진시키지 않고 재개 가능 상태로 남긴다 (같은 창부터 재시도).
    await dependencies.repository.finishJob({
      jobId: job.id,
      status: "failed",
      nowIso: input.nowIso,
      errorCode: "batch-failed",
      errorMessage: "동기화 배치 처리 중 오류가 발생해 중단했습니다",
    })
    return noChain({ kind: "failed", errorCode: "batch-failed" })
  }

  // 커서는 "시도한 행 수"만큼 전진한다. 파싱 실패 행에서 멈추면 같은 50건을 무한 반복하게 된다
  // (기존 브라우저 자동 루프가 failed>0에서 멈춘 이유가 정확히 이것이다).
  const nextRow = window.startRow + window.count
  const remaining = remainingRowCount(nextRow, latestSheetRow)
  const progress: SyncJobProgress = {
    batchIndex: claimed.batch_index + 1,
    currentRow: nextRow,
    latestSheetRow,
    processedCount: claimed.processed_count + window.count,
    insertedCount: claimed.inserted_count + summary.inserted,
    updatedCount: claimed.updated_count + summary.updated,
    skippedCount: claimed.skipped_count + summary.skipped,
    failedCount: claimed.failed_count + summary.failed,
    remainingCount: remaining,
  }
  await dependencies.repository.recordProgress({ jobId: job.id, progress, nowIso: input.nowIso })

  if (remaining === 0) {
    await dependencies.repository.finishJob({ jobId: job.id, status: "completed", nowIso: input.nowIso })
    return noChain({ kind: "completed", processed: progress.processedCount })
  }

  return {
    outcome: { kind: "processed", jobStatus: "running", processed: progress.processedCount, remaining },
    nextTick: { jobId: job.id, token: minted.token },
  }
}

function progressOf(job: SyncJobRow, patch: Readonly<{ latestSheetRow: number; remaining: number }>): SyncJobProgress {
  return {
    batchIndex: job.batch_index,
    currentRow: job.current_row,
    latestSheetRow: patch.latestSheetRow,
    processedCount: job.processed_count,
    insertedCount: job.inserted_count,
    updatedCount: job.updated_count,
    skippedCount: job.skipped_count,
    failedCount: job.failed_count,
    remainingCount: patch.remaining,
  }
}

function noChain(outcome: SyncTickOutcome): SyncTickResult {
  return { outcome, nextTick: null }
}

export { SYNC_JOB_BATCH_SIZE, computeBatchWindow }
