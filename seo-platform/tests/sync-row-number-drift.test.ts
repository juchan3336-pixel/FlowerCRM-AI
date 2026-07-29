// 행번호 축소(row-number drift) 차단 회귀 방어.
//
// 시트에서 행이 삭제되면 places의 max(source_row_number)가 현재 시트 끝을 앞지른다.
// 그 상태로 동기화하면 잔여가 0으로 계산돼 "미동기화 없음"으로 조용히 끝나지만, 실제로는 그 뒤에
// 붙는 신규 행이 커서에 닿을 때까지 통째로 유실된다 (2026-07-29 공백행 6개 삭제 사고).
// 따라서 drift는 정상 완료와 절대 섞이면 안 되고, 시작·재개·tick 어디서든 막혀야 한다.
import { describe, expect, it } from "vitest"

import {
  detectRowNumberDrift,
  hashTickToken,
  httpStatusForSyncOutcome,
  rowNumberDriftMessage,
  safeSyncResponseBody,
  ROW_NUMBER_DRIFT_CODE,
  SYNC_JOB_BATCH_SIZE,
  SYNC_SESSION_MAX_AUTO_JOBS,
} from "@/lib/sync/job-policy"
import { executeSyncTick, resumeSyncJob, startSyncJob, type SyncJobDependencies, type SyncJobRow } from "@/lib/sync/job-service"

// 실측 기준선: Supabase max=14,958 / 삭제 후 Sheet 마지막 행=14,952 → 차이 6.
const MAX_SOURCE_ROW = 14_958
const SHEET_LAST_ROW = 14_952
const JOB_ID = "11111111-1111-4111-8111-111111111111"

function makeJob(patch: Partial<SyncJobRow> = {}): SyncJobRow {
  return {
    id: JOB_ID,
    status: "running",
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
    root_job_id: JOB_ID,
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
    next_tick_token_hash: null,
    started_at: "2026-07-29T00:00:00.000Z",
    last_tick_at: null,
    finished_at: null,
    last_error_code: null,
    last_error_message: null,
    ...patch,
  }
}

type Harness = {
  readonly dependencies: SyncJobDependencies
  readonly state: { jobs: SyncJobRow[]; created: number; rangeReads: number; batchRuns: number }
}

function createHarness(options: Readonly<{ job?: SyncJobRow | null; sheetLastRow: number; maxSourceRow: number | null }>): Harness {
  const state = { jobs: options.job == null ? [] : [options.job], created: 0, rangeReads: 0, batchRuns: 0 }
  const find = (id: string) => state.jobs.find((job) => job.id === id) ?? null
  const patch = (id: string, next: Partial<SyncJobRow>) => {
    const index = state.jobs.findIndex((job) => job.id === id)
    const current = state.jobs[index]
    if (current !== undefined) {
      state.jobs[index] = { ...current, ...next }
    }
  }

  return {
    state,
    dependencies: {
      repository: {
        findActiveJob: () => Promise.resolve(state.jobs.find((job) => job.status === "queued" || job.status === "running") ?? null),
        findJobById: (id) => Promise.resolve(find(id)),
        findLatestJob: () => Promise.resolve(state.jobs.at(-1) ?? null),
        listSessionJobs: () => Promise.resolve(state.jobs),
        createJob: (input) => {
          state.created += 1
          const job = makeJob({ id: `job-${String(state.created)}`, status: "queued", start_row: input.startRow, current_row: input.startRow, next_tick_token_hash: input.tokenHash })
          state.jobs.push(job)
          return Promise.resolve(job)
        },
        setRootToSelf: () => Promise.resolve(),
        claimTick: (input) => {
          const current = find(input.jobId)
          if (current?.next_tick_token_hash !== input.expectedTokenHash) {
            return Promise.resolve(null)
          }
          patch(input.jobId, { status: "running", next_tick_token_hash: input.nextTokenHash })
          return Promise.resolve(find(input.jobId))
        },
        reviveJob: (input) => {
          patch(input.jobId, { status: "running", next_tick_token_hash: input.nextTokenHash })
          return Promise.resolve(find(input.jobId))
        },
        recordProgress: () => Promise.resolve(),
        finishJob: (input) => {
          patch(input.jobId, { status: input.status, last_error_code: input.errorCode ?? null, last_error_message: input.errorMessage ?? null })
          return Promise.resolve()
        },
        markInterrupted: () => Promise.resolve(),
        requestCancel: () => Promise.resolve(null),
      },
      readSheetLastRow: () => Promise.resolve({ sheetName: "기업 DB", lastRow: options.sheetLastRow }),
      readSheetRange: (input) => {
        state.rangeReads += 1
        return Promise.resolve({ sheetName: "기업 DB", startRow: input.startRow, rows: [] })
      },
      latestSourceRowNumber: () => Promise.resolve(options.maxSourceRow),
      runBatch: (input) => {
        state.batchRuns += 1
        return Promise.resolve({ runId: "run", totalRows: input.rows.length, inserted: 0, updated: 0, skipped: 0, failed: 0 })
      },
    },
  }
}

