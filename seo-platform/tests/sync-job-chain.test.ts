// 자동 연속 동기화 self-chain — 커서·상한·토큰 회전·재개·시트 증가 대응 회귀 방어.
// Google API·Supabase는 전부 주입 mock이다 (실제 동기화·DB 쓰기 없음).
import { describe, expect, it, vi } from "vitest"

import {
  computeBatchWindow,
  decideNextStep,
  firstUnsyncedRowNumber,
  hashTickToken,
  isAllowedSyncChainBaseUrl,
  isStaleTick,
  lastSheetRowNumber,
  mintTickToken,
  parseSyncTickRequest,
  remainingRowCount,
  resolveSyncChainEnvironment,
  safeSyncResponseBody,
  httpStatusForSyncOutcome,
  verifyTickToken,
  SYNC_CHAIN_BASE_URL,
  SYNC_JOB_BATCH_SIZE,
  SYNC_JOB_MAX_BATCHES,
} from "@/lib/sync/job-policy"
import { executeSyncTick, resumeSyncJob, startSyncJob, type SyncJobDependencies, type SyncJobRow } from "@/lib/sync/job-service"
import { dispatchTick } from "@/lib/sync/job-chain"
import type { SyncSummary } from "@/lib/sync/types"

// ── 테스트용 인메모리 job 저장소 ─────────────────────────────────
function makeJob(patch: Partial<SyncJobRow> = {}): SyncJobRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
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
  readonly state: { job: SyncJobRow | null; sheetRowCount: number; batchCalls: { firstDataRowNumber: number; count: number; batchIndex: number }[] }
  readonly setSheetRows: (count: number) => void
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
  const state = {
    job: options.job ?? null,
    sheetRowCount: options.sheetRowCount ?? 0,
    batchCalls: [] as { firstDataRowNumber: number; count: number; batchIndex: number }[],
  }

  const dependencies: SyncJobDependencies = {
    repository: {
      findActiveJob: () => Promise.resolve(state.job !== null && (state.job.status === "queued" || state.job.status === "running") ? state.job : null),
      findJobById: () => Promise.resolve(state.job),
      findLatestJob: () => Promise.resolve(state.job),
      createJob: (input) => {
        state.job = makeJob({
          status: "queued",
          source_sheet_name: input.sourceSheetName,
          start_row: input.startRow,
          current_row: input.startRow,
          target_last_row: input.targetLastRow,
          latest_sheet_row: input.targetLastRow,
          remaining_count: input.remaining,
          next_tick_token_hash: input.tokenHash,
        })
        return Promise.resolve(state.job)
      },
      claimTick: (input) => {
        const current = state.job
        if (current === null || (current.status !== "queued" && current.status !== "running")) {
          return Promise.resolve(null)
        }
        if (current.next_tick_token_hash !== input.expectedTokenHash) {
          return Promise.resolve(null)
        }
        state.job = { ...current, status: "running", next_tick_token_hash: input.nextTokenHash, last_tick_at: input.nowIso }
        return Promise.resolve(state.job)
      },
      reviveJob: (input) => {
        const current = state.job
        if (current === null || !["partial_completed", "interrupted", "failed"].includes(current.status)) {
          return Promise.resolve(null)
        }
        state.job = { ...current, status: "running", next_tick_token_hash: input.nextTokenHash, last_tick_at: input.nowIso, finished_at: null, last_error_code: null }
        return Promise.resolve(state.job)
      },
      recordProgress: (input) => {
        if (state.job !== null) {
          state.job = {
            ...state.job,
            batch_index: input.progress.batchIndex,
            current_row: input.progress.currentRow,
            latest_sheet_row: input.progress.latestSheetRow,
            processed_count: input.progress.processedCount,
            inserted_count: input.progress.insertedCount,
            updated_count: input.progress.updatedCount,
            skipped_count: input.progress.skippedCount,
            failed_count: input.progress.failedCount,
            remaining_count: input.progress.remainingCount,
          }
        }
        return Promise.resolve()
      },
      finishJob: (input) => {
        if (state.job !== null) {
          state.job = { ...state.job, status: input.status, finished_at: input.nowIso, last_error_code: input.errorCode ?? null }
        }
        return Promise.resolve()
      },
      markInterrupted: (input) => {
        if (state.job !== null) {
          state.job = { ...state.job, status: "interrupted", last_error_code: input.errorCode }
        }
        return Promise.resolve()
      },
    },
    readSheet: () => {
      if (options.readSheetThrows === true) {
        return Promise.reject(new Error("sheet read failed"))
      }
      return Promise.resolve({ sheetName: "기업 DB", rows: Array.from({ length: state.sheetRowCount }, (_, index) => ({ 회사명: `장소 ${String(index)}` })) })
    },
    latestSourceRowNumber: () => Promise.resolve(options.latestSourceRowNumber ?? null),
    runBatch: (input) => {
      if (options.runBatchThrows === true) {
        return Promise.reject(new Error("batch failed"))
      }
      state.batchCalls.push({ firstDataRowNumber: input.firstDataRowNumber, count: input.rows.length, batchIndex: input.batchIndex })
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
  }
}

