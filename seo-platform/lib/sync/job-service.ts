// Google Sheets 증분 동기화 자동 연속 처리 — 오케스트레이션.
//
// 한 tick = 정확히 50건 1배치. 시트는 필요한 50행 구간만 읽고, 마지막 행 번호만 따로 확인한다
// (전체 시트 payload를 tick마다 다시 내려받지 않는다 — Google API 요청량이 전체 행 수가 아니라
//  batch 수에 비례해야 하기 때문이다).
//
// job 하나는 5,000행에서 끊기지만, 잔여가 있고 세션 전역 상한에 걸리지 않으면 서버가 후속 job을
// 자동으로 만들어 이어간다. 사용자는 시작 버튼을 한 번만 누른다.
//
// 실제 행 처리는 기존 syncSheetRows를 그대로 재사용한다 (파싱·upsert 계획·slug·오류 기록 전부 기존 경로).
// 의존성은 전부 주입받는다 — DB·Google API 없이 단위 테스트할 수 있어야 하기 때문이다.
import {
  computeBatchWindow,
  decideNextStep,
  decideSessionContinuation,
  detectRowNumberDrift,
  firstUnsyncedRowNumber,
  hashTickToken,
  mintTickToken,
  remainingRowCount,
  rowNumberDriftMessage,
  shouldRecheckSheetLastRow,
  verifyTickToken,
  ROW_NUMBER_DRIFT_CODE,
  SYNC_JOB_BATCH_SIZE,
  SYNC_SESSION_MAX_AUTO_JOBS,
  SYNC_ZERO_REMAINING_CONFIRMATIONS,
  type MintedTickToken,
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
  readonly tokenHash: string
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
  // queued|running ∧ 토큰 해시 일치일 때만 성공하는 조건부 UPDATE. 다음 토큰 해시로 회전시킨다.
  readonly claimTick: (input: Readonly<{ jobId: string; expectedTokenHash: string; nextTokenHash: string; nowIso: string }>) => Promise<SyncJobRow | null>
  // 재개 전용 — partial_completed|interrupted|failed → running. 관리자 인증 서버 액션에서만 호출된다.
  readonly reviveJob: (input: Readonly<{ jobId: string; nextTokenHash: string; nowIso: string }>) => Promise<SyncJobRow | null>
  readonly recordProgress: (input: Readonly<{ jobId: string; progress: SyncJobProgress; nowIso: string }>) => Promise<void>
  readonly finishJob: (
    input: Readonly<{ jobId: string; status: SyncJobStatus; nowIso: string; errorCode?: string | null; errorMessage?: string | null; sessionStopReason?: SessionStopReason | null }>,
  ) => Promise<void>
  // expectedTokenHash를 주면 "그 tick이 아직 소진되지 않았을 때만" 찍는 조건부 UPDATE가 된다
  // (접수된 tick을 발사 실패로 오인해 덮는 것을 막는 CAS).
  readonly markInterrupted: (input: Readonly<{ jobId: string; errorCode: string; nowIso: string; expectedTokenHash?: string }>) => Promise<void>
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

export type NextTick = { readonly jobId: string; readonly token: string }

export type SyncTickResult = {
  readonly outcome: SyncTickOutcome
  // 존재하면 route가 after()로 self-chain fetch를 예약한다. 후속 job의 첫 tick도 여기로 나간다.
  readonly nextTick: NextTick | null
}

// ── 시작 ─────────────────────────────────────────────────────────
export type StartSyncJobResult =
  | { readonly kind: "started"; readonly jobId: string; readonly token: string; readonly remaining: number }
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

  const minted = mintTickToken()
  const job = await dependencies.repository.createJob({
    sourceSheetName: sheet.sheetName,
    createdBy: input.createdBy,
    startRow,
    targetLastRow: sheet.lastRow,
    remaining,
    tokenHash: minted.tokenHash,
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
  return { kind: "started", jobId: job.id, token: minted.token, remaining }
}

// ── 재개 ─────────────────────────────────────────────────────────
// 오류·정체·전역 상한으로 멈춘 세션을 사용자가 1회 클릭으로 이어서 진행한다.
// 새 job을 만들지 않고 같은 커서를 이어받는다 (중복 처리 없음).
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

  // 재개는 토큰 원문 없이 진행하는 유일한 경로다 — 그래서 공개 endpoint에는 없고,
  // 관리자 인증을 통과한 서버 액션에서만 호출된다. 여기서 새 토큰을 발급해 chain을 다시 건다.
  const minted = mintTickToken()
  const revived = await dependencies.repository.reviveJob({ jobId: job.id, nextTokenHash: minted.tokenHash, nowIso: input.nowIso })
  if (revived === null) {
    return { kind: "failed", reason: "resume-conflict" }
  }
  return { kind: "started", jobId: job.id, token: minted.token, remaining: job.remaining_count }
}

// ── tick 접수 ────────────────────────────────────────────────────
// 인증·중복 판정·커서 소진(claim)까지만 한다. DB 왕복 2회로 끝나므로 수백 ms다.
// route는 이 단계까지만 응답 전에 처리하고 202를 돌려준다 — 실제 배치(34~43초)는 응답 이후에 돈다.
//
// claim을 응답 전에 두는 것이 핵심이다: 202를 받았다는 사실이 곧 "이 tick이 소진됐다"는 뜻이 되어,
// 발사한 쪽은 토큰 해시 하나로 접수 여부를 확정 판정할 수 있다 (unconfirmedTokenHash 참조).
export type SyncTickAcceptance =
  | { readonly kind: "accepted"; readonly claimed: SyncJobRow; readonly minted: MintedTickToken }
  | { readonly kind: "rejected"; readonly outcome: SyncTickOutcome }

export async function acceptSyncTick(
  dependencies: SyncJobDependencies,
  input: Readonly<{ jobId: string; token: string; nowIso: string }>,
): Promise<SyncTickAcceptance> {
  const job = await dependencies.repository.findJobById(input.jobId)
  if (job === null) {
    return { kind: "rejected", outcome: { kind: "unauthorized", reason: "unknown-job" } }
  }
  if (job.status !== "queued" && job.status !== "running") {
    return { kind: "rejected", outcome: { kind: "noop", reason: `terminal-${job.status}` } }
  }
  if (!verifyTickToken(input.token, job.next_tick_token_hash)) {
    // 이미 회전된 토큰 = 중복·지연 chain. 인증 실패가 아니라 no-op으로 본다 (재시도 유발 금지).
    return { kind: "rejected", outcome: { kind: "noop", reason: "stale-tick-token" } }
  }

  // 원자 소진 — queued|running ∧ 해시 일치일 때만 통과하고, 즉시 다음 토큰으로 회전한다.
  // 같은 요청이 두 번 도착해도(재전송·중복 발사) 두 번째는 해시 불일치로 여기서 걸러진다.
  const minted = mintTickToken()
  const claimed = await dependencies.repository.claimTick({
    jobId: job.id,
    expectedTokenHash: hashTickToken(input.token),
    nextTokenHash: minted.tokenHash,
    nowIso: input.nowIso,
  })
  if (claimed === null) {
    return { kind: "rejected", outcome: { kind: "noop", reason: "duplicate-tick" } }
  }
  return { kind: "accepted", claimed, minted }
}

// ── tick 배치 실행 ───────────────────────────────────────────────
// 접수가 끝난 tick의 실제 1배치. route에서는 응답을 보낸 뒤 after()에서 호출된다.
export async function runSyncTickBatch(
  dependencies: SyncJobDependencies,
  input: Readonly<{ claimed: SyncJobRow; minted: MintedTickToken; nowIso: string }>,
): Promise<SyncTickResult> {
  const { claimed, minted } = input

  // 시트 마지막 행은 필요할 때만 다시 확인한다 (창 소진 시 즉시, 그 외엔 주기적으로).
  // 확인해도 첫 열만 읽으므로 행 payload는 내려받지 않는다.
  let latestSheetRow = claimed.latest_sheet_row
  if (shouldRecheckSheetLastRow({ currentRow: claimed.current_row, latestSheetRow, batchIndex: claimed.batch_index })) {
    try {
      latestSheetRow = (await dependencies.readSheetLastRow()).lastRow
    } catch {
      return noChain(await failTick(dependencies, claimed, "sheet-read-failed", input.nowIso, "interrupted"))
    }
  }

  // 실행 중 시트가 줄었는지 — 이미 처리한 마지막 행(current_row - 1)이 시트 끝을 넘었다면 축소된 것이다.
  // (정상 완료 시점에는 current_row - 1 === latestSheetRow라 걸리지 않는다.)
  // 추가 DB 조회 없이 판정하고, 걸리면 여기서 멈춘다 — 후속 job도 다음 tick 토큰도 만들지 않는다.
  const drift = detectRowNumberDrift({ latestSheetRow, maxSourceRowNumber: claimed.current_row - 1 })
  if (drift.kind === "drift") {
    await dependencies.repository.finishJob({
      jobId: claimed.id,
      status: "interrupted",
      nowIso: input.nowIso,
      errorCode: ROW_NUMBER_DRIFT_CODE,
      errorMessage: rowNumberDriftMessage(drift.drift),
    })
    return noChain({ kind: "row-number-drift", drift: drift.drift })
  }

  const step = decideNextStep({
    currentRow: claimed.current_row,
    latestSheetRow,
    batchSize: claimed.batch_size,
    batchIndex: claimed.batch_index,
    processedCount: claimed.processed_count,
  })

  if (step.kind === "completed") {
    return finishOrConfirm(dependencies, claimed, latestSheetRow, input.nowIso, minted)
  }

  if (step.kind === "limit-reached") {
    return handleJobLimit(dependencies, claimed, latestSheetRow, step.remaining, input.nowIso)
  }

  // ── 실제 처리: 필요한 50행 구간만 읽는다 ──────────────────────
  const window = step.window
  let rows: readonly Record<string, string | undefined>[]
  try {
    rows = (await dependencies.readSheetRange({ startRow: window.startRow, limit: window.count })).rows
  } catch {
    return noChain(await failTick(dependencies, claimed, "sheet-read-failed", input.nowIso, "interrupted"))
  }

  let summary: SyncSummary
  try {
    summary = await dependencies.runBatch({
      rows,
      sheetName: claimed.source_sheet_name,
      firstDataRowNumber: window.startRow,
      jobId: claimed.id,
      batchIndex: claimed.batch_index + 1,
    })
  } catch {
    // 배치 자체가 터진 경우 — 커서를 전진시키지 않고 재개 가능 상태로 남긴다 (같은 창부터 재시도).
    return noChain(await failTick(dependencies, claimed, "batch-failed", input.nowIso, "failed"))
  }

  // 커서는 "시도한 행 수"만큼 전진한다. 파싱 실패 행에서 멈추면 같은 50건을 무한 반복하게 된다.
  // 구간 조회가 빈 배열을 돌려줘도(시트 뒤쪽이 비어 있는 경우) 창 크기만큼 전진시켜 정체를 막는다.
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
    totalSessionProcessed: claimed.total_session_processed + window.count,
    // 잔여가 생기면 확인 카운터를 초기화한다 (연속 2회여야 완료).
    zeroRemainingConfirmations: remaining === 0 ? 1 : 0,
    // 배치가 성공했으므로 연속 오류 카운터를 푼다.
    consecutiveErrorCount: 0,
  }
  await dependencies.repository.recordProgress({ jobId: claimed.id, progress, nowIso: input.nowIso })

  // 잔여 0이어도 즉시 닫지 않는다 — 다음 tick에서 시트를 다시 확인해 2회 연속이면 완료한다.
  return { outcome: { kind: "processed", jobStatus: "running", processed: progress.processedCount, remaining }, nextTick: { jobId: claimed.id, token: minted.token } }
}

