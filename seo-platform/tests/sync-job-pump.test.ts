// 자동 연속 동기화 Cron pull(pump) — 범위 조회·자동 후속 job·세션 상한·커서·lease 회귀 방어.
// Google API·Supabase는 전부 주입 mock이다 (실제 동기화·DB 쓰기·시트 조회 0건).
//
// 이 구조에는 self-fetch가 없다. 한 Cron 호출 = lease claim 1회 + 배치 1회이며,
// 진행은 pumpOnce()를 반복 호출하는 것으로 재현한다 (실제로는 다음 Cron 주기가 그 역할을 한다).
import { readFileSync, readdirSync } from "node:fs"

import { describe, expect, it } from "vitest"

import {
  computeBatchWindow,
  decideNextStep,
  decideSessionContinuation,
  firstUnsyncedRowNumber,
  hashLeaseToken,
  mintLeaseToken,
  isStaleTick,
  lastSheetRowNumber,
  parseSyncTickRequest,
  PUMP_BATCH_CRASHED_CODE,
  remainingRowCount,
  resolveSyncPumpEnvironment,
  safeSyncResponseBody,
  httpStatusForSyncOutcome,
  shouldRecheckSheetLastRow,
  verifyPumpSecret,
  SYNC_JOB_BATCH_SIZE,
  SYNC_JOB_MAX_BATCHES,
  SYNC_JOB_MAX_ROWS,
  SYNC_SESSION_MAX_AUTO_JOBS,
  SYNC_SESSION_MAX_ROWS,
} from "@/lib/sync/job-policy"
import { lastRowFromKeyColumns, nextColumnLetter, parseColumnBounds } from "@/lib/sync/google-sheets-values"
import { SHEET_COLUMNS, SYNC_JOB_STATUSES, SYNC_SESSION_STOP_REASONS } from "@/lib/domain/constants"
import { SheetRowSchema } from "@/lib/domain/sheet-row"
import {
  cancelSyncSession,
  claimPumpLease,
  resumeSyncJob,
  runLeasedBatch,
  startSyncJob,
  type SyncJobDependencies,
  type SyncJobRow,
} from "@/lib/sync/job-service"
import type { SyncSummary } from "@/lib/sync/types"

const ROOT_ID = "11111111-1111-4111-8111-111111111111"

function makeJob(patch: Partial<SyncJobRow> = {}): SyncJobRow {
  return {
    id: ROOT_ID,
    status: "queued",
    source_sheet_name: "기업 DB",
    batch_size: SYNC_JOB_BATCH_SIZE,
    start_row: 2,
    current_row: 2,
    target_last_row: 1,
    latest_sheet_row: 1,
    batch_index: 0,
    processed_count: 0,
    inserted_count: 0,
    updated_count: 0,
    skipped_count: 0,
    failed_count: 0,
    remaining_count: 0,
    root_job_id: ROOT_ID,
    parent_job_id: null,
    chain_index: 0,
    auto_continued: false,
    session_started_at: "2026-07-29T00:00:00.000Z",
    total_session_processed: 0,
    max_auto_jobs: SYNC_SESSION_MAX_AUTO_JOBS,
    consecutive_error_count: 0,
    zero_remaining_confirmations: 0,
    cancel_requested: false,
    session_stop_reason: null,
    lease_token_hash: null,
    lease_expires_at: null,
    pump_attempt: 0,
    started_at: "2026-07-29T00:00:00.000Z",
    last_tick_at: null,
    finished_at: null,
    last_error_code: null,
    last_error_message: null,
    ...patch,
  }
}

type HarnessState = {
  jobs: Map<string, SyncJobRow>
  activeId: string | null
  sheetRowCount: number
  nextId: number
  batchCalls: { firstDataRowNumber: number; count: number; batchIndex: number; jobId: string }[]
  rangeReads: { startRow: number; limit: number }[]
  lastRowReads: number
}

type Harness = {
  readonly dependencies: SyncJobDependencies
  readonly state: HarnessState
  readonly setSheetRows: (count: number) => void
  readonly job: (id?: string) => SyncJobRow | undefined
  readonly sessionJobs: () => readonly SyncJobRow[]
  readonly rowsFetched: () => number
}