describe("drift 판정", () => {
  it("기록된 최대 행이 시트 끝보다 크면 drift다", () => {
    expect(detectRowNumberDrift({ latestSheetRow: SHEET_LAST_ROW, maxSourceRowNumber: MAX_SOURCE_ROW })).toEqual({
      kind: "drift",
      drift: { latestSheetRow: SHEET_LAST_ROW, maxSourceRowNumber: MAX_SOURCE_ROW, difference: 6 },
    })
  })

  it("같거나 작으면 정상이다", () => {
    expect(detectRowNumberDrift({ latestSheetRow: 14_952, maxSourceRowNumber: 14_952 })).toEqual({ kind: "ok" })
    expect(detectRowNumberDrift({ latestSheetRow: 14_952, maxSourceRowNumber: 14_900 })).toEqual({ kind: "ok" })
  })

  it("아직 동기화 기록이 없으면 정상이다", () => {
    expect(detectRowNumberDrift({ latestSheetRow: 100, maxSourceRowNumber: null })).toEqual({ kind: "ok" })
    expect(detectRowNumberDrift({ latestSheetRow: 100, maxSourceRowNumber: undefined })).toEqual({ kind: "ok" })
  })

  it("안내 문구에 수치가 들어가고 내부 코드·secret·stack trace는 없다", () => {
    const message = rowNumberDriftMessage({ latestSheetRow: SHEET_LAST_ROW, maxSourceRowNumber: MAX_SOURCE_ROW, difference: 6 })
    expect(message).toContain("14952")
    expect(message).toContain("14958")
    expect(message).toContain("6행")
    expect(message).toContain("행번호 정합성을 복구한 뒤")
    expect(message).not.toMatch(/token|secret|Bearer|supabase|source_row_number|at\s+\w+\s+\(/i)
  })
})

describe("시작 차단", () => {
  it("max 14,958 / sheet 14,952 → job을 만들지 않고 차단한다", async () => {
    const harness = createHarness({ sheetLastRow: SHEET_LAST_ROW, maxSourceRow: MAX_SOURCE_ROW })
    const result = await startSyncJob(harness.dependencies, { createdBy: "admin@example.com", nowIso: "2026-07-29T00:00:00.000Z" })

    expect(result).toEqual({ kind: "row-number-drift", drift: { latestSheetRow: SHEET_LAST_ROW, maxSourceRowNumber: MAX_SOURCE_ROW, difference: 6 } })
    // job 생성 0건 · sync_runs(=runBatch) 0건 · range 조회 0건 · 후속 job 0건
    expect(harness.state.created).toBe(0)
    expect(harness.state.jobs).toHaveLength(0)
    expect(harness.state.batchRuns).toBe(0)
    expect(harness.state.rangeReads).toBe(0)
  })

  it("nothing-to-sync로 위장되지 않는다", async () => {
    // drift 상황은 잔여도 0으로 계산되므로, 판정 순서가 틀리면 정상 완료로 오인된다.
    const harness = createHarness({ sheetLastRow: SHEET_LAST_ROW, maxSourceRow: MAX_SOURCE_ROW })
    const result = await startSyncJob(harness.dependencies, { createdBy: null, nowIso: "2026-07-29T00:00:00.000Z" })
    expect(result.kind).not.toBe("nothing-to-sync")
    expect(result.kind).toBe("row-number-drift")
  })

  it("max === latest면 정상 판정한다 (잔여 0 → nothing-to-sync)", async () => {
    const harness = createHarness({ sheetLastRow: 14_952, maxSourceRow: 14_952 })
    const result = await startSyncJob(harness.dependencies, { createdBy: null, nowIso: "2026-07-29T00:00:00.000Z" })
    expect(result).toEqual({ kind: "nothing-to-sync" })
  })

  it("max < latest면 정상 증분으로 시작한다", async () => {
    const harness = createHarness({ sheetLastRow: 15_000, maxSourceRow: 14_952 })
    const result = await startSyncJob(harness.dependencies, { createdBy: null, nowIso: "2026-07-29T00:00:00.000Z" })
    expect(result).toMatchObject({ kind: "started", remaining: 48 })
    expect(harness.state.created).toBe(1)
  })
})

describe("재개 차단", () => {
  it("drift가 남아 있으면 재개하지 않는다", async () => {
    const harness = createHarness({
      job: makeJob({ status: "interrupted", remaining_count: 100, last_error_code: ROW_NUMBER_DRIFT_CODE }),
      sheetLastRow: SHEET_LAST_ROW,
      maxSourceRow: MAX_SOURCE_ROW,
    })
    const result = await resumeSyncJob(harness.dependencies, { jobId: JOB_ID, nowIso: "2026-07-29T00:10:00.000Z" })

    expect(result).toMatchObject({ kind: "row-number-drift" })
    // 재개되지 않았으므로 상태는 interrupted 그대로다.
    expect(harness.state.jobs[0]?.status).toBe("interrupted")
    expect(harness.state.batchRuns).toBe(0)
  })

  it("drift가 해소되면 재개된다", async () => {
    const harness = createHarness({
      job: makeJob({ status: "interrupted", remaining_count: 100, current_row: 14_853 }),
      sheetLastRow: 14_952,
      maxSourceRow: 14_852,
    })
    const result = await resumeSyncJob(harness.dependencies, { jobId: JOB_ID, nowIso: "2026-07-29T00:10:00.000Z" })
    expect(result).toMatchObject({ kind: "started", remaining: 100 })
  })
})

describe("실행 중 시트 축소", () => {
  it("tick 중 시트가 줄면 interrupted로 멈추고 다음 tick·후속 job을 만들지 않는다", async () => {
    // 이미 14,900행까지 처리한 job인데 시트가 14,852까지 줄어든 상황.
    const harness = createHarness({
      job: makeJob({ status: "running", current_row: 14_901, latest_sheet_row: 14_958, next_tick_token_hash: hashTickToken("tok") }),
      sheetLastRow: 14_852,
      maxSourceRow: MAX_SOURCE_ROW,
    })
    const result = await executeSyncTick(harness.dependencies, { jobId: JOB_ID, token: "tok", nowIso: "2026-07-29T00:00:00.000Z" })

    expect(result.outcome).toEqual({
      kind: "row-number-drift",
      drift: { latestSheetRow: 14_852, maxSourceRowNumber: 14_900, difference: 48 },
    })
    // 다음 tick 토큰 미발급 · 후속 job 0건 · 배치 실행 0건 · 시트 구간 조회 0건
    expect(result.nextTick).toBeNull()
    expect(harness.state.created).toBe(0)
    expect(harness.state.batchRuns).toBe(0)
    expect(harness.state.rangeReads).toBe(0)

    const job = harness.state.jobs[0]
    expect(job?.status).toBe("interrupted")
    expect(job?.last_error_code).toBe(ROW_NUMBER_DRIFT_CODE)
    expect(job?.last_error_message).toContain("행번호 정합성을 복구한 뒤")
  })

  it("정상 완료 시점(커서 = 시트 끝 + 1)은 drift로 오판하지 않는다", async () => {
    const harness = createHarness({
      job: makeJob({ status: "running", current_row: 14_953, latest_sheet_row: 14_952, next_tick_token_hash: hashTickToken("tok") }),
      sheetLastRow: 14_952,
      maxSourceRow: 14_952,
    })
    const result = await executeSyncTick(harness.dependencies, { jobId: JOB_ID, token: "tok", nowIso: "2026-07-29T00:00:00.000Z" })
    expect(result.outcome.kind).not.toBe("row-number-drift")
    expect(harness.state.jobs[0]?.status).not.toBe("interrupted")
  })
})

describe("응답 매핑", () => {
  it("drift는 409로, 본문에는 행 번호 수치만 담는다", () => {
    const outcome = { kind: "row-number-drift", drift: { latestSheetRow: SHEET_LAST_ROW, maxSourceRowNumber: MAX_SOURCE_ROW, difference: 6 } } as const
    expect(httpStatusForSyncOutcome(outcome)).toBe(409)
    const body = safeSyncResponseBody(outcome)
    expect(body).toEqual({ ok: false, reason: ROW_NUMBER_DRIFT_CODE, latestSheetRow: 14_952, maxSourceRowNumber: 14_958, difference: 6 })
    expect(JSON.stringify(body)).not.toMatch(/secret|Bearer|회사명|at\s+\w+\s+\(/i)
  })
})