// 접수 + 배치를 한 번에 — 기존 호출자와 단위 테스트가 쓰는 합성 경로다.
// Production route는 이 함수를 쓰지 않는다 (응답을 배치 완료까지 붙잡지 않기 위해 두 단계를 나눠 호출한다).
export async function executeSyncTick(
  dependencies: SyncJobDependencies,
  input: Readonly<{ jobId: string; token: string; nowIso: string }>,
): Promise<SyncTickResult> {
  const acceptance = await acceptSyncTick(dependencies, input)
  if (acceptance.kind === "rejected") {
    return noChain(acceptance.outcome)
  }
  return runSyncTickBatch(dependencies, { claimed: acceptance.claimed, minted: acceptance.minted, nowIso: input.nowIso })
}

// ── 잔여 0 확인 (연속 2회여야 완료) ──────────────────────────────
async function finishOrConfirm(
  dependencies: SyncJobDependencies,
  job: SyncJobRow,
  latestSheetRow: number,
  nowIso: string,
  minted: Readonly<{ token: string }>,
): Promise<SyncTickResult> {
  const confirmations = job.zero_remaining_confirmations + 1
  await dependencies.repository.recordProgress({
    jobId: job.id,
    progress: progressOf(job, { latestSheetRow, remaining: 0, zeroRemainingConfirmations: confirmations }),
    nowIso,
  })
  if (confirmations < SYNC_ZERO_REMAINING_CONFIRMATIONS) {
    // 한 번 더 확인한다 — 마지막 배치와 시트 추가 사이의 경합을 흡수한다.
    return { outcome: { kind: "processed", jobStatus: "running", processed: job.processed_count, remaining: 0 }, nextTick: { jobId: job.id, token: minted.token } }
  }
  await dependencies.repository.finishJob({ jobId: job.id, status: "completed", nowIso })
  return noChain({ kind: "completed", processed: job.processed_count })
}