// 첫 tick부터 job이 끝날 때까지 self-chain을 그대로 재현한다 (route의 after() 역할).
async function drain(harness: Harness, firstToken: string, maxTicks = 200): Promise<{ ticks: number; lastOutcomeKind: string }> {
  let token: string | null = firstToken
  let ticks = 0
  let lastOutcomeKind = "none"
  while (token !== null && ticks < maxTicks) {
    const result = await executeSyncTick(harness.dependencies, {
      jobId: harness.state.job?.id ?? "",
      token,
      nowIso: "2026-07-29T00:00:00.000Z",
    })
    ticks += 1
    lastOutcomeKind = result.outcome.kind
    token = result.nextTick?.token ?? null
  }
  return { ticks, lastOutcomeKind }
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
    // 상한(5,000행) 잔여가 20건뿐이면 20건만 잡는다.
    expect(computeBatchWindow({ currentRow: 2, latestSheetRow: 9999, batchSize: 50, processedCount: 4980 }).count).toBe(20)
  })

  it("잔여 0이면 완료, 상한 도달이면 limit-reached로 판정한다", () => {
    expect(decideNextStep({ currentRow: 2, latestSheetRow: 1, batchSize: 50, batchIndex: 0, processedCount: 0 })).toEqual({ kind: "completed" })
    expect(decideNextStep({ currentRow: 2, latestSheetRow: 500, batchSize: 50, batchIndex: SYNC_JOB_MAX_BATCHES, processedCount: 5000 })).toEqual({
      kind: "limit-reached",
      remaining: 499,
    })
  })
})

