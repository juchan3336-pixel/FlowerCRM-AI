// Google Sheets 증분 동기화 자동 연속 처리 — 오케스트레이션.
//
// 한 tick = 정확히 50건 1배치. 시트는 필요한 50행 구간만 읽고, 마지막 행 번호만 따로 확인한다
// (전체 시트 payload를 tick마다 다시 내려받지 않는다 — Google API 요청량이 전체 행 수가 아니라
//  batch 수에 비례해야 하기 때문이다).
//
// job 하나는 5,000행에서 끊기지만, 잔여가 있고 세션 전역 상한에 걸리지 않으면 서버가 후속 job을
// 자동으로 만들어 이어간다. 사용자는 시작 버튼을 한 번만 누른다.
//
// 진행 방식은 pull이다 — 외부 스케줄러(Supabase Cron)가 pump를 부르고, pump가 job 1개를 claim해
// 배치 1개만 돌린 뒤 종료한다. 자기 자신을 HTTP로 다시 부르는 경로는 없다 (Vercel 508 재귀 차단).
//
// 실제 행 처리는 기존 syncSheetRows를 그대로 재사용한다 (파싱·upsert 계획·slug·오류 기록 전부 기존 경로).
// 의존성은 전부 주입받는다 — DB·Google API 없이 단위 테스트할 수 있어야 하기 때문이다.
import {
  computeBatchWindow,
  decideNextStep,
  decideSessionContinuation,
  detectRowNumberDrift,
  firstUnsyncedRowNumber,
  mintLeaseToken,
  remainingRowCount,
  rowNumberDriftMessage,
  sessionElapsedMs,
  shouldRecheckSheetLastRow,
  ROW_NUMBER_DRIFT_CODE,
  RESUMABLE_SYNC_JOB_STATUSES,
  SYNC_JOB_BATCH_SIZE,
  SYNC_JOB_MAX_BATCHES,
  SYNC_JOB_MAX_ROWS,
  SYNC_PUMP_LEASE_SECONDS,
  SYNC_SESSION_MAX_AUTO_JOBS,
  SYNC_SESSION_MAX_ELAPSED_MS,
  SYNC_ZERO_REMAINING_CONFIRMATIONS,
  type RowNumberDrift,
  type SessionStopReason,
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
  readonly root_job_id: string | null
  readonly parent_job_id: string | null
  readonly chain_index: number
  readonly auto_continued: boolean
  readonly session_started_at: string
  readonly total_session_processed: number
  readonly max_auto_jobs: number
  readonly consecutive_error_count: number
  readonly zero_remaining_confirmations: number
  readonly cancel_requested: boolean
  readonly session_stop_reason: SessionStopReason | null
  // 실행 소유권 — pump가 claim하면 채워지고, 배치를 끝내면 비워진다.
  readonly lease_token_hash: string | null
  readonly lease_expires_at: string | null
  readonly pump_attempt: number
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
  readonly totalSessionProcessed: number
  readonly zeroRemainingConfirmations: number
  readonly consecutiveErrorCount: number
}

export type CreateJobInput = {
  readonly sourceSheetName: string
  readonly createdBy: string | null
  readonly startRow: number
  readonly targetLastRow: number
  readonly remaining: number
  // 후속 job이면 세션 연결 정보가 들어온다 (최초 사용자 시작 job이면 전부 기본값).
  readonly rootJobId?: string | null
  readonly parentJobId?: string | null
  readonly chainIndex?: number
  readonly autoContinued?: boolean
  readonly sessionStartedAt?: string
  readonly totalSessionProcessed?: number
  readonly maxAutoJobs?: number
  readonly consecutiveErrorCount?: number
}