// ── job 상한 도달 → 세션 판정 후 자동 후속 job ───────────────────
async function handleJobLimit(
  dependencies: SyncJobDependencies,
  job: SyncJobRow,
  latestSheetRow: number,
  remaining: number,
  nowIso: string,
): Promise<SyncTickResult> {
  await dependencies.repository.recordProgress({ jobId: job.id, progress: progressOf(job, { latestSheetRow, remaining }), nowIso })

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
    await dependencies.repository.finishJob({
      jobId: job.id,
      status: continuation.reason === "cancelled" ? "cancelled" : "partial_completed",
      nowIso,
      errorCode: continuation.reason,
      sessionStopReason: continuation.reason,
    })
    return noChain({ kind: "partial", processed: job.processed_count, remaining })
  }

  // 정상 backlog — 후속 job을 서버가 만들고 chain을 이어 붙인다 (사용자 클릭 없음).
  // 현재 job을 먼저 닫아야 "진행 중 job 1개" 유니크 인덱스에 걸리지 않는다.
  await dependencies.repository.finishJob({ jobId: job.id, status: "partial_completed", nowIso, errorCode: "batch-limit" })

  const minted = mintTickToken()
  const next = await dependencies.repository.createJob({
    sourceSheetName: job.source_sheet_name,
    createdBy: null,
    startRow: job.current_row,
    targetLastRow: latestSheetRow,
    remaining,
    tokenHash: minted.tokenHash,
    rootJobId,
    parentJobId: job.id,
    chainIndex: job.chain_index + 1,
    autoContinued: true,
    sessionStartedAt: job.session_started_at,
    totalSessionProcessed: job.total_session_processed,
    maxAutoJobs: job.max_auto_jobs,
    consecutiveErrorCount: job.consecutive_error_count,
  })
  if (next === null) {
    // 후속 job 생성 실패 — 자동 진행만 멈추고 처리분은 유지한다. 사용자 재개 경로가 남는다.
    return noChain({ kind: "partial", processed: job.processed_count, remaining })
  }
  return { outcome: { kind: "processed", jobStatus: "running", processed: job.processed_count, remaining }, nextTick: { jobId: next.id, token: minted.token } }
}

// ── 실패 처리 ────────────────────────────────────────────────────
// 같은 오류가 연속으로 쌓이면 세션 자동 진행이 멈춘다 (다음 시작 때 판정에 쓰인다).
async function failTick(
  dependencies: SyncJobDependencies,
  job: SyncJobRow,
  errorCode: string,
  nowIso: string,
  status: SyncJobStatus,
): Promise<SyncTickOutcome> {
  const consecutive = job.last_error_code === errorCode ? job.consecutive_error_count + 1 : 1
  await dependencies.repository.recordProgress({
    jobId: job.id,
    progress: progressOf(job, { latestSheetRow: job.latest_sheet_row, remaining: job.remaining_count, consecutiveErrorCount: consecutive }),
    nowIso,
  })
  await dependencies.repository.finishJob({ jobId: job.id, status, nowIso, errorCode, errorMessage: null })
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

function noChain(outcome: SyncTickOutcome): SyncTickResult {
  return { outcome, nextTick: null }
}

export { SYNC_JOB_BATCH_SIZE, computeBatchWindow }
