// 자동 연속 동기화 세션 표시 — 누적 수치·버튼 가용성·실패 행·안내 문구 회귀 방어.
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import {
  driftNoticeFromJob,
  syncJobNoticeMessage,
  toRowNumberDriftNotice,
  toSyncJobView,
  type SyncJobViewInput,
  type SyncSessionTotals,
} from "@/lib/admin/sync-job-view"
import { ManualSyncSubmitButton } from "@/app/admin/sync/submit-button"
import { SYNC_JOB_MAX_BATCHES, SYNC_SESSION_MAX_AUTO_JOBS } from "@/lib/sync/job-policy"

function jobInput(patch: Partial<SyncJobViewInput> = {}): SyncJobViewInput {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    status: "running",
    batchSize: 50,
    startRow: 2,
    currentRow: 152,
    targetLastRow: 231,
    latestSheetRow: 231,
    batchIndex: 3,
    processedCount: 150,
    insertedCount: 140,
    updatedCount: 5,
    skippedCount: 3,
    failedCount: 2,
    remainingCount: 80,
    chainIndex: 0,
    autoContinued: false,
    sessionStartedAt: "2026-07-29T00:00:00.000Z",
    totalSessionProcessed: 150,
    maxAutoJobs: SYNC_SESSION_MAX_AUTO_JOBS,
    cancelRequested: false,
    sessionStopReason: null,
    startedAt: "2026-07-29T00:00:00.000Z",
    lastTickAt: "2026-07-29T00:02:00.000Z",
    finishedAt: null,
    lastErrorCode: null,
    // 자동 처리 판정 기준 시각을 고정한다 (마지막 처리 30초 뒤 = 정상 대기).
    nowIso: "2026-07-29T00:02:30.000Z",
    ...patch,
  }
}

function totals(patch: Partial<SyncSessionTotals> = {}): SyncSessionTotals {
  return { jobCount: 1, insertedCount: 140, updatedCount: 5, skippedCount: 3, failedCount: 2, failedRowNumbers: [17, 42], ...patch }
}

describe("진행 수치", () => {
  it("시트 전체·동기화 완료·잔여를 행 번호에서 환산한다", () => {
    const view = toSyncJobView(jobInput())
    // 마지막 행 231 → 데이터 230행. 커서 152 → 151행까지 반영 = 150건.
    expect(view.sheetDataRows).toBe(230)
    expect(view.syncedRows).toBe(150)
    expect(view.remainingRows).toBe(80)
    expect(view.lastRowLabel).toBe("Row 151")
    expect(view.cursorLabel).toBe("Row 152 / 231")
  })

  it("현재 작업 번호와 배치 진행을 각각 상한과 함께 표시한다", () => {
    const view = toSyncJobView(jobInput({ chainIndex: 2 }))
    expect(view.sessionJobLabel).toBe(`3 / 최대 ${String(SYNC_SESSION_MAX_AUTO_JOBS + 1)}`)
    expect(view.batchLabel).toBe(`3 / 최대 ${String(SYNC_JOB_MAX_BATCHES)}`)
  })

  it("안전 상한을 화면에 명시한다", () => {
    const view = toSyncJobView(jobInput())
    expect(view.safetyLimitLabel).toContain("50,000행")
    expect(view.safetyLimitLabel).toContain("6시간")
    expect(view.safetyLimitLabel).toContain(`작업 ${String(SYNC_SESSION_MAX_AUTO_JOBS + 1)}개`)
  })

  it("아직 한 건도 처리하지 않았으면 마지막 처리 행은 비워 둔다", () => {
    expect(toSyncJobView(jobInput({ currentRow: 2, startRow: 2, processedCount: 0 })).lastRowLabel).toBe("-")
  })

  it("시각은 KST 표기로 바꾸고 진행 중이면 종료 시각을 진행 중으로 표시한다", () => {
    const view = toSyncJobView(jobInput())
    expect(view.sessionStartedAtLabel).toContain("2026-07-29")
    expect(view.finishedAtLabel).toBe("진행 중")
  })
})