export type SyncJobRepository = {
  readonly findActiveJob: () => Promise<SyncJobRow | null>
  readonly findJobById: (jobId: string) => Promise<SyncJobRow | null>
  readonly findLatestJob: () => Promise<SyncJobRow | null>
  // 같은 세션(root)의 모든 job — UI 누적 표시와 세션 상한 판정에 쓴다.
  readonly listSessionJobs: (rootJobId: string) => Promise<readonly SyncJobRow[]>
  readonly createJob: (input: CreateJobInput) => Promise<SyncJobRow | null>
  // 최초 job은 자기 자신이 root다 — insert 후 root_job_id를 자기 id로 채운다.
  readonly setRootToSelf: (jobId: string) => Promise<void>
  // 처리 가능한 job 1개를 골라 lease를 거는 원자 연산. 동시 호출 중 승자만 행을 받는다.
  readonly claimPumpLease: (input: Readonly<{ leaseTokenHash: string; leaseSeconds: number; nowIso: string }>) => Promise<SyncJobRow | null>
  // 배치를 끝낸 뒤 소유권을 놓는다 — 다음 Cron이 곧바로 가져갈 수 있게 한다 (만료를 기다리지 않는다).
  readonly releaseLease: (input: Readonly<{ jobId: string; leaseTokenHash: string; nowIso: string }>) => Promise<void>
  // 재개 전용 — partial_completed|interrupted|failed → queued. 관리자 인증 서버 액션에서만 호출된다.
  readonly reviveJob: (input: Readonly<{ jobId: string; nowIso: string }>) => Promise<SyncJobRow | null>
  // 아래 두 쓰기는 lease 보유자만 통과한다. false면 lease를 잃은 것이므로 호출자는 즉시 손을 뗀다.
  readonly recordProgress: (input: Readonly<{ jobId: string; leaseTokenHash: string; progress: SyncJobProgress; nowIso: string }>) => Promise<boolean>
  readonly finishJob: (
    input: Readonly<{
      jobId: string
      leaseTokenHash: string
      status: SyncJobStatus
      nowIso: string
      errorCode?: string | null
      errorMessage?: string | null
      sessionStopReason?: SessionStopReason | null
    }>,
  ) => Promise<boolean>
  // 배치가 예기치 못하게 터졌을 때의 표식 — lease 보유자일 때만 찍는다
  // (lease가 이미 넘어갔다면 남의 진행을 덮지 않는다).
  readonly markInterrupted: (
    input: Readonly<{ jobId: string; errorCode: string; nowIso: string; errorMessage?: string | null; leaseTokenHash?: string }>,
  ) => Promise<void>
  // 사용자 중단 요청 — 진행 중 job에 표식만 남긴다 (진행 중 배치는 끝까지 처리하고 후속 job을 만들지 않는다).
  readonly requestCancel: (jobId: string) => Promise<SyncJobRow | null>
}

export type SheetLastRowReader = () => Promise<Readonly<{ sheetName: string; lastRow: number }>>
export type SheetRangeReader = (
  input: Readonly<{ startRow: number; limit: number }>,
) => Promise<Readonly<{ sheetName: string; startRow: number; rows: readonly Record<string, string | undefined>[] }>>

export type BatchRunner = (
  input: Readonly<{ rows: readonly Record<string, string | undefined>[]; sheetName: string; firstDataRowNumber: number; jobId: string; batchIndex: number }>,
) => Promise<SyncSummary>

export type SyncJobDependencies = {
  readonly repository: SyncJobRepository
  readonly readSheetLastRow: SheetLastRowReader
  readonly readSheetRange: SheetRangeReader
  readonly runBatch: BatchRunner
  readonly latestSourceRowNumber: (sheetName: string) => Promise<number | null>
}

// 배치 1회의 결과. 다음 배치를 어떻게 이어갈지에 대한 정보는 담지 않는다 —
// 이어가는 주체는 이 함수도, 이 함수를 부른 요청도 아니라 다음 Cron 호출이다.
export type SyncTickResult = {
  readonly outcome: SyncTickOutcome
}

// ── 시작 ─────────────────────────────────────────────────────────
export type StartSyncJobResult =
  // freshWindow: 상한·만료된 실행 창을 되살리는 대신 새 창(child job)을 만들었다.
  | { readonly kind: "started"; readonly jobId: string; readonly remaining: number; readonly freshWindow?: boolean }
  | { readonly kind: "already-active"; readonly jobId: string }
  | { readonly kind: "nothing-to-sync" }
  // 시트가 기록보다 짧다 — 행번호를 복구하기 전에는 시작하지 않는다.
  | { readonly kind: "row-number-drift"; readonly drift: RowNumberDrift }
  | { readonly kind: "failed"; readonly reason: string }