describe("1회용 tick 토큰", () => {
  it("발급 토큰은 자기 해시로만 검증되고 다른 토큰은 거부된다", () => {
    const minted = mintTickToken()
    expect(verifyTickToken(minted.token, minted.tokenHash)).toBe(true)
    expect(verifyTickToken(mintTickToken().token, minted.tokenHash)).toBe(false)
    expect(verifyTickToken(minted.token, null)).toBe(false)
    expect(verifyTickToken("", minted.tokenHash)).toBe(false)
  })

  it("해시는 원문을 담지 않는다", () => {
    const minted = mintTickToken()
    expect(minted.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(minted.tokenHash).not.toContain(minted.token)
    expect(hashTickToken(minted.token)).toBe(minted.tokenHash)
  })
})

describe("self-chain 대상 URL 고정", () => {
  it("운영 호스트만 허용하고 다른 vercel.app·쿼리·포트·자격정보는 거부한다", () => {
    expect(isAllowedSyncChainBaseUrl(SYNC_CHAIN_BASE_URL)).toBe(true)
    expect(isAllowedSyncChainBaseUrl("https://flowercrm-seo.vercel.app/")).toBe(true)
    expect(isAllowedSyncChainBaseUrl("https://evil.vercel.app")).toBe(false)
    expect(isAllowedSyncChainBaseUrl("https://flowercrm-seo.vercel.app?x=1")).toBe(false)
    expect(isAllowedSyncChainBaseUrl("https://flowercrm-seo.vercel.app:8443")).toBe(false)
    expect(isAllowedSyncChainBaseUrl("https://a:b@flowercrm-seo.vercel.app")).toBe(false)
    expect(isAllowedSyncChainBaseUrl("http://flowercrm-seo.vercel.app")).toBe(false)
    expect(isAllowedSyncChainBaseUrl("http://localhost:3000", { allowLocalhost: true })).toBe(true)
  })

  it("환경 게이트는 기존 수동 동기화와 같은 자격만 요구하고 신규 환경변수를 만들지 않는다", () => {
    const full = {
      NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "service",
      GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
      GOOGLE_SPREADSHEET_ID: "sheet",
    }
    expect(resolveSyncChainEnvironment(full)).toEqual({ ok: true, baseUrl: SYNC_CHAIN_BASE_URL })
    expect(resolveSyncChainEnvironment({ ...full, SUPABASE_SERVICE_ROLE_KEY: undefined })).toEqual({ ok: false, blockedBy: "supabase-env-missing" })
    expect(resolveSyncChainEnvironment({ ...full, GOOGLE_SPREADSHEET_ID: undefined })).toEqual({ ok: false, blockedBy: "google-env-missing" })
  })
})

describe("job 시작", () => {
  it("미동기화 0건이면 job을 만들지 않고 즉시 끝낸다", async () => {
    const harness = createHarness({ sheetRowCount: 10, latestSourceRowNumber: 11 })
    const result = await startSyncJob(harness.dependencies, { createdBy: "admin@example.com", nowIso: "2026-07-29T00:00:00.000Z" })
    expect(result.kind).toBe("nothing-to-sync")
    expect(harness.state.job).toBeNull()
  })

  it("미동기화가 있으면 job과 첫 tick 토큰을 만든다", async () => {
    const harness = createHarness({ sheetRowCount: 60, latestSourceRowNumber: 11 })
    const result = await startSyncJob(harness.dependencies, { createdBy: "admin@example.com", nowIso: "2026-07-29T00:00:00.000Z" })
    // 시트 60행 → 마지막 데이터 행 61, 이미 11행까지 반영 → 12~61행 50건이 잔여.
    expect(result).toMatchObject({ kind: "started", remaining: 50 })
    expect(harness.state.job?.current_row).toBe(12)
  })

  it("이미 진행 중이면 새 job을 만들지 않는다 (중복 클릭 차단)", async () => {
    const harness = createHarness({ job: makeJob({ status: "running" }), sheetRowCount: 500 })
    const result = await startSyncJob(harness.dependencies, { createdBy: null, nowIso: "2026-07-29T00:00:00.000Z" })
    expect(result.kind).toBe("already-active")
  })
})

describe("self-chain 연속 처리", () => {
  it("미동기화 1건 → 1배치로 완료", async () => {
    const harness = createHarness({ sheetRowCount: 1 })
    const started = await startSyncJob(harness.dependencies, { createdBy: null, nowIso: "2026-07-29T00:00:00.000Z" })
    if (started.kind !== "started") {
      throw new Error("expected started")
    }
    const drained = await drain(harness, started.token)
    expect(drained.lastOutcomeKind).toBe("completed")
    expect(harness.state.batchCalls).toEqual([{ firstDataRowNumber: 2, count: 1, batchIndex: 1 }])
    expect(harness.state.job?.status).toBe("completed")
    expect(harness.state.job?.remaining_count).toBe(0)
  })

  it("정확히 50건 → 1배치로 완료 (추가 tick 없음)", async () => {
    const harness = createHarness({ sheetRowCount: 50 })
    const started = await startSyncJob(harness.dependencies, { createdBy: null, nowIso: "2026-07-29T00:00:00.000Z" })
    if (started.kind !== "started") {
      throw new Error("expected started")
    }
    const drained = await drain(harness, started.token)
    expect(harness.state.batchCalls).toHaveLength(1)
    expect(drained.lastOutcomeKind).toBe("completed")
  })

  it("51건 → 2배치, 두 번째 배치는 정확히 1건", async () => {
    const harness = createHarness({ sheetRowCount: 51 })
    const started = await startSyncJob(harness.dependencies, { createdBy: null, nowIso: "2026-07-29T00:00:00.000Z" })
    if (started.kind !== "started") {
      throw new Error("expected started")
    }
    await drain(harness, started.token)
    expect(harness.state.batchCalls).toEqual([
      { firstDataRowNumber: 2, count: 50, batchIndex: 1 },
      { firstDataRowNumber: 52, count: 1, batchIndex: 2 },
    ])
    expect(harness.state.job?.status).toBe("completed")
  })

  it("230건 → 5배치 (50·50·50·50·30), 행 구간이 겹치지 않는다", async () => {
    const harness = createHarness({ sheetRowCount: 230 })
    const started = await startSyncJob(harness.dependencies, { createdBy: null, nowIso: "2026-07-29T00:00:00.000Z" })
    if (started.kind !== "started") {
      throw new Error("expected started")
    }
    await drain(harness, started.token)
    expect(harness.state.batchCalls.map((call) => call.count)).toEqual([50, 50, 50, 50, 30])
    expect(harness.state.batchCalls.map((call) => call.firstDataRowNumber)).toEqual([2, 52, 102, 152, 202])
    expect(harness.state.job?.processed_count).toBe(230)
  })

  it("처리 도중 시트가 늘어나면 잔여를 갱신해 계속 따라잡는다", async () => {
    const harness = createHarness({ sheetRowCount: 50 })
    const started = await startSyncJob(harness.dependencies, { createdBy: null, nowIso: "2026-07-29T00:00:00.000Z" })
    if (started.kind !== "started") {
      throw new Error("expected started")
    }
    // 첫 tick 직후 시트에 30건이 추가된 상황.
    const first = await executeSyncTick(harness.dependencies, { jobId: harness.state.job?.id ?? "", token: started.token, nowIso: "2026-07-29T00:00:00.000Z" })
    expect(first.outcome.kind).toBe("completed")

    // 같은 job은 이미 완료됐으므로 새 job이 시작돼야 한다 — 시트 증가 반영은 다음 job이 맡는다.
    harness.state.job = null
    harness.setSheetRows(80)
    const second = await startSyncJob(harness.dependencies, { createdBy: null, nowIso: "2026-07-29T00:01:00.000Z" })
    expect(second).toMatchObject({ kind: "started" })
  })

  it("진행 중 시트가 늘어나면 같은 job이 그대로 이어서 처리한다", async () => {
    const harness = createHarness({ sheetRowCount: 120 })
    const started = await startSyncJob(harness.dependencies, { createdBy: null, nowIso: "2026-07-29T00:00:00.000Z" })
    if (started.kind !== "started") {
      throw new Error("expected started")
    }
    const first = await executeSyncTick(harness.dependencies, { jobId: harness.state.job?.id ?? "", token: started.token, nowIso: "2026-07-29T00:00:00.000Z" })
    // 1배치(50건) 처리 후 시트가 120 → 200으로 증가.
    harness.setSheetRows(200)
    expect(first.nextTick).not.toBeNull()
    await drain(harness, first.nextTick?.token ?? "")
    expect(harness.state.job?.processed_count).toBe(200)
    expect(harness.state.job?.status).toBe("completed")
    expect(harness.state.job?.remaining_count).toBe(0)
  })
})

describe("중복 호출과 재개", () => {
  it("이미 회전된 토큰으로 온 지연 chain은 no-op이다 (중복 처리 없음)", async () => {
    const harness = createHarness({ sheetRowCount: 120 })
    const started = await startSyncJob(harness.dependencies, { createdBy: null, nowIso: "2026-07-29T00:00:00.000Z" })
    if (started.kind !== "started") {
      throw new Error("expected started")
    }
    await executeSyncTick(harness.dependencies, { jobId: harness.state.job?.id ?? "", token: started.token, nowIso: "2026-07-29T00:00:00.000Z" })
    const batchesAfterFirst = harness.state.batchCalls.length

    // 같은 토큰으로 한 번 더 도착 — 처리하지 않는다.
    const replay = await executeSyncTick(harness.dependencies, { jobId: harness.state.job?.id ?? "", token: started.token, nowIso: "2026-07-29T00:00:01.000Z" })
    expect(replay.outcome).toEqual({ kind: "noop", reason: "stale-tick-token" })
    expect(replay.nextTick).toBeNull()
    expect(harness.state.batchCalls).toHaveLength(batchesAfterFirst)
  })

  it("종료된 job에 도착한 chain은 no-op이다", async () => {
    const harness = createHarness({ job: makeJob({ status: "completed", next_tick_token_hash: "abc" }), sheetRowCount: 10 })
    const result = await executeSyncTick(harness.dependencies, { jobId: harness.state.job?.id ?? "", token: "anything", nowIso: "2026-07-29T00:00:00.000Z" })
    expect(result.outcome).toEqual({ kind: "noop", reason: "terminal-completed" })
  })

  it("존재하지 않는 job은 인증 실패로 처리한다", async () => {
    const harness = createHarness({ job: null })
    const result = await executeSyncTick(harness.dependencies, { jobId: "22222222-2222-4222-8222-222222222222", token: "t", nowIso: "2026-07-29T00:00:00.000Z" })
    expect(result.outcome).toEqual({ kind: "unauthorized", reason: "unknown-job" })
  })

  it("정체된 job을 같은 커서에서 이어서 진행한다 (새 job 없음·중복 없음)", async () => {
    const minted = mintTickToken()
    const harness = createHarness({
      job: makeJob({ status: "interrupted", current_row: 52, latest_sheet_row: 231, remaining_count: 180, processed_count: 50, batch_index: 1, next_tick_token_hash: minted.tokenHash }),
      sheetRowCount: 230,
    })
    const resumed = await resumeSyncJob(harness.dependencies, { jobId: harness.state.job?.id ?? "", nowIso: "2026-07-29T00:05:00.000Z" })
    expect(resumed).toMatchObject({ kind: "started", remaining: 180 })
    if (resumed.kind !== "started") {
      throw new Error("expected started")
    }
    await drain(harness, resumed.token)
    // 이미 처리한 2~51행은 다시 읽지 않는다.
    expect(harness.state.batchCalls[0]?.firstDataRowNumber).toBe(52)
    expect(harness.state.job?.status).toBe("completed")
  })

  it("진행 중 job이 있으면 재개는 새 실행을 만들지 않는다", async () => {
    const harness = createHarness({ job: makeJob({ status: "running" }) })
    const resumed = await resumeSyncJob(harness.dependencies, { jobId: harness.state.job?.id ?? "", nowIso: "2026-07-29T00:00:00.000Z" })
    expect(resumed.kind).toBe("already-active")
  })
})

describe("상한과 실패 처리", () => {
  it("상한 도달 시 partial_completed로 닫고 잔여를 남긴다 (실패 아님)", async () => {
    const harness = createHarness({
      job: makeJob({ status: "running", batch_index: SYNC_JOB_MAX_BATCHES, processed_count: 5000, current_row: 5002, next_tick_token_hash: hashTickToken("tok") }),
      sheetRowCount: 6000,
    })
    const result = await executeSyncTick(harness.dependencies, { jobId: harness.state.job?.id ?? "", token: "tok", nowIso: "2026-07-29T00:00:00.000Z" })
    expect(result.outcome).toMatchObject({ kind: "partial", processed: 5000 })
    expect(result.nextTick).toBeNull()
    expect(harness.state.job?.status).toBe("partial_completed")
    expect(harness.state.job?.last_error_code).toBe("batch-limit")
    expect(harness.state.job?.remaining_count).toBeGreaterThan(0)
  })

  it("행 파싱 실패가 섞여도 커서가 전진해 다음 50건으로 넘어간다", async () => {
    // 배치마다 10건 실패 — 예전 브라우저 자동 루프는 여기서 멈췄다.
    const harness = createHarness({ sheetRowCount: 120, summary: { inserted: 40, failed: 10 } })
    const started = await startSyncJob(harness.dependencies, { createdBy: null, nowIso: "2026-07-29T00:00:00.000Z" })
    if (started.kind !== "started") {
      throw new Error("expected started")
    }
    await drain(harness, started.token)
    expect(harness.state.batchCalls.map((call) => call.firstDataRowNumber)).toEqual([2, 52, 102])
    expect(harness.state.job?.status).toBe("completed")
    expect(harness.state.job?.failed_count).toBe(30)
    expect(harness.state.job?.remaining_count).toBe(0)
  })

  it("시트 읽기 실패는 interrupted로 남겨 재개할 수 있게 한다", async () => {
    const harness = createHarness({ job: makeJob({ status: "running", next_tick_token_hash: hashTickToken("tok") }), readSheetThrows: true })
    const result = await executeSyncTick(harness.dependencies, { jobId: harness.state.job?.id ?? "", token: "tok", nowIso: "2026-07-29T00:00:00.000Z" })
    expect(result.outcome).toEqual({ kind: "failed", errorCode: "sheet-read-failed" })
    expect(harness.state.job?.status).toBe("interrupted")
  })

  it("배치 처리가 터지면 커서를 전진시키지 않고 failed로 남긴다 (같은 창부터 재시도)", async () => {
    const harness = createHarness({
      job: makeJob({ status: "running", current_row: 52, next_tick_token_hash: hashTickToken("tok") }),
      sheetRowCount: 230,
      runBatchThrows: true,
    })
    const result = await executeSyncTick(harness.dependencies, { jobId: harness.state.job?.id ?? "", token: "tok", nowIso: "2026-07-29T00:00:00.000Z" })
    expect(result.outcome).toEqual({ kind: "failed", errorCode: "batch-failed" })
    expect(harness.state.job?.status).toBe("failed")
    expect(harness.state.job?.current_row).toBe(52)
  })

  it("마지막 tick 이후 오래 지나면 정체로 판정한다", () => {
    expect(isStaleTick(null, "2026-07-29T00:10:00.000Z")).toBe(false)
    expect(isStaleTick("2026-07-29T00:00:00.000Z", "2026-07-29T00:01:00.000Z")).toBe(false)
    expect(isStaleTick("2026-07-29T00:00:00.000Z", "2026-07-29T00:06:00.000Z")).toBe(true)
  })
})

describe("chain 발사", () => {
  it("토큰을 Bearer로 싣고 redirect를 따라가지 않는다", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })))
    await dispatchTick({ jobId: "job-1", token: "tok-1" }, "https://flowercrm-seo.vercel.app", { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }]
    expect(url).toBe("https://flowercrm-seo.vercel.app/api/sync/chain")
    expect(init.headers["authorization"]).toBe("Bearer tok-1")
    expect(init.redirect).toBe("error")
    expect(init.body).toBe(JSON.stringify({ mode: "tick", jobId: "job-1" }))
  })

  it("발사 실패는 정체 표식으로만 남기고 던지지 않는다", async () => {
    const onDispatchFailed = vi.fn(() => Promise.resolve())
    const fetchImpl = vi.fn(() => Promise.reject(new Error("network down")))
    await expect(
      dispatchTick({ jobId: "job-1", token: "tok-1" }, "https://flowercrm-seo.vercel.app", { fetchImpl: fetchImpl as unknown as typeof fetch, onDispatchFailed }),
    ).resolves.toBeUndefined()
    expect(onDispatchFailed).toHaveBeenCalledWith("job-1")
  })
})