describe("세션 누적", () => {
  it("후속 job까지 합산한 누적값을 표시한다", () => {
    const view = toSyncJobView(
      jobInput({ chainIndex: 1, autoContinued: true, totalSessionProcessed: 5050, insertedCount: 40 }),
      totals({ jobCount: 2, insertedCount: 4_900, updatedCount: 90, skippedCount: 40, failedCount: 20, failedRowNumbers: [17, 42, 99] }),
    )
    expect(view.sessionProcessedCount).toBe(5050)
    expect(view.sessionInsertedCount).toBe(4_900)
    expect(view.sessionUpdatedCount).toBe(90)
    expect(view.sessionSkippedCount).toBe(40)
    expect(view.sessionFailedCount).toBe(20)
  })

  it("세션 누적이 없으면 현재 job 값으로 대체한다", () => {
    const view = toSyncJobView(jobInput())
    expect(view.sessionInsertedCount).toBe(140)
    expect(view.sessionFailedCount).toBe(2)
  })
})

describe("상태 라벨과 버튼 가용성", () => {
  it("진행 중에는 재개 버튼을 노출하지 않고 중단 버튼만 준다", () => {
    const view = toSyncJobView(jobInput({ status: "running" }))
    expect(view.active).toBe(true)
    expect(view.resumable).toBe(false)
    expect(view.cancellable).toBe(true)
    expect(view.statusLabel).toBe("진행 중")
  })

  it("정상 backlog로 자동 후속 job이 이어지는 중에는 재개 버튼이 나오지 않는다", () => {
    // 상한 도달로 이 job은 partial_completed지만 세션은 자동으로 이어진다.
    const view = toSyncJobView(jobInput({ status: "partial_completed", remainingCount: 7_300, sessionStopReason: null, lastErrorCode: "batch-limit" }))
    expect(view.autoContinuing).toBe(true)
    expect(view.resumable).toBe(false)
    expect(view.statusLabel).toBe("진행 중")
    expect(view.noticeMessage).toContain("자동으로 이어집니다")
    expect(view.noticeMessage).toContain("추가 클릭은 필요하지 않습니다")
  })

  it("오류·정체·전역 상한에서만 재개 버튼이 나온다", () => {
    expect(toSyncJobView(jobInput({ status: "interrupted", remainingCount: 80, lastErrorCode: "chain-dispatch-failed" })).resumable).toBe(true)
    expect(toSyncJobView(jobInput({ status: "failed", remainingCount: 80, lastErrorCode: "batch-failed" })).resumable).toBe(true)
    expect(toSyncJobView(jobInput({ status: "partial_completed", remainingCount: 900, sessionStopReason: "session-row-limit" })).resumable).toBe(true)
    expect(toSyncJobView(jobInput({ status: "interrupted", remainingCount: 0 })).resumable).toBe(false)
  })

  it("완료된 job에는 재개·중단 버튼이 모두 없고 잔여 0을 안내한다", () => {
    const view = toSyncJobView(jobInput({ status: "completed", remainingCount: 0, currentRow: 232, failedCount: 0, finishedAt: "2026-07-29T00:10:00.000Z" }), totals({ failedCount: 0, failedRowNumbers: [] }))
    expect(view.resumable).toBe(false)
    expect(view.cancellable).toBe(false)
    expect(view.remainingRows).toBe(0)
    expect(view.noticeMessage).toContain("잔여 0건")
  })

  it("중단을 요청하면 중단 버튼이 사라지고 안내가 바뀐다", () => {
    const view = toSyncJobView(jobInput({ status: "running", cancelRequested: true }))
    expect(view.cancellable).toBe(false)
    expect(view.noticeMessage).toContain("진행 중인 배치까지만 처리")
  })
})

describe("실패 행 표시", () => {
  it("실패 건수와 행 번호를 함께 보여준다", () => {
    const view = toSyncJobView(jobInput(), totals({ failedCount: 2, failedRowNumbers: [17, 42] }))
    expect(view.hasFailedRows).toBe(true)
    expect(view.failedRowsLabel).toBe("2건 — Row 17, 42")
  })

  it("실패 행이 많으면 앞쪽만 나열하고 나머지 수를 표시한다", () => {
    const rows = Array.from({ length: 25 }, (_, index) => index + 10)
    const view = toSyncJobView(jobInput(), totals({ failedCount: 25, failedRowNumbers: rows }))
    expect(view.failedRowsLabel).toContain("25건")
    expect(view.failedRowsLabel).toContain("외 5건")
  })

  it("실패가 없으면 없음으로 표시한다", () => {
    const view = toSyncJobView(jobInput({ failedCount: 0 }), totals({ failedCount: 0, failedRowNumbers: [] }))
    expect(view.hasFailedRows).toBe(false)
    expect(view.failedRowsLabel).toBe("없음")
  })

  it("완료 상태에서도 실패 행이 있으면 재처리 필요를 함께 알린다", () => {
    const view = toSyncJobView(jobInput({ status: "completed", remainingCount: 0, failedCount: 3 }), totals({ failedCount: 3, failedRowNumbers: [5, 9, 12] }))
    expect(view.noticeMessage).toContain("재처리가 필요합니다")
  })
})