function createHarness(
  options: Readonly<{
    job?: SyncJobRow | null
    sheetRowCount?: number
    latestSourceRowNumber?: number | null
    summary?: Partial<SyncSummary>
    runBatchThrows?: boolean
    readSheetThrows?: boolean
  }> = {},
): Harness {
  const state: HarnessState = {
    jobs: new Map<string, SyncJobRow>(),
    activeId: null,
    sheetRowCount: options.sheetRowCount ?? 0,
    nextId: 2,
    batchCalls: [],
    rangeReads: [],
    lastRowReads: 0,
  }
  if (options.job !== undefined && options.job !== null) {
    state.jobs.set(options.job.id, options.job)
    state.activeId = options.job.status === "queued" || options.job.status === "running" ? options.job.id : null
  }

  const activeJob = (): SyncJobRow | null => {
    for (const entry of state.jobs.values()) {
      if (entry.status === "queued" || entry.status === "running") {
        return entry
      }
    }
    return null
  }
  const patch = (id: string, next: Partial<SyncJobRow>): void => {
    const current = state.jobs.get(id)
    if (current !== undefined) {
      state.jobs.set(id, { ...current, ...next })
    }
  }

  const dependencies: SyncJobDependencies = {
    repository: {
      findActiveJob: () => Promise.resolve(activeJob()),
      findJobById: (jobId) => Promise.resolve(state.jobs.get(jobId) ?? null),
      findLatestJob: () => Promise.resolve([...state.jobs.values()].at(-1) ?? null),
      listSessionJobs: (rootJobId) => Promise.resolve([...state.jobs.values()].filter((entry) => (entry.root_job_id ?? entry.id) === rootJobId)),
      createJob: (input) => {
        // 진행 중 job이 있으면 유니크 인덱스가 막는다 (실제 DB와 동일하게 null 반환).
        if (activeJob() !== null) {
          return Promise.resolve(null)
        }
        const id = `${String(state.nextId)}2222222-2222-4222-8222-222222222222`
        state.nextId += 1
        const job = makeJob({
          id,
          status: "queued",
          source_sheet_name: input.sourceSheetName,
          start_row: input.startRow,
          current_row: input.startRow,
          target_last_row: input.targetLastRow,
          latest_sheet_row: input.targetLastRow,
          remaining_count: input.remaining,
          root_job_id: input.rootJobId ?? null,
          parent_job_id: input.parentJobId ?? null,
          chain_index: input.chainIndex ?? 0,
          auto_continued: input.autoContinued ?? false,
          session_started_at: input.sessionStartedAt ?? "2026-07-29T00:00:00.000Z",
          total_session_processed: input.totalSessionProcessed ?? 0,
          max_auto_jobs: input.maxAutoJobs ?? SYNC_SESSION_MAX_AUTO_JOBS,
          consecutive_error_count: input.consecutiveErrorCount ?? 0,
        })
        state.jobs.set(id, job)
        return Promise.resolve(job)
      },
      setRootToSelf: (jobId) => {
        const current = state.jobs.get(jobId)
        if (current?.root_job_id === null) {
          state.jobs.set(jobId, { ...current, root_job_id: jobId })
        }
        return Promise.resolve()
      },
      // 실제 RPC와 같은 규칙: 진행 중 ∧ lease 없음/만료 인 후보 1개를 결정론적 순서로 골라 lease를 건다.
      claimPumpLease: (input) => {
        const nowMs = Date.parse(input.nowIso)
        const candidate = [...state.jobs.values()]
          .filter((job) => job.status === "queued" || job.status === "running")
          .filter((job) => job.lease_expires_at === null || Date.parse(job.lease_expires_at) <= nowMs)
          .sort((a, b) => a.chain_index - b.chain_index || a.id.localeCompare(b.id))
          .at(0)
        if (candidate === undefined) {
          return Promise.resolve(null)
        }
        patch(candidate.id, {
          status: "running",
          lease_token_hash: input.leaseTokenHash,
          lease_expires_at: new Date(nowMs + input.leaseSeconds * 1000).toISOString(),
          last_tick_at: input.nowIso,
          pump_attempt: candidate.pump_attempt + 1,
          finished_at: null,
        })
        return Promise.resolve(state.jobs.get(candidate.id) ?? null)
      },
      releaseLease: (input) => {
        const current = state.jobs.get(input.jobId)
        if (current?.lease_token_hash === input.leaseTokenHash) {
          patch(input.jobId, { lease_token_hash: null, lease_expires_at: null, last_tick_at: input.nowIso })
        }
        return Promise.resolve()
      },
      reviveJob: (input) => {
        const current = state.jobs.get(input.jobId)
        if (current === undefined || !["partial_completed", "interrupted", "failed"].includes(current.status)) {
          return Promise.resolve(null)
        }
        // running이 아니라 queued로 되돌린다 — 배치를 도는 주체는 다음 Cron이다.
        patch(input.jobId, {
          status: "queued",
          last_tick_at: input.nowIso,
          finished_at: null,
          last_error_code: null,
          session_stop_reason: null,
          lease_token_hash: null,
          lease_expires_at: null,
        })
        return Promise.resolve(state.jobs.get(input.jobId) ?? null)
      },
      recordProgress: (input) => {
        // lease 보유자만 쓴다 — 잃었으면 0행(false)이다.
        if (state.jobs.get(input.jobId)?.lease_token_hash !== input.leaseTokenHash) {
          return Promise.resolve(false)
        }
        patch(input.jobId, {
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
        return Promise.resolve(true)
      },
      finishJob: (input) => {
        if (state.jobs.get(input.jobId)?.lease_token_hash !== input.leaseTokenHash) {
          return Promise.resolve(false)
        }
        patch(input.jobId, {
          status: input.status,
          finished_at: input.nowIso,
          last_error_code: input.errorCode ?? null,
          last_error_message: input.errorMessage ?? null,
          session_stop_reason: input.sessionStopReason ?? null,
          lease_token_hash: null,
          lease_expires_at: null,
        })
        return Promise.resolve(true)
      },
      markInterrupted: (input) => {
        const current = state.jobs.get(input.jobId)
        if (current === undefined || (current.status !== "queued" && current.status !== "running")) {
          return Promise.resolve()
        }
        // 실제 조건부 UPDATE와 같은 조건 — lease가 이미 넘어갔으면 0행을 건드린다.
        if (input.leaseTokenHash !== undefined && current.lease_token_hash !== input.leaseTokenHash) {
          return Promise.resolve()
        }
        patch(input.jobId, {
          status: "interrupted",
          last_error_code: input.errorCode,
          last_error_message: input.errorMessage ?? null,
          finished_at: input.nowIso,
          lease_token_hash: null,
          lease_expires_at: null,
        })
        return Promise.resolve()
      },
      requestCancel: (jobId) => {
        const current = state.jobs.get(jobId)
        if (current === undefined || (current.status !== "queued" && current.status !== "running")) {
          return Promise.resolve(null)
        }
        patch(jobId, { cancel_requested: true })
        return Promise.resolve(state.jobs.get(jobId) ?? null)
      },
    },
    readSheetLastRow: () => {
      state.lastRowReads += 1
      if (options.readSheetThrows === true) {
        return Promise.reject(new Error("sheet read failed"))
      }
      return Promise.resolve({ sheetName: "기업 DB", lastRow: lastSheetRowNumber(state.sheetRowCount) })
    },
    readSheetRange: (input) => {
      state.rangeReads.push({ startRow: input.startRow, limit: input.limit })
      // 시트에 실제로 존재하는 행만 돌려준다 (구간이 시트 끝을 넘으면 짧아진다).
      const available = Math.max(0, lastSheetRowNumber(state.sheetRowCount) - input.startRow + 1)
      const count = Math.min(input.limit, available)
      return Promise.resolve({
        sheetName: "기업 DB",
        startRow: input.startRow,
        rows: Array.from({ length: count }, (_, index) => ({ 회사명: `장소 ${String(input.startRow + index)}` })),
      })
    },
    latestSourceRowNumber: () => Promise.resolve(options.latestSourceRowNumber ?? null),
    runBatch: (input) => {
      if (options.runBatchThrows === true) {
        return Promise.reject(new Error("batch failed"))
      }
      state.batchCalls.push({ firstDataRowNumber: input.firstDataRowNumber, count: input.rows.length, batchIndex: input.batchIndex, jobId: input.jobId })
      return Promise.resolve({
        runId: `run-${String(input.batchIndex)}`,
        totalRows: input.rows.length,
        inserted: options.summary?.inserted ?? input.rows.length,
        updated: options.summary?.updated ?? 0,
        skipped: options.summary?.skipped ?? 0,
        failed: options.summary?.failed ?? 0,
      })
    },
  }

  return {
    dependencies,
    state,
    setSheetRows: (count: number) => {
      state.sheetRowCount = count
    },
    job: (id?: string) => (id === undefined ? [...state.jobs.values()].at(-1) : state.jobs.get(id)),
    sessionJobs: () => [...state.jobs.values()],
    rowsFetched: () => state.rangeReads.reduce((total, read) => total + read.limit, 0),
  }
}

// Cron 1회 호출 = lease claim 1회 + 배치 1회. 자기 호출이 없으므로 "다음 tick"을 따라가는 대신
// 스케줄러가 다시 부르는 것을 pumpOnce 반복으로 재현한다. 처리 대상이 없으면 idle로 끝난다.
const NOW = "2026-07-29T00:00:00.000Z"

async function pumpOnce(harness: Harness, nowIso: string = NOW): Promise<{ claimed: boolean; outcomeKind: string; jobId: string | null }> {
  const claim = await claimPumpLease(harness.dependencies, { nowIso })
  if (claim.kind !== "claimed") {
    return { claimed: false, outcomeKind: "idle", jobId: null }
  }
  const result = await runLeasedBatch(harness.dependencies, { job: claim.job, leaseTokenHash: claim.leaseTokenHash, nowIso })
  return { claimed: true, outcomeKind: result.outcome.kind, jobId: claim.job.id }
}

// 잔여가 없어질 때까지 Cron을 계속 돌린다.
async function drain(harness: Harness, maxTicks = 2000): Promise<{ ticks: number; lastOutcomeKind: string }> {
  let ticks = 0
  let lastOutcomeKind = "none"
  for (let i = 0; i < maxTicks; i += 1) {
    const tick = await pumpOnce(harness)
    if (!tick.claimed) {
      break
    }
    ticks += 1
    lastOutcomeKind = tick.outcomeKind
  }
  return { ticks, lastOutcomeKind }
}

async function startAndDrain(harness: Harness): Promise<{ ticks: number; lastOutcomeKind: string }> {
  const started = await startSyncJob(harness.dependencies, { createdBy: null, nowIso: NOW })
  if (started.kind !== "started") {
    throw new Error(`expected started, got ${started.kind}`)
  }
  return drain(harness)
}

describe("커서 계산", () => {
  it("시트 행 수를 마지막 데이터 행 번호로 환산한다 (1행은 헤더)", () => {
    expect(lastSheetRowNumber(0)).toBe(1)
    expect(lastSheetRowNumber(1)).toBe(2)
    expect(lastSheetRowNumber(14_951)).toBe(14_952)
  })

  it("places의 max(source_row_number)에서 다음 미동기화 행을 정한다", () => {
    expect(firstUnsyncedRowNumber(null)).toBe(2)
    expect(firstUnsyncedRowNumber(undefined)).toBe(2)
    expect(firstUnsyncedRowNumber(100)).toBe(101)
  })

  it("잔여 행 수는 음수가 되지 않는다", () => {
    expect(remainingRowCount(2, 1)).toBe(0)
    expect(remainingRowCount(2, 51)).toBe(50)
    expect(remainingRowCount(60, 51)).toBe(0)
  })

  it("배치 창은 잔여와 상한 예산 중 작은 쪽을 따른다", () => {
    expect(computeBatchWindow({ currentRow: 2, latestSheetRow: 1000, batchSize: 50, processedCount: 0 })).toEqual({ startRow: 2, startIndex: 0, count: 50 })
    expect(computeBatchWindow({ currentRow: 2, latestSheetRow: 11, batchSize: 50, processedCount: 0 })).toEqual({ startRow: 2, startIndex: 0, count: 10 })
    expect(computeBatchWindow({ currentRow: 2, latestSheetRow: 9999, batchSize: 50, processedCount: 4980 }).count).toBe(20)
  })

  it("잔여 0이면 완료, job 상한 도달이면 limit-reached로 판정한다", () => {
    expect(decideNextStep({ currentRow: 2, latestSheetRow: 1, batchSize: 50, batchIndex: 0, processedCount: 0 })).toEqual({ kind: "completed" })
    expect(decideNextStep({ currentRow: 2, latestSheetRow: 500, batchSize: 50, batchIndex: SYNC_JOB_MAX_BATCHES, processedCount: SYNC_JOB_MAX_ROWS })).toEqual({
      kind: "limit-reached",
      remaining: 499,
    })
  })
})

describe("Sheet 범위 조회 (전체 재조회 제거)", () => {
  it("의존성 계약에 전체 시트 조회가 아예 없다", () => {
    const harness = createHarness({ sheetRowCount: 15_000 })
    // 전체 payload를 받는 readSheet 자체가 없어 호출할 방법이 없다.
    expect(Object.keys(harness.dependencies)).toEqual(["repository", "readSheetLastRow", "readSheetRange", "latestSourceRowNumber", "runBatch"])
    expect(Object.keys(harness.dependencies)).not.toContain("readSheet")
  })

  it("15,000행 시트에서 잔여 230건이면 range 5회로 끝내고 전체 payload를 받지 않는다", async () => {
    // Given: 시트 15,000행, 이미 14,770행까지 반영 → 잔여 230건.
    const harness = createHarness({ sheetRowCount: 15_000, latestSourceRowNumber: 14_771 })
    await startAndDrain(harness)

    // Then: 범위 조회는 정확히 5회, 각 50·50·50·50·30.
    expect(harness.state.rangeReads).toHaveLength(5)
    expect(harness.state.rangeReads.map((read) => read.limit)).toEqual([50, 50, 50, 50, 30])
    expect(harness.state.rangeReads.map((read) => read.startRow)).toEqual([14_772, 14_822, 14_872, 14_922, 14_972])

    // Then: 내려받은 행 수는 잔여(230)뿐 — 15,000행 payload를 한 번도 받지 않는다.
    expect(harness.rowsFetched()).toBe(230)
    expect(harness.rowsFetched()).toBeLessThan(harness.state.sheetRowCount)
  })

  it("행 구간이 겹치지도 비지도 않는다", async () => {
    const harness = createHarness({ sheetRowCount: 230 })
    await startAndDrain(harness)
    const covered: number[] = []
    for (const read of harness.state.rangeReads) {
      for (let row = read.startRow; row < read.startRow + read.limit; row += 1) {
        covered.push(row)
      }
    }
    expect(covered).toEqual([...new Set(covered)]) // 중복 0
    expect(covered[0]).toBe(2)
    expect(covered.at(-1)).toBe(231)
    expect(covered).toHaveLength(230) // 누락 0
  })

  it("마지막 행 확인은 batch 수에 비례하고 전체 행 수에 비례하지 않는다", async () => {
    const small = createHarness({ sheetRowCount: 230 })
    await startAndDrain(small)
    // 같은 잔여(230건)를 훨씬 큰 시트에서 처리해도 조회 횟수는 같다.
    const large = createHarness({ sheetRowCount: 40_000, latestSourceRowNumber: 39_771 })
    await startAndDrain(large)

    expect(large.state.rangeReads).toHaveLength(small.state.rangeReads.length)
    expect(large.state.lastRowReads).toBe(small.state.lastRowReads)
    expect(large.state.lastRowReads).toBeLessThan(small.state.rangeReads.length * 3)
  })

  it("창이 소진됐을 때만 즉시 마지막 행을 다시 확인한다", () => {
    expect(shouldRecheckSheetLastRow({ currentRow: 100, latestSheetRow: 99, batchIndex: 3 })).toBe(true)
    expect(shouldRecheckSheetLastRow({ currentRow: 2, latestSheetRow: 1000, batchIndex: 5 })).toBe(true)
    expect(shouldRecheckSheetLastRow({ currentRow: 2, latestSheetRow: 1000, batchIndex: 3 })).toBe(false)
  })

  it("설정된 열 범위에서 첫 열·마지막 열을 뽑는다", () => {
    expect(parseColumnBounds("A:M")).toEqual({ first: "A", last: "M" })
    expect(parseColumnBounds("A1:M")).toEqual({ first: "A", last: "M" })
    expect(parseColumnBounds("b2:AC100")).toEqual({ first: "B", last: "AC" })
    expect(parseColumnBounds("garbage")).toEqual({ first: "A", last: "M" })
  })
})

// SheetRowSchema가 필수(min(1))로 요구하는 두 열 = A 회사명, B 업종.
// 마지막 행 탐지는 이 두 열만 읽고 길이의 최댓값을 쓴다 — 계약을 여기에 고정한다.
describe("마지막 행 산정 계약 (기준 열)", () => {
  it("필수 열 두 개는 시트의 A 회사명·B 업종이며 스키마가 둘 다 요구한다", () => {
    expect(SHEET_COLUMNS[0]).toBe("회사명")
    expect(SHEET_COLUMNS[1]).toBe("업종")
    expect(SheetRowSchema.safeParse({ 회사명: "가", 업종: "나" }).success).toBe(true)
    // 둘 중 하나라도 비면 유효한 데이터 행이 아니다 (=> 기준 열로 삼을 수 있다).
    expect(SheetRowSchema.safeParse({ 회사명: "", 업종: "나" }).success).toBe(false)
    expect(SheetRowSchema.safeParse({ 업종: "나" }).success).toBe(false)
    expect(SheetRowSchema.safeParse({ 회사명: "가" }).success).toBe(false)
  })

  it("기준 열 길이의 최댓값을 마지막 행으로 쓴다", () => {
    // 열 A만 채워진 경우.
    expect(lastRowFromKeyColumns([["회사명", "가", "나"], []])).toBe(3)
    // 시트 끝 행의 A가 비고 B에만 값이 있는 경우 — A만 봤다면 놓쳤을 행을 B가 잡아낸다.
    expect(lastRowFromKeyColumns([["회사명", "가"], ["업종", "나", "다"]])).toBe(3)
    // 빈 시트는 헤더 행 번호 1.
    expect(lastRowFromKeyColumns([])).toBe(1)
    expect(lastRowFromKeyColumns([[], []])).toBe(1)
  })

  it("기준 열 다음 열 문자를 계산한다 (Z 넘어가는 경우 포함)", () => {
    expect(nextColumnLetter("A")).toBe("B")
    expect(nextColumnLetter("b")).toBe("C")
    expect(nextColumnLetter("Z")).toBe("AA")
    expect(nextColumnLetter("AZ")).toBe("BA")
  })

  it("마지막 행을 과소 계산해도 커서가 그 너머로 전진하지 않는다 (유실 없이 지연만)", () => {
    // 실제 마지막 행이 300인데 250으로 잘못 봤다면, 창은 250까지만 잡힌다.
    const window = computeBatchWindow({ currentRow: 240, latestSheetRow: 250, batchSize: 50, processedCount: 0 })
    expect(window.startRow + window.count - 1).toBe(250)
    // 다음 확인에서 300으로 정정되면 251부터 그대로 이어진다.
    expect(remainingRowCount(251, 300)).toBe(50)
  })
})

// migration과 코드 enum이 갈라지면 적용 후에야 CHECK 위반으로 터진다 — 여기서 문자 단위로 고정한다.
describe("migration CHECK ↔ 코드 enum 일치", () => {
  const migration = readFileSync(new URL("../supabase/migrations/202607290001_sync_jobs.sql", import.meta.url), "utf8")

  it("status CHECK 값이 SYNC_JOB_STATUSES와 정확히 같다", () => {
    const check = /check \(status in \(([^)]+)\)\)/.exec(migration)?.[1] ?? ""
    expect(sortedLiterals(check)).toEqual([...SYNC_JOB_STATUSES].sort())
  })

  it("session_stop_reason CHECK 값이 SYNC_SESSION_STOP_REASONS와 정확히 같다", () => {
    const check = /check \(session_stop_reason in \(([^)]+)\)\)/.exec(migration)?.[1] ?? ""
    expect(sortedLiterals(check)).toEqual([...SYNC_SESSION_STOP_REASONS].sort())
  })

  it("진행 중 job은 전체에서 1개만 허용하는 부분 유니크 인덱스가 있다", () => {
    expect(migration).toContain("create unique index sync_jobs_single_active_idx on public.sync_jobs ((true)) where status in ('queued', 'running')")
  })

  it("세션 조회용 root_job_id + chain_index 인덱스가 있다", () => {
    expect(migration).toContain("sync_jobs_root_chain_idx on public.sync_jobs (root_job_id, chain_index)")
  })

  it("root/parent 자기참조 FK는 on delete set null이다 (감사 행을 지우지 않는다)", () => {
    expect(migration).toContain("root_job_id uuid references public.sync_jobs(id) on delete set null")
    expect(migration).toContain("parent_job_id uuid references public.sync_jobs(id) on delete set null")
  })

  it("sync_runs 추가 컬럼은 nullable이고 default가 없다 (기존 행 무영향)", () => {
    expect(migration).toContain("alter table public.sync_runs add column if not exists sync_job_id uuid")
    expect(migration).toContain("alter table public.sync_runs add column if not exists batch_index integer")
    const syncRunsStatements = [...migration.matchAll(/alter table public\.sync_runs[^;]+;/g)].map((match) => match[0])
    expect(syncRunsStatements).toHaveLength(2)
    for (const statement of syncRunsStatements) {
      expect(statement).not.toMatch(/not null/i)
      expect(statement).not.toMatch(/default/i)
    }
  })
})