describe("요청 파싱과 응답 매핑", () => {
  it("tick 요청만 받아들이고 그 외는 invalid로 거부한다", () => {
    expect(parseSyncTickRequest({ mode: "tick", jobId: "11111111-1111-4111-8111-111111111111" })).toEqual({
      mode: "tick",
      jobId: "11111111-1111-4111-8111-111111111111",
    })
    expect(parseSyncTickRequest({ mode: "tick", jobId: "not-a-uuid" })).toEqual({ mode: "invalid" })
    expect(parseSyncTickRequest({ mode: "start" })).toEqual({ mode: "invalid" })
    expect(parseSyncTickRequest(null)).toEqual({ mode: "invalid" })
    expect(parseSyncTickRequest([])).toEqual({ mode: "invalid" })
  })

  it("응답 본문에 토큰 원문·시트 내용·stack trace를 담지 않는다", () => {
    // 실제 발급 토큰이 본문에 새는지 본다 ("stale-tick-token" 같은 안전한 사유 코드는 허용).
    const minted = mintTickToken()
    const bodies = [
      safeSyncResponseBody({ kind: "processed", jobStatus: "running", processed: 50, remaining: 180 }),
      safeSyncResponseBody({ kind: "completed", processed: 230 }),
      safeSyncResponseBody({ kind: "partial", processed: 5000, remaining: 900 }),
      safeSyncResponseBody({ kind: "noop", reason: "stale-tick-token" }),
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

  it("결과 종류를 HTTP 상태로 매핑한다", () => {
    expect(httpStatusForSyncOutcome({ kind: "processed", jobStatus: "running", processed: 1, remaining: 1 })).toBe(200)
    expect(httpStatusForSyncOutcome({ kind: "noop", reason: "duplicate-tick" })).toBe(200)
    expect(httpStatusForSyncOutcome({ kind: "unauthorized", reason: "unknown-job" })).toBe(401)
    expect(httpStatusForSyncOutcome({ kind: "conflict", reason: "google-env-missing" })).toBe(409)
    expect(httpStatusForSyncOutcome({ kind: "failed", errorCode: "internal" })).toBe(500)
  })
})