export async function startSyncJob(
  dependencies: SyncJobDependencies,
  input: Readonly<{ createdBy: string | null; nowIso: string }>,
): Promise<StartSyncJobResult> {
  const active = await dependencies.repository.findActiveJob()
  if (active !== null) {
    return { kind: "already-active", jobId: active.id }
  }

  // 시작 시점에는 마지막 행 번호만 있으면 된다 — 전체 시트를 내려받지 않는다.
  const sheet = await dependencies.readSheetLastRow()
  const maxSourceRowNumber = await dependencies.latestSourceRowNumber(sheet.sheetName)

  // drift 판정은 잔여 계산보다 먼저다. 순서가 바뀌면 잔여 0으로 계산돼
  // "미동기화 없음"이라는 틀린 안심 메시지로 끝난다 — drift가 정상 완료로 위장되는 경로.
  const drift = detectRowNumberDrift({ latestSheetRow: sheet.lastRow, maxSourceRowNumber })
  if (drift.kind === "drift") {
    return { kind: "row-number-drift", drift: drift.drift }
  }

  const startRow = firstUnsyncedRowNumber(maxSourceRowNumber)
  const remaining = remainingRowCount(startRow, sheet.lastRow)
  if (remaining === 0) {
    return { kind: "nothing-to-sync" }
  }

  // job은 queued로만 만든다 — 배치는 다음 Cron 호출이 claim해서 돌린다.
  // 이 요청(버튼 클릭)은 배치를 직접 처리하지도, 어디에도 발사하지도 않는다.
  const job = await dependencies.repository.createJob({
    sourceSheetName: sheet.sheetName,
    createdBy: input.createdBy,
    startRow,
    targetLastRow: sheet.lastRow,
    remaining,
    chainIndex: 0,
    autoContinued: false,
    sessionStartedAt: input.nowIso,
    totalSessionProcessed: 0,
    maxAutoJobs: SYNC_SESSION_MAX_AUTO_JOBS,
  })
  if (job === null) {
    // 진행 중 job 유니크 인덱스 충돌 — 동시 클릭에서 진 쪽이다. 새 job을 만들지 않는다.
    const current = await dependencies.repository.findActiveJob()
    return current === null ? { kind: "failed", reason: "create-failed" } : { kind: "already-active", jobId: current.id }
  }
  // 최초 job은 자기 자신이 세션 root다.
  await dependencies.repository.setRootToSelf(job.id)
  return { kind: "started", jobId: job.id, remaining }
}