function sortedLiterals(checkBody: string): readonly string[] {
  return checkBody
    .split(",")
    .map((entry) => entry.trim().replaceAll("'", ""))
    .filter((entry) => entry.length > 0)
    .sort()
}

describe("1회용 lease 토큰", () => {
  it("해시는 원문을 담지 않고 같은 원문에서만 같은 해시가 나온다", () => {
    const minted = mintLeaseToken()
    expect(minted.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(minted.tokenHash).not.toContain(minted.token)
    expect(hashLeaseToken(minted.token)).toBe(minted.tokenHash)
    expect(hashLeaseToken(mintLeaseToken().token)).not.toBe(minted.tokenHash)
  })
})

describe("pump 환경 게이트와 시크릿", () => {
  const full = {
    NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    SUPABASE_SERVICE_ROLE_KEY: "service",
    GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
    GOOGLE_SPREADSHEET_ID: "sheet",
    SYNC_PUMP_SECRET: "pump-secret",
  }

  it("동기화 자격 + 스케줄러 시크릿을 모두 요구한다", () => {
    expect(resolveSyncPumpEnvironment(full)).toEqual({ ok: true, pumpSecret: "pump-secret" })
    expect(resolveSyncPumpEnvironment({ ...full, SUPABASE_SERVICE_ROLE_KEY: undefined })).toEqual({ ok: false, blockedBy: "supabase-env-missing" })
    expect(resolveSyncPumpEnvironment({ ...full, GOOGLE_SPREADSHEET_ID: undefined })).toEqual({ ok: false, blockedBy: "google-env-missing" })
    expect(resolveSyncPumpEnvironment({ ...full, SYNC_PUMP_SECRET: undefined })).toEqual({ ok: false, blockedBy: "pump-secret-missing" })
    expect(resolveSyncPumpEnvironment({ ...full, SYNC_PUMP_SECRET: "   " })).toEqual({ ok: false, blockedBy: "pump-secret-missing" })
  })

  it("시크릿은 정확히 일치할 때만 통과한다", () => {
    expect(verifyPumpSecret("pump-secret", "pump-secret")).toBe(true)
    expect(verifyPumpSecret("pump-secre", "pump-secret")).toBe(false)
    expect(verifyPumpSecret("", "pump-secret")).toBe(false)
    expect(verifyPumpSecret(null, "pump-secret")).toBe(false)
    expect(verifyPumpSecret("pump-secret", "")).toBe(false)
  })
})

describe("job 시작", () => {
  it("미동기화 0건이면 job을 만들지 않고 즉시 끝낸다", async () => {
    const harness = createHarness({ sheetRowCount: 10, latestSourceRowNumber: 11 })
    const result = await startSyncJob(harness.dependencies, { createdBy: "admin@example.com", nowIso: "2026-07-29T00:00:00.000Z" })
    expect(result.kind).toBe("nothing-to-sync")
    expect(harness.sessionJobs()).toHaveLength(0)
    // 시작 판정에도 마지막 행만 확인하고 행 payload는 받지 않는다.
    expect(harness.state.rangeReads).toHaveLength(0)
  })

  it("미동기화가 있으면 job과 첫 tick 토큰을 만들고 자기 자신을 세션 root로 세운다", async () => {
    const harness = createHarness({ sheetRowCount: 60, latestSourceRowNumber: 11 })
    const result = await startSyncJob(harness.dependencies, { createdBy: "admin@example.com", nowIso: "2026-07-29T00:00:00.000Z" })
    // 시트 60행 → 마지막 데이터 행 61, 이미 11행까지 반영 → 12~61행 50건이 잔여.
    expect(result).toMatchObject({ kind: "started", remaining: 50 })
    const job = harness.job()
    expect(job?.current_row).toBe(12)
    expect(job?.chain_index).toBe(0)
    expect(job?.auto_continued).toBe(false)
    expect(job?.root_job_id).toBe(job?.id)
  })

  it("이미 진행 중이면 새 job을 만들지 않는다 (중복 클릭 차단)", async () => {
    const harness = createHarness({ job: makeJob({ status: "running" }), sheetRowCount: 500 })
    const result = await startSyncJob(harness.dependencies, { createdBy: null, nowIso: "2026-07-29T00:00:00.000Z" })
    expect(result.kind).toBe("already-active")
    expect(harness.sessionJobs()).toHaveLength(1)
  })
})

describe("Cron 연속 처리", () => {
  it("미동기화 1건 → 1배치로 완료", async () => {
    const harness = createHarness({ sheetRowCount: 1 })
    const drained = await startAndDrain(harness)
    expect(drained.lastOutcomeKind).toBe("completed")
    expect(harness.state.batchCalls).toMatchObject([{ firstDataRowNumber: 2, count: 1, batchIndex: 1 }])
    expect(harness.job()?.status).toBe("completed")
    expect(harness.job()?.remaining_count).toBe(0)
  })

  it("정확히 50건 → 1배치 (추가 배치 없음)", async () => {
    const harness = createHarness({ sheetRowCount: 50 })
    await startAndDrain(harness)
    expect(harness.state.batchCalls).toHaveLength(1)
    expect(harness.job()?.status).toBe("completed")
  })

  it("51건 → 2배치, 두 번째 배치는 정확히 1건", async () => {
    const harness = createHarness({ sheetRowCount: 51 })
    await startAndDrain(harness)
    expect(harness.state.batchCalls.map((call) => [call.firstDataRowNumber, call.count])).toEqual([
      [2, 50],
      [52, 1],
    ])
    expect(harness.job()?.status).toBe("completed")
  })

  it("230건 → 5배치 (50·50·50·50·30)", async () => {
    const harness = createHarness({ sheetRowCount: 230 })
    await startAndDrain(harness)
    expect(harness.state.batchCalls.map((call) => call.count)).toEqual([50, 50, 50, 50, 30])
    expect(harness.state.batchCalls.map((call) => call.firstDataRowNumber)).toEqual([2, 52, 102, 152, 202])
    expect(harness.job()?.processed_count).toBe(230)
  })

  it("진행 중 시트가 늘어나면 같은 세션이 그대로 이어서 처리한다", async () => {
    const harness = createHarness({ sheetRowCount: 120 })
    const started = await startSyncJob(harness.dependencies, { createdBy: null, nowIso: "2026-07-29T00:00:00.000Z" })
    if (started.kind !== "started") {
      throw new Error("expected started")
    }
    const first = await pumpOnce(harness)
    expect(first.claimed).toBe(true)
    harness.setSheetRows(200)
    await drain(harness)
    expect(harness.job()?.processed_count).toBe(200)
    expect(harness.job()?.status).toBe("completed")
    expect(harness.job()?.remaining_count).toBe(0)
  })

  it("시트가 계속 증가하다 멈추면 자동으로 종료된다 (잔여 0 연속 2회 확인)", async () => {
    const harness = createHarness({ sheetRowCount: 50 })
    const started = await startSyncJob(harness.dependencies, { createdBy: null, nowIso: "2026-07-29T00:00:00.000Z" })
    if (started.kind !== "started") {
      throw new Error("expected started")
    }
    // 1배치 처리 → 잔여 0이지만 즉시 닫지 않고 한 번 더 확인하러 간다.
    const first = await pumpOnce(harness)
    expect(first.outcomeKind).toBe("processed")

    // 그 사이 시트가 20행 늘었다면 확인 카운터가 풀리고 계속 처리한다.
    harness.setSheetRows(70)
    await drain(harness)
    expect(harness.job()?.processed_count).toBe(70)
    expect(harness.job()?.status).toBe("completed")
  })
})

describe("자동 후속 job (세션)", () => {
  it("5,001건 → job 2개가 자동으로 이어지고 사용자 재개가 필요 없다", async () => {
    const harness = createHarness({ sheetRowCount: 5001 })
    const drained = await startAndDrain(harness)

    const jobs = harness.sessionJobs()
    expect(jobs).toHaveLength(2)
    expect(jobs[0]?.status).toBe("partial_completed")
    expect(jobs[0]?.last_error_code).toBe("batch-limit")
    // 자동 진행으로 멈춘 것이 아니므로 세션 중단 사유는 비어 있다 → UI에서 재개 버튼이 뜨지 않는다.
    expect(jobs[0]?.session_stop_reason).toBeNull()
    expect(jobs[1]?.auto_continued).toBe(true)
    expect(jobs[1]?.chain_index).toBe(1)
    expect(jobs[1]?.status).toBe("completed")
    expect(drained.lastOutcomeKind).toBe("completed")
  })

  it("12,300건 → job 3개가 자동으로 이어진다", async () => {
    const harness = createHarness({ sheetRowCount: 12_300 })
    await startAndDrain(harness)
    const jobs = harness.sessionJobs()
    expect(jobs).toHaveLength(3)
    expect(jobs.map((job) => job.chain_index)).toEqual([0, 1, 2])
    expect(jobs.map((job) => job.auto_continued)).toEqual([false, true, true])
    expect(jobs.at(-1)?.status).toBe("completed")
  })

  it("후속 job은 root_job_id·parent_job_id로 세션에 연결되고 커서를 이어받는다", async () => {
    const harness = createHarness({ sheetRowCount: 5001 })
    await startAndDrain(harness)
    const [root, second] = harness.sessionJobs()
    expect(second?.root_job_id).toBe(root?.id)
    expect(second?.parent_job_id).toBe(root?.id)
    expect(second?.session_started_at).toBe(root?.session_started_at)
    // 이어받은 시작 행 = 이전 job이 멈춘 커서. 중복·누락 없음.
    expect(second?.start_row).toBe(root?.current_row)
    expect(second?.start_row).toBe(2 + SYNC_JOB_MAX_ROWS)
  })

  it("세션 누적 처리량이 정확하다", async () => {
    const harness = createHarness({ sheetRowCount: 5001 })
    await startAndDrain(harness)
    expect(harness.sessionJobs().at(-1)?.total_session_processed).toBe(5001)
    const processedAcrossJobs = harness.sessionJobs().reduce((total, job) => total + job.processed_count, 0)
    expect(processedAcrossJobs).toBe(5001)
    expect(harness.state.batchCalls.reduce((total, call) => total + call.count, 0)).toBe(5001)
  })

  it("정상 backlog에서는 사용자 재개 없이 끝까지 진행된다", async () => {
    const harness = createHarness({ sheetRowCount: 12_300 })
    await startAndDrain(harness)
    // 재개가 필요한 상태(failed·interrupted·전역 상한)로 끝난 job이 하나도 없다.
    for (const job of harness.sessionJobs()) {
      expect(["partial_completed", "completed"]).toContain(job.status)
      expect(job.session_stop_reason).toBeNull()
    }
  })
})

describe("전역 안전 상한", () => {
  it("자동 후속 job 개수 상한에 도달하면 멈춘다", () => {
    const state = {
      autoJobCount: SYNC_SESSION_MAX_AUTO_JOBS,
      sessionProcessed: 1000,
      sessionStartedAt: "2026-07-29T00:00:00.000Z",
      consecutiveErrors: 0,
      cancelRequested: false,
      maxAutoJobs: SYNC_SESSION_MAX_AUTO_JOBS,
    }
    expect(decideSessionContinuation(state, "2026-07-29T00:10:00.000Z")).toEqual({ kind: "stop", reason: "session-job-limit" })
    expect(decideSessionContinuation({ ...state, autoJobCount: 0 }, "2026-07-29T00:10:00.000Z")).toEqual({ kind: "continue" })
  })

  it("세션 행 수·연속 오류·경과 시간·사용자 취소 상한을 각각 적용한다", () => {
    const base = {
      autoJobCount: 0,
      sessionProcessed: 0,
      sessionStartedAt: "2026-07-29T00:00:00.000Z",
      consecutiveErrors: 0,
      cancelRequested: false,
      maxAutoJobs: SYNC_SESSION_MAX_AUTO_JOBS,
    }
    const now = "2026-07-29T00:10:00.000Z"
    expect(decideSessionContinuation({ ...base, sessionProcessed: SYNC_SESSION_MAX_ROWS }, now)).toEqual({ kind: "stop", reason: "session-row-limit" })
    expect(decideSessionContinuation({ ...base, consecutiveErrors: 3 }, now)).toEqual({ kind: "stop", reason: "session-error-limit" })
    expect(decideSessionContinuation(base, "2026-07-29T06:00:01.000Z")).toEqual({ kind: "stop", reason: "session-time-limit" })
    // 취소는 다른 어떤 조건보다 우선한다.
    expect(decideSessionContinuation({ ...base, cancelRequested: true, consecutiveErrors: 3 }, now)).toEqual({ kind: "stop", reason: "cancelled" })
  })

  it("세션 job 상한과 행 상한이 같은 지점에서 걸린다", () => {
    expect(SYNC_SESSION_MAX_ROWS).toBe((SYNC_SESSION_MAX_AUTO_JOBS + 1) * SYNC_JOB_MAX_ROWS)
    expect(SYNC_SESSION_MAX_ROWS).toBe(50_000)
  })

  it("전역 상한 도달 시 partial_completed로 닫고 후속 job을 만들지 않는다", async () => {
    const harness = createHarness({
      job: makeJob({
        status: "running",
        batch_index: SYNC_JOB_MAX_BATCHES,
        processed_count: SYNC_JOB_MAX_ROWS,
        total_session_processed: SYNC_SESSION_MAX_ROWS,
        current_row: 50_002,
      }),
      sheetRowCount: 60_000,
    })
    const result = await pumpOnce(harness, "2026-07-29T00:10:00.000Z")
    expect(result.outcomeKind).toBe("partial")
    expect(harness.sessionJobs()).toHaveLength(1)
    expect(harness.job(ROOT_ID)?.status).toBe("partial_completed")
    expect(harness.job(ROOT_ID)?.session_stop_reason).toBe("session-row-limit")
  })

  it("사용자 취소 시 후속 job을 만들지 않고 cancelled로 닫는다", async () => {
    const harness = createHarness({
      job: makeJob({
        status: "running",
        batch_index: SYNC_JOB_MAX_BATCHES,
        processed_count: SYNC_JOB_MAX_ROWS,
        total_session_processed: SYNC_JOB_MAX_ROWS,
        current_row: 5002,
      }),
      sheetRowCount: 20_000,
    })
    const cancelled = await cancelSyncSession(harness.dependencies, { jobId: ROOT_ID })
    expect(cancelled.kind).toBe("cancelled")

    await pumpOnce(harness, "2026-07-29T00:10:00.000Z")
    expect(harness.sessionJobs()).toHaveLength(1)
    expect(harness.job(ROOT_ID)?.status).toBe("cancelled")
    expect(harness.job(ROOT_ID)?.session_stop_reason).toBe("cancelled")
  })

  it("이미 종료된 job은 중단할 수 없다", async () => {
    const harness = createHarness({ job: makeJob({ status: "completed" }) })
    expect(await cancelSyncSession(harness.dependencies, { jobId: ROOT_ID })).toEqual({ kind: "not-active" })
  })

  it("동일 오류가 반복되면 연속 오류 카운터가 쌓인다", async () => {
    const harness = createHarness({
      job: makeJob({ status: "running", last_error_code: "sheet-read-failed", consecutive_error_count: 1 }),
      readSheetThrows: true,
    })
    await pumpOnce(harness)
    expect(harness.job(ROOT_ID)?.consecutive_error_count).toBe(2)
    expect(harness.job(ROOT_ID)?.status).toBe("interrupted")
  })
})

describe("중복 호출과 재개", () => {
  it("배치 진행 중에 Cron이 또 들어와도 두 번 처리되지 않는다", async () => {
    const harness = createHarness({ sheetRowCount: 120 })
    const started = await startSyncJob(harness.dependencies, { createdBy: null, nowIso: NOW })
    if (started.kind !== "started") {
      throw new Error("expected started")
    }
    // 첫 pump가 lease를 쥔 상태(아직 배치 미완료)에서 두 번째 pump가 들어온다.
    const first = await claimPumpLease(harness.dependencies, { nowIso: NOW })
    const second = await claimPumpLease(harness.dependencies, { nowIso: NOW })
    expect(first.kind).toBe("claimed")
    expect(second.kind).toBe("idle")
    expect(harness.state.batchCalls).toHaveLength(0)
  })

  it("종료된 job은 claim 대상이 아니다", async () => {
    const harness = createHarness({ job: makeJob({ status: "completed" }), sheetRowCount: 10 })
    const claim = await claimPumpLease(harness.dependencies, { nowIso: NOW })
    expect(claim.kind).toBe("idle")
  })

  it("처리 대상이 없으면 idle이다", async () => {
    const harness = createHarness()
    const claim = await claimPumpLease(harness.dependencies, { nowIso: NOW })
    expect(claim.kind).toBe("idle")
  })

  it("정체된 job을 같은 커서에서 이어서 진행한다 (새 job 없음·중복 없음)", async () => {
    const harness = createHarness({
      job: makeJob({ status: "interrupted", current_row: 52, latest_sheet_row: 231, remaining_count: 180, processed_count: 50, batch_index: 1 }),
      sheetRowCount: 230,
    })
    const resumed = await resumeSyncJob(harness.dependencies, { jobId: ROOT_ID, nowIso: "2026-07-29T00:05:00.000Z" })
    expect(resumed).toMatchObject({ kind: "started", remaining: 180 })
    if (resumed.kind !== "started") {
      throw new Error("expected started")
    }
    await drain(harness)
    // 이미 처리한 2~51행은 다시 읽지 않는다.
    expect(harness.state.rangeReads[0]?.startRow).toBe(52)
    expect(harness.sessionJobs()).toHaveLength(1)
    expect(harness.job(ROOT_ID)?.status).toBe("completed")
  })

  it("진행 중 job이 있으면 재개는 새 실행을 만들지 않는다", async () => {
    const harness = createHarness({ job: makeJob({ status: "running" }) })
    const resumed = await resumeSyncJob(harness.dependencies, { jobId: ROOT_ID, nowIso: "2026-07-29T00:00:00.000Z" })
    expect(resumed.kind).toBe("already-active")
  })
})

describe("실패 행 처리", () => {
  it("행 파싱 실패가 섞여도 커서가 전진해 다음 50건으로 넘어간다", async () => {
    // 배치마다 10건 실패 — 예전 브라우저 자동 루프는 여기서 멈췄다.
    const harness = createHarness({ sheetRowCount: 120, summary: { inserted: 40, failed: 10 } })
    await startAndDrain(harness)
    expect(harness.state.rangeReads.map((read) => read.startRow)).toEqual([2, 52, 102])
    expect(harness.job()?.status).toBe("completed")
    expect(harness.job()?.failed_count).toBe(30)
    expect(harness.job()?.remaining_count).toBe(0)
  })

  it("시트 읽기 실패는 interrupted로 남겨 재개할 수 있게 한다", async () => {
    const harness = createHarness({ job: makeJob({ status: "running" }), readSheetThrows: true })
    const result = await pumpOnce(harness)
    expect(result.outcomeKind).toBe("failed")
    expect(harness.job(ROOT_ID)?.status).toBe("interrupted")
  })

  it("배치 처리가 터지면 커서를 전진시키지 않고 failed로 남긴다 (같은 창부터 재시도)", async () => {
    const harness = createHarness({
      job: makeJob({ status: "running", current_row: 52, latest_sheet_row: 231 }),
      sheetRowCount: 230,
      runBatchThrows: true,
    })
    const result = await pumpOnce(harness)
    expect(result.outcomeKind).toBe("failed")
    expect(harness.job(ROOT_ID)?.last_error_code).toBe("batch-failed")
    expect(harness.job(ROOT_ID)?.status).toBe("failed")
    expect(harness.job(ROOT_ID)?.current_row).toBe(52)
  })

  it("마지막 tick 이후 오래 지나면 정체로 판정한다", () => {
    expect(isStaleTick(null, "2026-07-29T00:10:00.000Z")).toBe(false)
    expect(isStaleTick("2026-07-29T00:00:00.000Z", "2026-07-29T00:01:00.000Z")).toBe(false)
    expect(isStaleTick("2026-07-29T00:00:00.000Z", "2026-07-29T00:06:00.000Z")).toBe(true)
  })
})

// ── lease (실행 소유권) ──────────────────────────────────────────
// 이 구조에는 self-fetch가 없다. 중복 처리 방지는 전부 lease 조건부 UPDATE가 담당한다.
describe("lease 소유권", () => {
  it("동시에 두 pump가 들어오면 승자는 하나뿐이다", async () => {
    const harness = createHarness({ job: makeJob({ status: "queued", current_row: 2, latest_sheet_row: 231 }), sheetRowCount: 230 })

    const [first, second] = await Promise.all([
      claimPumpLease(harness.dependencies, { nowIso: NOW }),
      claimPumpLease(harness.dependencies, { nowIso: NOW }),
    ])

    const claimed = [first, second].filter((entry) => entry.kind === "claimed")
    expect(claimed).toHaveLength(1)
    expect(harness.job(ROOT_ID)?.pump_attempt).toBe(1)
  })

  it("lease를 쥔 job은 만료 전까지 다시 claim되지 않는다", async () => {
    const harness = createHarness({ job: makeJob({ status: "queued", current_row: 2, latest_sheet_row: 231 }), sheetRowCount: 230 })

    const first = await claimPumpLease(harness.dependencies, { nowIso: "2026-07-29T00:00:00.000Z" })
    expect(first.kind).toBe("claimed")
    // lease 유효시간(120초)의 절반 시점 — 아직 남의 것이다.
    const during = await claimPumpLease(harness.dependencies, { nowIso: "2026-07-29T00:01:00.000Z" })
    expect(during.kind).toBe("idle")
  })

  it("lease가 만료되면 다음 pump가 같은 커서에서 이어받는다", async () => {
    const harness = createHarness({ job: makeJob({ status: "queued", current_row: 2, latest_sheet_row: 231 }), sheetRowCount: 230 })

    // 첫 pump가 claim만 하고 죽었다 (진행 저장 없음).
    const dead = await claimPumpLease(harness.dependencies, { nowIso: "2026-07-29T00:00:00.000Z" })
    expect(dead.kind).toBe("claimed")

    // lease 유효시간을 넘긴 시점 — 다시 가져갈 수 있다.
    const revived = await claimPumpLease(harness.dependencies, { nowIso: "2026-07-29T00:03:00.000Z" })
    expect(revived.kind).toBe("claimed")
    if (revived.kind !== "claimed") {
      throw new Error("expected claimed")
    }
    // 커서는 전진하지 않았으므로 같은 구간부터 처리한다 (upsert가 source_key 기준이라 중복 행이 생기지 않는다).
    expect(revived.job.current_row).toBe(2)
    expect(revived.job.pump_attempt).toBe(2)

    await runLeasedBatch(harness.dependencies, { job: revived.job, leaseTokenHash: revived.leaseTokenHash, nowIso: "2026-07-29T00:03:00.000Z" })
    expect(harness.state.batchCalls).toEqual([{ firstDataRowNumber: 2, count: 50, batchIndex: 1, jobId: ROOT_ID }])
    expect(harness.job(ROOT_ID)?.current_row).toBe(52)
  })

  it("lease를 잃은 워커는 진행을 저장하지 못하고 커서를 전진시키지 않는다", async () => {
    const harness = createHarness({ job: makeJob({ status: "queued", current_row: 2, latest_sheet_row: 231 }), sheetRowCount: 230 })

    const stale = await claimPumpLease(harness.dependencies, { nowIso: "2026-07-29T00:00:00.000Z" })
    if (stale.kind !== "claimed") {
      throw new Error("expected claimed")
    }
    // 그 사이 lease가 만료되고 다른 pump가 가져갔다.
    const winner = await claimPumpLease(harness.dependencies, { nowIso: "2026-07-29T00:03:00.000Z" })
    expect(winner.kind).toBe("claimed")

    // 죽었다고 생각한 워커가 뒤늦게 배치를 끝내고 저장을 시도한다.
    const result = await runLeasedBatch(harness.dependencies, { job: stale.job, leaseTokenHash: stale.leaseTokenHash, nowIso: "2026-07-29T00:03:30.000Z" })

    expect(result.outcome).toEqual({ kind: "noop", reason: "lease-lost" })
    // 커서·집계 무변경 — 남의 진행을 덮지 않는다.
    expect(harness.job(ROOT_ID)?.current_row).toBe(2)
    expect(harness.job(ROOT_ID)?.processed_count).toBe(0)
    expect(harness.job(ROOT_ID)?.status).toBe("running")
  })

  it("배치를 끝내면 lease를 놓아 다음 Cron이 곧바로 가져갈 수 있다", async () => {
    const harness = createHarness({ job: makeJob({ status: "queued", current_row: 2, latest_sheet_row: 231 }), sheetRowCount: 230 })

    const claim = await claimPumpLease(harness.dependencies, { nowIso: NOW })
    if (claim.kind !== "claimed") {
      throw new Error("expected claimed")
    }
    await runLeasedBatch(harness.dependencies, { job: claim.job, leaseTokenHash: claim.leaseTokenHash, nowIso: NOW })

    expect(harness.job(ROOT_ID)?.lease_token_hash).toBeNull()
    expect(harness.job(ROOT_ID)?.lease_expires_at).toBeNull()
    // 만료를 기다리지 않고 바로 다음 배치로 넘어간다.
    const next = await claimPumpLease(harness.dependencies, { nowIso: NOW })
    expect(next.kind).toBe("claimed")
  })

  it("배치가 터진 뒤의 표식도 lease 보유자만 남긴다", async () => {
    const harness = createHarness({ job: makeJob({ status: "queued", current_row: 2, latest_sheet_row: 231 }), sheetRowCount: 230 })

    const stale = await claimPumpLease(harness.dependencies, { nowIso: "2026-07-29T00:00:00.000Z" })
    if (stale.kind !== "claimed") {
      throw new Error("expected claimed")
    }
    const winner = await claimPumpLease(harness.dependencies, { nowIso: "2026-07-29T00:03:00.000Z" })
    expect(winner.kind).toBe("claimed")

    await harness.dependencies.repository.markInterrupted({
      jobId: ROOT_ID,
      errorCode: PUMP_BATCH_CRASHED_CODE,
      nowIso: "2026-07-29T00:03:30.000Z",
      leaseTokenHash: stale.leaseTokenHash,
    })

    // 새 lease 보유자의 진행이 살아 있다.
    expect(harness.job(ROOT_ID)?.status).toBe("running")
    expect(harness.job(ROOT_ID)?.last_error_code).toBeNull()
  })

  it("claim 순서는 chain_index → id로 결정론적이다", async () => {
    const harness = createHarness({ job: makeJob({ status: "completed", chain_index: 0 }) })
    // 진행 중 job은 유니크 인덱스로 1개만 존재하지만, 순서 규칙 자체를 고정해 둔다.
    const later = makeJob({ id: "99999999-9999-4999-8999-999999999999", status: "queued", chain_index: 3, current_row: 2, latest_sheet_row: 231 })
    const earlier = makeJob({ id: "88888888-8888-4888-8888-888888888888", status: "queued", chain_index: 1, current_row: 2, latest_sheet_row: 231 })
    harness.state.jobs.set(later.id, later)
    harness.state.jobs.set(earlier.id, earlier)

    const claim = await claimPumpLease(harness.dependencies, { nowIso: NOW })
    if (claim.kind !== "claimed") {
      throw new Error("expected claimed")
    }
    expect(claim.job.id).toBe(earlier.id)
  })
})

// ── 세션 실행 창 재개 (2026-07-30 잠복 결함) ─────────────────────
// 상한에 닿았거나 창이 만료된 job을 되살리면 다음 tick이 즉시 같은 상한에 걸려
// "처리 0으로 종료"를 무한 반복한다. 그래서 재개는 새 창(child job)을 만든다.
describe("세션 실행 창 재개", () => {
  const dayLater = "2026-07-30T04:00:00.000Z"

  it("실행 창이 만료된 job은 되살리지 않고 새 창을 만든다", async () => {
    const harness = createHarness({
      job: makeJob({
        status: "interrupted",
        session_started_at: "2026-07-29T10:25:07.000Z",
        current_row: 15_403,
        processed_count: 450,
        inserted_count: 450,
        remaining_count: 5_150,
        batch_index: 9,
        total_session_processed: 450,
        last_error_code: "chain-dispatch-http-508",
      }),
      sheetRowCount: 20_551,
      latestSourceRowNumber: 15_402,
    })

    const resumed = await resumeSyncJob(harness.dependencies, { jobId: ROOT_ID, nowIso: dayLater })

    expect(resumed).toMatchObject({ kind: "started", freshWindow: true })
    if (resumed.kind !== "started") {
      throw new Error("expected started")
    }
    expect(resumed.jobId).not.toBe(ROOT_ID)

    // 새 창: 커서만 물려받고 배치 번호·집계·창 시작 시각은 새로 시작한다.
    const child = harness.job(resumed.jobId)
    expect(child?.start_row).toBe(15_403)
    expect(child?.current_row).toBe(15_403)
    expect(child?.batch_index).toBe(0)
    expect(child?.processed_count).toBe(0)
    expect(child?.session_started_at).toBe(dayLater)
    expect(child?.root_job_id).toBe(ROOT_ID)
    expect(child?.parent_job_id).toBe(ROOT_ID)
    expect(child?.chain_index).toBe(1)
    expect(child?.auto_continued).toBe(false)

    // 기존 job은 그대로 보존된다 (처리분 450건이 사라지지 않는다).
    expect(harness.job(ROOT_ID)?.processed_count).toBe(450)
    expect(harness.job(ROOT_ID)?.current_row).toBe(15_403)
    expect(harness.job(ROOT_ID)?.status).toBe("interrupted")
  })

  it("새 창에서 처리를 이어가면 이미 처리한 구간을 다시 읽지 않는다", async () => {
    const harness = createHarness({
      job: makeJob({
        status: "interrupted",
        session_started_at: "2026-07-29T10:25:07.000Z",
        current_row: 15_403,
        processed_count: 450,
        remaining_count: 5_150,
        batch_index: 9,
      }),
      sheetRowCount: 15_452,
      latestSourceRowNumber: 15_402,
    })

    await resumeSyncJob(harness.dependencies, { jobId: ROOT_ID, nowIso: dayLater })
    const tick = await pumpOnce(harness, dayLater)

    expect(tick.claimed).toBe(true)
    expect(harness.state.rangeReads).toEqual([{ startRow: 15_403, limit: 50 }])
    expect(harness.state.batchCalls[0]?.firstDataRowNumber).toBe(15_403)
  })

  it("job 배치 상한에 닿은 job도 되살리지 않고 새 창을 만든다", async () => {
    const harness = createHarness({
      job: makeJob({
        status: "partial_completed",
        session_started_at: NOW,
        batch_index: SYNC_JOB_MAX_BATCHES,
        processed_count: SYNC_JOB_MAX_ROWS,
        current_row: 5_002,
        remaining_count: 900,
        session_stop_reason: "session-time-limit",
      }),
      sheetRowCount: 6_000,
      latestSourceRowNumber: 5_001,
    })

    const resumed = await resumeSyncJob(harness.dependencies, { jobId: ROOT_ID, nowIso: "2026-07-29T00:30:00.000Z" })

    expect(resumed).toMatchObject({ kind: "started", freshWindow: true })
    if (resumed.kind !== "started") {
      throw new Error("expected started")
    }
    const child = harness.job(resumed.jobId)
    expect(child?.batch_index).toBe(0)
    expect(child?.current_row).toBe(5_002)
  })

  it("상한에 닿은 job을 되살렸을 때의 처리 0 무한 반복이 재현되지 않는다", async () => {
    const harness = createHarness({
      job: makeJob({
        status: "partial_completed",
        session_started_at: "2026-07-29T10:25:07.000Z",
        batch_index: SYNC_JOB_MAX_BATCHES,
        processed_count: SYNC_JOB_MAX_ROWS,
        current_row: 5_002,
        remaining_count: 900,
      }),
      sheetRowCount: 6_000,
      latestSourceRowNumber: 5_001,
    })

    await resumeSyncJob(harness.dependencies, { jobId: ROOT_ID, nowIso: dayLater })
    const tick = await pumpOnce(harness, dayLater)

    // 새 창이므로 상한 판정이 아니라 실제 배치가 돈다.
    expect(tick.outcomeKind).toBe("processed")
    expect(harness.state.batchCalls).toHaveLength(1)
  })

  it("일시적 중단은 같은 job을 되살려 커서를 그대로 이어간다", async () => {
    const harness = createHarness({
      job: makeJob({
        status: "failed",
        session_started_at: NOW,
        current_row: 52,
        processed_count: 50,
        remaining_count: 180,
        batch_index: 1,
        last_error_code: "batch-failed",
      }),
      sheetRowCount: 230,
      latestSourceRowNumber: 51,
    })

    const resumed = await resumeSyncJob(harness.dependencies, { jobId: ROOT_ID, nowIso: "2026-07-29T00:05:00.000Z" })

    expect(resumed).toMatchObject({ kind: "started", jobId: ROOT_ID })
    expect(resumed).not.toMatchObject({ freshWindow: true })
    expect(harness.sessionJobs()).toHaveLength(1)
    // queued로 되돌아가 다음 Cron이 가져간다 (이 요청이 배치를 돌리지 않는다).
    expect(harness.job(ROOT_ID)?.status).toBe("queued")
    expect(harness.job(ROOT_ID)?.current_row).toBe(52)
    expect(harness.state.batchCalls).toHaveLength(0)
  })

  it("되살릴 수 없는 상태는 재개하지 않는다", async () => {
    const harness = createHarness({ job: makeJob({ status: "completed", remaining_count: 100, current_row: 52 }), sheetRowCount: 230, latestSourceRowNumber: 51 })
    const resumed = await resumeSyncJob(harness.dependencies, { jobId: ROOT_ID, nowIso: NOW })
    expect(resumed).toEqual({ kind: "failed", reason: "not-resumable" })
  })
})

// ── 시작·재개가 배치를 직접 돌리지 않는다 ────────────────────────
describe("요청 함수는 배치를 처리하지 않는다", () => {
  it("시작 버튼은 job만 만들고 배치·시트 구간 조회를 하지 않는다", async () => {
    const harness = createHarness({ sheetRowCount: 230 })
    const started = await startSyncJob(harness.dependencies, { createdBy: "admin@example.com", nowIso: NOW })

    expect(started.kind).toBe("started")
    expect(harness.state.batchCalls).toHaveLength(0)
    expect(harness.state.rangeReads).toHaveLength(0)
    expect(harness.job()?.status).toBe("queued")
  })

  it("이어서 진행도 job 상태만 바꾸고 배치를 돌리지 않는다", async () => {
    const harness = createHarness({
      job: makeJob({ status: "interrupted", session_started_at: NOW, current_row: 52, remaining_count: 180, batch_index: 1, processed_count: 50 }),
      sheetRowCount: 230,
      latestSourceRowNumber: 51,
    })
    await resumeSyncJob(harness.dependencies, { jobId: ROOT_ID, nowIso: "2026-07-29T00:05:00.000Z" })

    expect(harness.state.batchCalls).toHaveLength(0)
    expect(harness.state.rangeReads).toHaveLength(0)
  })
})

describe("요청 파싱과 응답 매핑", () => {
  it("tick 요청만 받아들이고 그 외는 invalid로 거부한다", () => {
    expect(parseSyncTickRequest({ mode: "tick", jobId: ROOT_ID })).toEqual({ mode: "tick", jobId: ROOT_ID })
    expect(parseSyncTickRequest({ mode: "tick", jobId: "not-a-uuid" })).toEqual({ mode: "invalid" })
    expect(parseSyncTickRequest({ mode: "start" })).toEqual({ mode: "invalid" })
    expect(parseSyncTickRequest(null)).toEqual({ mode: "invalid" })
    expect(parseSyncTickRequest([])).toEqual({ mode: "invalid" })
  })

  it("응답 본문에 토큰 원문·시트 내용·stack trace를 담지 않는다", () => {
    const minted = mintLeaseToken()
    const bodies = [
      safeSyncResponseBody({ kind: "accepted", jobId: ROOT_ID }),
      safeSyncResponseBody({ kind: "processed", jobStatus: "running", processed: 50, remaining: 180 }),
      safeSyncResponseBody({ kind: "completed", processed: 230 }),
      safeSyncResponseBody({ kind: "partial", processed: 5000, remaining: 900 }),
      safeSyncResponseBody({ kind: "noop", reason: "idle" }),
      safeSyncResponseBody({ kind: "unauthorized", reason: "unknown-job" }),
      safeSyncResponseBody({ kind: "failed", errorCode: "internal" }),
    ]
    for (const body of bodies) {
      const serialized = JSON.stringify(body)
      expect(serialized).not.toContain(minted.token)
      expect(serialized).not.toContain(minted.tokenHash)
      expect(serialized).not.toMatch(/secret|Bearer|회사명|supabase|at\s+\w+\s+\(/i)
    }
  })

  it("접수 결과는 202이고 본문에 진행 수치·jobId를 담지 않는다", () => {
    expect(httpStatusForSyncOutcome({ kind: "accepted", jobId: ROOT_ID })).toBe(202)
    const body = safeSyncResponseBody({ kind: "accepted", jobId: ROOT_ID })
    expect(body).toEqual({ ok: true, accepted: true })
    expect(JSON.stringify(body)).not.toContain(ROOT_ID)
  })

  it("결과 종류를 HTTP 상태로 매핑한다", () => {
    expect(httpStatusForSyncOutcome({ kind: "processed", jobStatus: "running", processed: 1, remaining: 1 })).toBe(200)
    expect(httpStatusForSyncOutcome({ kind: "noop", reason: "duplicate-tick" })).toBe(200)
    expect(httpStatusForSyncOutcome({ kind: "unauthorized", reason: "unknown-job" })).toBe(401)
    expect(httpStatusForSyncOutcome({ kind: "conflict", reason: "google-env-missing" })).toBe(409)
    expect(httpStatusForSyncOutcome({ kind: "failed", errorCode: "internal" })).toBe(500)
  })
})

// ── 구조 보증: 자동 처리 경로에 자기 호출이 없다 ────────────────
// Vercel은 같은 함수의 HTTP 재귀 호출을 4회 초과에서 508로 차단한다. 재시도·timeout으로는 우회할 수
// 없으므로 "코드에 self-fetch가 아예 없다"를 소스 스캔으로 고정한다.
describe("자동 처리 경로에 self-fetch 없음", () => {
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")))
      .map((entry) => `${entry.parentPath}/${entry.name}`)

  it("lib/sync·app/api/sync·app/admin/sync 어디에도 fetch 호출이 없다", () => {
    const files = [...sourceFiles("lib/sync"), ...sourceFiles("app/api/sync"), ...sourceFiles("app/admin/sync")]
    expect(files.length).toBeGreaterThan(5)

    const offenders = files.filter((file) => new RegExp(String.raw`\bfetch\s*\(`, "u").test(readFileSync(file, "utf8")))
    expect(offenders).toEqual([])
  })

  it("chain 발사 모듈과 endpoint가 저장소에 남아 있지 않다", () => {
    const files = [...sourceFiles("lib/sync"), ...sourceFiles("app/api/sync")]
    expect(files.some((file) => file.includes("job-chain"))).toBe(false)
    expect(files.some((file) => file.includes("api/sync/chain"))).toBe(false)
  })
})