describe("안내 문구", () => {
  it("진행 중에는 화면을 닫아도 계속된다고 안내한다", () => {
    expect(toSyncJobView(jobInput({ status: "running", failedCount: 0 })).noticeMessage).toContain("화면을 닫아도")
  })

  it("전역 상한·취소 사유를 각각 안내한다", () => {
    expect(toSyncJobView(jobInput({ status: "partial_completed", sessionStopReason: "session-row-limit", failedCount: 0 })).noticeMessage).toContain("50,000행")
    expect(toSyncJobView(jobInput({ status: "partial_completed", sessionStopReason: "session-job-limit", failedCount: 0 })).noticeMessage).toContain("작업 수")
    expect(toSyncJobView(jobInput({ status: "partial_completed", sessionStopReason: "session-error-limit", failedCount: 0 })).noticeMessage).toContain("같은 오류가 연속")
    expect(toSyncJobView(jobInput({ status: "partial_completed", sessionStopReason: "session-time-limit", failedCount: 0 })).noticeMessage).toContain("허용 시간")
    expect(toSyncJobView(jobInput({ status: "cancelled", sessionStopReason: "cancelled", failedCount: 0 })).noticeMessage).toContain("사용자 중단 요청")
  })

  it("예전 self-chain 기록은 내부 구조 대신 보존·재개 안내로 읽힌다", () => {
    const view = toSyncJobView(
      jobInput({
        status: "interrupted",
        batchIndex: 9,
        processedCount: 450,
        remainingCount: 5_150,
        failedCount: 0,
        lastErrorCode: "chain-dispatch-http-508",
        lastErrorMessage: "self-chain 접수 실패: HTTP 508, 3회 시도, 총 2.0초",
      }),
      totals({ failedCount: 0, failedRowNumbers: [] }),
    )

    expect(view.noticeMessage).toContain("450건")
    expect(view.noticeMessage).toContain("이어서 진행")
    expect(view.resumable).toBe(true)
    // 내부 구조 용어는 사용자 문구에 남기지 않는다.
    expect(view.noticeMessage).not.toMatch(/self-chain|발사|dispatch|HTTP/i)
  })

  it("자동 처리 상태를 대기·처리 중·지연으로 구분한다", () => {
    const waiting = toSyncJobView(jobInput({ status: "running", failedCount: 0, leaseExpiresAt: null, lastTickAt: "2026-07-29T00:02:00.000Z", nowIso: "2026-07-29T00:02:30.000Z" }))
    expect(waiting.pumpBusy).toBe(false)
    expect(waiting.pumpDelayed).toBe(false)
    expect(waiting.pumpStateLabel).toContain("다음 자동 처리 대기")

    const busy = toSyncJobView(jobInput({ status: "running", failedCount: 0, leaseExpiresAt: "2026-07-29T00:04:00.000Z", nowIso: "2026-07-29T00:02:30.000Z" }))
    expect(busy.pumpBusy).toBe(true)
    expect(busy.pumpStateLabel).toBe("처리 중")

    // 마지막 처리 이후 lease(120초) + 주기(60초)를 넘긴 경우만 지연으로 본다.
    const delayed = toSyncJobView(jobInput({ status: "running", failedCount: 0, leaseExpiresAt: null, lastTickAt: "2026-07-29T00:02:00.000Z", nowIso: "2026-07-29T00:06:00.000Z" }))
    expect(delayed.pumpDelayed).toBe(true)
    expect(delayed.noticeMessage).toContain("지연")
  })

  it("자동 처리 횟수와 실행 만료 예정을 표시한다", () => {
    const view = toSyncJobView(jobInput({ status: "running", failedCount: 0, pumpAttempt: 12, leaseExpiresAt: "2026-07-29T00:04:00.000Z", nowIso: "2026-07-29T00:02:30.000Z" }))
    expect(view.pumpAttemptLabel).toBe("12회")
    expect(view.leaseExpiresAtLabel).not.toBe("-")
  })

  it("안내 문구에 내부 코드·토큰·stack trace가 없다", () => {
    for (const status of ["running", "completed", "partial_completed", "interrupted", "failed", "cancelled"] as const) {
      const message = toSyncJobView(jobInput({ status, lastErrorCode: "chain-dispatch-failed" })).noticeMessage
      expect(message).not.toMatch(/token|secret|Bearer|supabase|at\s+\w+\s+\(/i)
    }
  })

  it("시작 결과별 안내를 한글로 돌려준다", () => {
    expect(syncJobNoticeMessage("started", undefined, 900)).toContain("900건")
    expect(syncJobNoticeMessage("started", undefined, 900)).toContain("자동으로 이어가고")
    expect(syncJobNoticeMessage("resumed", undefined, 80)).toContain("이어서 진행")
    expect(syncJobNoticeMessage("cancelled", undefined, 0)).toContain("중단을 요청")
    expect(syncJobNoticeMessage("already-active", undefined, 0)).toContain("이미 자동 동기화가 진행 중")
    expect(syncJobNoticeMessage("nothing-to-sync", undefined, 0)).toContain("잔여 0건")
    expect(syncJobNoticeMessage("failed", "resume-conflict", 0)).toContain("다른 처리가 먼저 진행")
    expect(syncJobNoticeMessage("failed", "not-active", 0)).toContain("이미 종료된 작업")
    expect(syncJobNoticeMessage(undefined, undefined, 0)).toBeUndefined()
  })
})

describe("행번호 축소 경고", () => {
  it("자동 경로가 막히면 수치와 함께 경고를 만든다", () => {
    const notice = toRowNumberDriftNotice({ job: "row-number-drift", sync: undefined, sheetRow: 14_952, maxRow: 14_958, difference: 6 })
    expect(notice).toMatchObject({ latestSheetRow: 14_952, maxSourceRowNumber: 14_958, difference: 6, blockedPath: "auto" })
    expect(notice?.message).toContain("행번호 정합성을 복구한 뒤")
  })

  it("수동 50건 경로가 막힌 것도 구분해 표시한다", () => {
    const notice = toRowNumberDriftNotice({ job: undefined, sync: "row-number-drift", sheetRow: 14_952, maxRow: 14_958, difference: 6 })
    expect(notice?.blockedPath).toBe("manual")
  })

  it("drift가 아니면 경고를 만들지 않는다", () => {
    expect(toRowNumberDriftNotice({ job: "started", sync: undefined, sheetRow: 0, maxRow: 0, difference: 0 })).toBeUndefined()
  })

  it("쿼리가 사라져도 drift로 멈춘 job에서 경고를 복원한다", () => {
    const notice = driftNoticeFromJob(jobInput({ status: "interrupted", lastErrorCode: "row-number-drift", currentRow: 14_959, latestSheetRow: 14_952 }))
    expect(notice).toMatchObject({ latestSheetRow: 14_952, maxSourceRowNumber: 14_958, difference: 6 })
  })

  it("drift가 아닌 job에서는 경고를 복원하지 않는다", () => {
    expect(driftNoticeFromJob(jobInput({ status: "interrupted", lastErrorCode: "chain-dispatch-failed" }))).toBeUndefined()
    expect(driftNoticeFromJob(null)).toBeUndefined()
  })

  it("drift로 멈춘 job에는 재개 버튼을 노출하지 않는다", () => {
    const view = toSyncJobView(jobInput({ status: "interrupted", lastErrorCode: "row-number-drift", remainingCount: 100 }))
    expect(view.resumable).toBe(false)
    expect(view.noticeMessage).toContain("행번호 정합성을 복구하기 전에는 재개할 수 없습니다")
  })

  it("drift는 일반 안내 문구로 중복 표시되지 않는다", () => {
    expect(syncJobNoticeMessage("row-number-drift", undefined, 0)).toBeUndefined()
  })
})

describe("브라우저 자동 루프 제거", () => {
  it("수동 버튼은 1회 실행만 제출하고 자동 재제출 버튼이 없다", () => {
    const markup = renderToStaticMarkup(<ManualSyncSubmitButton />)
    expect(markup).toContain("한 번 실행 (50건)")
    expect(markup).not.toContain("남은 항목 자동 동기화")
    expect(markup).not.toContain('name="auto"')
  })
})