// ── 재개 ─────────────────────────────────────────────────────────
// 오류·정체·전역 상한으로 멈춘 세션을 사용자가 1회 클릭으로 이어서 진행한다.
//
// 되살릴 수 있는 job과 되살려선 안 되는 job을 구분한다:
//  · 일시적 중단(배치 실패·정체) → 같은 job을 되살린다. 커서·집계가 그대로 이어진다.
//  · job 배치 상한 도달 또는 실행 창(6시간) 만료 → 되살리면 다음 tick이 즉시 같은 상한에 다시 걸려
//    "처리 0으로 종료"를 무한 반복한다. 그래서 같은 root 아래 새 child job을 만들어 창을 새로 연다.
//    (2026-07-30 실측: session_started_at이 23시간 전이라 되살리는 순간 6시간 상한에 걸리는 상태였다.)
export async function resumeSyncJob(
  dependencies: SyncJobDependencies,
  input: Readonly<{ jobId: string; nowIso: string; createdBy?: string | null }>,
): Promise<StartSyncJobResult> {
  const active = await dependencies.repository.findActiveJob()
  if (active !== null) {
    return { kind: "already-active", jobId: active.id }
  }
  const job = await dependencies.repository.findJobById(input.jobId)
  if (job === null) {
    return { kind: "failed", reason: "unknown-job" }
  }

  // 재개도 같은 게이트를 통과해야 한다 — drift가 남아 있으면 재개해도 같은 유실이 반복된다.
  const sheet = await dependencies.readSheetLastRow()
  const drift = detectRowNumberDrift({
    latestSheetRow: sheet.lastRow,
    maxSourceRowNumber: await dependencies.latestSourceRowNumber(sheet.sheetName),
  })
  if (drift.kind === "drift") {
    return { kind: "row-number-drift", drift: drift.drift }
  }

  if (job.remaining_count === 0) {
    return { kind: "nothing-to-sync" }
  }

  if (!RESUMABLE_SYNC_JOB_STATUSES.includes(job.status)) {
    return { kind: "failed", reason: "not-resumable" }
  }

  // 되살려도 즉시 같은 상한에 다시 걸리는 job인지 판정한다.
  const atJobLimit = job.batch_index >= SYNC_JOB_MAX_BATCHES || job.processed_count >= SYNC_JOB_MAX_ROWS
  const windowExpired = sessionElapsedMs(job.session_started_at, input.nowIso) >= SYNC_SESSION_MAX_ELAPSED_MS

  if (atJobLimit || windowExpired) {
    // 새 실행 창 — 커서만 물려받고 배치 번호·집계·창 시작 시각은 새로 시작한다.
    // 세션 누적은 root 기준 합산으로 화면에 계속 보이므로 처리분이 사라지지 않는다.
    const remaining = remainingRowCount(job.current_row, sheet.lastRow)
    if (remaining === 0) {
      return { kind: "nothing-to-sync" }
    }
    const child = await dependencies.repository.createJob({
      sourceSheetName: job.source_sheet_name,
      createdBy: input.createdBy ?? null,
      startRow: job.current_row,
      targetLastRow: sheet.lastRow,
      remaining,
      rootJobId: job.root_job_id ?? job.id,
      parentJobId: job.id,
      chainIndex: job.chain_index + 1,
      // 사용자가 직접 시작한 창이므로 자동 후속 예산(max_auto_jobs)을 소모하지 않는다.
      autoContinued: false,
      sessionStartedAt: input.nowIso,
      totalSessionProcessed: 0,
      maxAutoJobs: job.max_auto_jobs,
      consecutiveErrorCount: 0,
    })
    if (child === null) {
      const current = await dependencies.repository.findActiveJob()
      return current === null ? { kind: "failed", reason: "create-failed" } : { kind: "already-active", jobId: current.id }
    }
    return { kind: "started", jobId: child.id, remaining, freshWindow: true }
  }

  // 일시적 중단 — 같은 job을 queued로 되돌리면 다음 Cron이 같은 커서에서 이어간다.
  const revived = await dependencies.repository.reviveJob({ jobId: job.id, nowIso: input.nowIso })
  if (revived === null) {
    return { kind: "failed", reason: "resume-conflict" }
  }
  return { kind: "started", jobId: job.id, remaining: job.remaining_count }
}

// ── pump claim (실행 소유권 확보) ────────────────────────────────
// 처리 가능한 job 1개를 골라 lease를 건다. 후보 선택과 lease 기록이 한 원자 연산이라
// 같은 순간에 두 pump가 들어와도 승자는 하나뿐이다 (나머지는 idle을 받는다).
export type ClaimPumpLeaseResult =
  | { readonly kind: "claimed"; readonly job: SyncJobRow; readonly leaseTokenHash: string }
  | { readonly kind: "idle" }

export async function claimPumpLease(
  dependencies: SyncJobDependencies,
  input: Readonly<{ nowIso: string }>,
): Promise<ClaimPumpLeaseResult> {
  const minted = mintLeaseToken()
  const job = await dependencies.repository.claimPumpLease({
    leaseTokenHash: minted.tokenHash,
    leaseSeconds: SYNC_PUMP_LEASE_SECONDS,
    nowIso: input.nowIso,
  })
  return job === null ? { kind: "idle" } : { kind: "claimed", job, leaseTokenHash: minted.tokenHash }
}

// ── 배치 1회 실행 ────────────────────────────────────────────────
// lease를 쥔 pump가 정확히 1배치만 처리한다. 끝나면 lease를 놓고 함수는 종료된다 —
// 다음 배치는 다음 Cron 호출이 가져간다. 여기서 자기 자신을 다시 부르는 경로는 없다.
//
// 모든 쓰기는 leaseTokenHash 조건부다. 조건이 깨졌다면(=lease가 만료돼 다른 pump가 이미 가져갔다면)
// 이 워커는 즉시 손을 뗀다 — 커서를 두 번 전진시키거나 남의 진행을 덮지 않는다.
export async function runLeasedBatch(
  dependencies: SyncJobDependencies,
  input: Readonly<{ job: SyncJobRow; leaseTokenHash: string; nowIso: string }>,
): Promise<SyncTickResult> {
  const { job, leaseTokenHash, nowIso } = input

  // 시트 마지막 행은 필요할 때만 다시 확인한다 (창이 소진됐을 때 즉시, 그 외엔 주기적으로).
  // 확인해도 첫 열만 읽으므로 행 payload는 내려받지 않는다.
  let latestSheetRow = job.latest_sheet_row
  if (shouldRecheckSheetLastRow({ currentRow: job.current_row, latestSheetRow, batchIndex: job.batch_index })) {
    try {
      latestSheetRow = (await dependencies.readSheetLastRow()).lastRow
    } catch {
      return { outcome: await failTick(dependencies, job, leaseTokenHash, "sheet-read-failed", nowIso, "interrupted") }
    }
  }

  // 실행 중 시트가 줄었는지 — 이미 처리한 마지막 행(current_row - 1)이 시트 끝을 넘었다면 축소된 것이다.
  // (정상 완료 시점에는 current_row - 1 === latestSheetRow라 걸리지 않는다.)
  const drift = detectRowNumberDrift({ latestSheetRow, maxSourceRowNumber: job.current_row - 1 })
  if (drift.kind === "drift") {
    await dependencies.repository.finishJob({
      jobId: job.id,
      leaseTokenHash,
      status: "interrupted",
      nowIso,
      errorCode: ROW_NUMBER_DRIFT_CODE,
      errorMessage: rowNumberDriftMessage(drift.drift),
    })
    return { outcome: { kind: "row-number-drift", drift: drift.drift } }
  }

  const step = decideNextStep({
    currentRow: job.current_row,
    latestSheetRow,
    batchSize: job.batch_size,
    batchIndex: job.batch_index,
    processedCount: job.processed_count,
  })

  if (step.kind === "completed") {
    return finishOrConfirm(dependencies, job, leaseTokenHash, latestSheetRow, nowIso)
  }

  if (step.kind === "limit-reached") {
    return handleJobLimit(dependencies, job, leaseTokenHash, latestSheetRow, step.remaining, nowIso)
  }

  // ── 실제 처리: 필요한 50행 구간만 읽는다 ──────────────────────
  const window = step.window
  let rows: readonly Record<string, string | undefined>[]
  try {
    rows = (await dependencies.readSheetRange({ startRow: window.startRow, limit: window.count })).rows
  } catch {
    return { outcome: await failTick(dependencies, job, leaseTokenHash, "sheet-read-failed", nowIso, "interrupted") }
  }

  let summary: SyncSummary
  try {
    summary = await dependencies.runBatch({
      rows,
      sheetName: job.source_sheet_name,
      firstDataRowNumber: window.startRow,
      jobId: job.id,
      batchIndex: job.batch_index + 1,
    })
  } catch {
    // 배치 자체가 터진 경우 — 커서를 전진시키지 않고 재개 가능 상태로 남긴다 (같은 창부터 재시도).
    // upsert는 source_key 기준이라 같은 구간을 다시 처리해도 중복 행이 생기지 않는다.
    return { outcome: await failTick(dependencies, job, leaseTokenHash, "batch-failed", nowIso, "failed") }
  }

  // 커서는 "시도한 행 수"만큼 전진한다. 파싱 실패 행에서 멈추면 같은 50건을 무한 반복하게 된다.
  // 구간 조회가 빈 배열을 돌려줘도(시트 뒤쪽이 비어 있는 경우) 창 크기만큼 전진시켜 정체를 막는다.
  const nextRow = window.startRow + window.count
  const remaining = remainingRowCount(nextRow, latestSheetRow)
  const progress: SyncJobProgress = {
    batchIndex: job.batch_index + 1,
    currentRow: nextRow,
    latestSheetRow,
    processedCount: job.processed_count + window.count,
    insertedCount: job.inserted_count + summary.inserted,
    updatedCount: job.updated_count + summary.updated,
    skippedCount: job.skipped_count + summary.skipped,
    failedCount: job.failed_count + summary.failed,
    remainingCount: remaining,
    totalSessionProcessed: job.total_session_processed + window.count,
    // 잔여가 생기면 확인 카운터를 초기화한다 (연속 2회여야 완료).
    zeroRemainingConfirmations: remaining === 0 ? 1 : 0,
    // 배치가 성공했으므로 연속 오류 카운터를 푼다.
    consecutiveErrorCount: 0,
  }
  const saved = await dependencies.repository.recordProgress({ jobId: job.id, leaseTokenHash, progress, nowIso })
  if (!saved) {
    // lease를 잃은 뒤 뒤늦게 끝난 워커 — 이미 다른 pump가 이 job을 가져갔다. 아무것도 덮지 않는다.
    return { outcome: { kind: "noop", reason: "lease-lost" } }
  }

  // 잔여가 있어도 여기서 다음 배치를 부르지 않는다 — lease를 놓고 다음 Cron에 넘긴다.
  await dependencies.repository.releaseLease({ jobId: job.id, leaseTokenHash, nowIso })
  return { outcome: { kind: "processed", jobStatus: "running", processed: progress.processedCount, remaining } }
}

// ── 잔여 0 확인 (연속 2회여야 완료) ──────────────────────────────
async function finishOrConfirm(
  dependencies: SyncJobDependencies,
  job: SyncJobRow,
  leaseTokenHash: string,
  latestSheetRow: number,
  nowIso: string,
): Promise<SyncTickResult> {
  const confirmations = job.zero_remaining_confirmations + 1
  const saved = await dependencies.repository.recordProgress({
    jobId: job.id,
    leaseTokenHash,
    progress: progressOf(job, { latestSheetRow, remaining: 0, zeroRemainingConfirmations: confirmations }),
    nowIso,
  })
  if (!saved) {
    return { outcome: { kind: "noop", reason: "lease-lost" } }
  }
  if (confirmations < SYNC_ZERO_REMAINING_CONFIRMATIONS) {
    // 한 번 더 확인한다 — 마지막 배치와 시트 추가 사이의 경합을 흡수한다. 확인도 다음 Cron이 한다.
    await dependencies.repository.releaseLease({ jobId: job.id, leaseTokenHash, nowIso })
    return { outcome: { kind: "processed", jobStatus: "running", processed: job.processed_count, remaining: 0 } }
  }
  await dependencies.repository.finishJob({ jobId: job.id, leaseTokenHash, status: "completed", nowIso })
  return { outcome: { kind: "completed", processed: job.processed_count } }
}

// ── job 상한 도달 → 세션 판정 후 자동 후속 job ───────────────────
async function handleJobLimit(
  dependencies: SyncJobDependencies,
  job: SyncJobRow,
  leaseTokenHash: string,
  latestSheetRow: number,
  remaining: number,
  nowIso: string,
): Promise<SyncTickResult> {
  const saved = await dependencies.repository.recordProgress({
    jobId: job.id,
    leaseTokenHash,
    progress: progressOf(job, { latestSheetRow, remaining }),
    nowIso,
  })
  if (!saved) {
    return { outcome: { kind: "noop", reason: "lease-lost" } }
  }

  const rootJobId = job.root_job_id ?? job.id
  const sessionJobs = await dependencies.repository.listSessionJobs(rootJobId)
  const autoJobCount = sessionJobs.filter((entry) => entry.auto_continued).length
  const continuation = decideSessionContinuation(
    {
      autoJobCount,
      sessionProcessed: job.total_session_processed,
      sessionStartedAt: job.session_started_at,
      consecutiveErrors: job.consecutive_error_count,
      cancelRequested: job.cancel_requested,
      maxAutoJobs: job.max_auto_jobs,
    },
    nowIso,
  )

  if (continuation.kind === "stop") {
    // 전역 상한·취소 — 여기서 멈추고 사용자 재개를 기다린다.
    // 재개는 이 job을 되살리지 않고 새 실행 창을 만든다 (resumeSyncJob 참조).
    await dependencies.repository.finishJob({
      jobId: job.id,
      leaseTokenHash,
      status: continuation.reason === "cancelled" ? "cancelled" : "partial_completed",
      nowIso,
      errorCode: continuation.reason,
      sessionStopReason: continuation.reason,
    })
    return { outcome: { kind: "partial", processed: job.processed_count, remaining } }
  }

  // 정상 backlog — 후속 job을 만들어 queued로 두면 다음 Cron이 그 job을 가져간다 (사용자 클릭 없음).
  // 현재 job을 먼저 닫아야 "진행 중 job 1개" 유니크 인덱스에 걸리지 않는다.
  await dependencies.repository.finishJob({ jobId: job.id, leaseTokenHash, status: "partial_completed", nowIso, errorCode: "batch-limit" })

  const next = await dependencies.repository.createJob({
    sourceSheetName: job.source_sheet_name,
    createdBy: null,
    startRow: job.current_row,
    targetLastRow: latestSheetRow,
    remaining,
    rootJobId,
    parentJobId: job.id,
    chainIndex: job.chain_index + 1,
    autoContinued: true,
    // 같은 세션이므로 실행 창(시작 시각·누적)을 그대로 물려받는다.
    sessionStartedAt: job.session_started_at,
    totalSessionProcessed: job.total_session_processed,
    maxAutoJobs: job.max_auto_jobs,
    consecutiveErrorCount: job.consecutive_error_count,
  })
  if (next === null) {
    // 후속 job 생성 실패 — 처리분은 유지되고 사용자 재개 경로가 남는다.
    return { outcome: { kind: "partial", processed: job.processed_count, remaining } }
  }
  return { outcome: { kind: "processed", jobStatus: "running", processed: job.processed_count, remaining } }
}

// ── 실패 처리 ────────────────────────────────────────────────────
// 같은 오류가 연속으로 쌓이면 세션 자동 진행이 멈춘다 (다음 상한 판정에 쓰인다).
async function failTick(
  dependencies: SyncJobDependencies,
  job: SyncJobRow,
  leaseTokenHash: string,
  errorCode: string,
  nowIso: string,
  status: SyncJobStatus,
): Promise<SyncTickOutcome> {
  const consecutive = job.last_error_code === errorCode ? job.consecutive_error_count + 1 : 1
  await dependencies.repository.recordProgress({
    jobId: job.id,
    leaseTokenHash,
    progress: progressOf(job, { latestSheetRow: job.latest_sheet_row, remaining: job.remaining_count, consecutiveErrorCount: consecutive }),
    nowIso,
  })
  await dependencies.repository.finishJob({ jobId: job.id, leaseTokenHash, status, nowIso, errorCode, errorMessage: null })
  return { kind: "failed", errorCode }
}

// ── 사용자 중단 ──────────────────────────────────────────────────
// 진행 중 배치는 그대로 끝내되 후속 job은 만들지 않는다 (처리분 손실 없음).
export async function cancelSyncSession(
  dependencies: SyncJobDependencies,
  input: Readonly<{ jobId: string }>,
): Promise<{ readonly kind: "cancelled" | "not-active" }> {
  const cancelled = await dependencies.repository.requestCancel(input.jobId)
  return cancelled === null ? { kind: "not-active" } : { kind: "cancelled" }
}

function progressOf(
  job: SyncJobRow,
  patch: Readonly<{ latestSheetRow: number; remaining: number; zeroRemainingConfirmations?: number; consecutiveErrorCount?: number }>,
): SyncJobProgress {
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
    totalSessionProcessed: job.total_session_processed,
    zeroRemainingConfirmations: patch.zeroRemainingConfirmations ?? job.zero_remaining_confirmations,
    consecutiveErrorCount: patch.consecutiveErrorCount ?? job.consecutive_error_count,
  }
}

export { SYNC_JOB_BATCH_SIZE, computeBatchWindow }
