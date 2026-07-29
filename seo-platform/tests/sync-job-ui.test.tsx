// 자동 연속 동기화 진행 표시 — 수치·버튼 가용성·안내 문구 회귀 방어.
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { syncJobNoticeMessage, toSyncJobView, type SyncJobViewInput } from "@/lib/admin/sync-job-view"
import { ManualSyncSubmitButton } from "@/app/admin/sync/submit-button"
import { SYNC_JOB_MAX_BATCHES } from "@/lib/sync/job-policy"

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
    startedAt: "2026-07-29T00:00:00.000Z",
    lastTickAt: "2026-07-29T00:02:00.000Z",
    finishedAt: null,
    lastErrorCode: null,
    ...patch,
  }
}

describe("진행 수치", () => {
  it("시트 전체·동기화 완료·잔여를 행 번호에서 환산한다", () => {
    const view = toSyncJobView(jobInput())
    // 마지막 행 231 → 데이터 230행. 커서 152 → 151행까지 반영 = 150건.
    expect(view.sheetDataRows).toBe(230)
    expect(view.syncedRows).toBe(150)
    expect(view.remainingRows).toBe(80)
    expect(view.processedCount).toBe(150)
    expect(view.lastRowLabel).toBe("Row 151")
  })

  it("배치 진행은 상한과 함께 표시한다", () => {
    expect(toSyncJobView(jobInput()).batchLabel).toBe(`3 / 최대 ${String(SYNC_JOB_MAX_BATCHES)}`)
  })

  it("아직 한 건도 처리하지 않았으면 마지막 처리 행은 비워 둔다", () => {
    expect(toSyncJobView(jobInput({ currentRow: 2, startRow: 2, processedCount: 0 })).lastRowLabel).toBe("-")
  })

  it("시각은 KST 표기로 바꾸고 진행 중이면 종료 시각을 진행 중으로 표시한다", () => {
    const view = toSyncJobView(jobInput())
    expect(view.startedAtLabel).toContain("2026-07-29")
    expect(view.finishedAtLabel).toBe("진행 중")
  })
})

describe("상태 라벨과 재개 가능 여부", () => {
  it("진행 중에는 재개 버튼을 노출하지 않는다", () => {
    const view = toSyncJobView(jobInput({ status: "running" }))
    expect(view.active).toBe(true)
    expect(view.resumable).toBe(false)
    expect(view.statusLabel).toBe("진행 중")
  })

  it("상한 도달·정체·오류는 잔여가 있을 때만 재개 가능하다", () => {
    expect(toSyncJobView(jobInput({ status: "partial_completed", remainingCount: 900 })).resumable).toBe(true)
    expect(toSyncJobView(jobInput({ status: "interrupted", remainingCount: 80 })).resumable).toBe(true)
    expect(toSyncJobView(jobInput({ status: "failed", remainingCount: 80 })).resumable).toBe(true)
    expect(toSyncJobView(jobInput({ status: "interrupted", remainingCount: 0 })).resumable).toBe(false)
  })

  it("완료된 job에는 재개 버튼이 없고 잔여 0을 안내한다", () => {
    const view = toSyncJobView(jobInput({ status: "completed", remainingCount: 0, currentRow: 232, finishedAt: "2026-07-29T00:10:00.000Z" }))
    expect(view.resumable).toBe(false)
    expect(view.remainingRows).toBe(0)
    expect(view.noticeMessage).toContain("잔여 0건")
  })
})

describe("안내 문구", () => {
  it("진행 중에는 화면을 닫아도 계속된다고 안내한다", () => {
    expect(toSyncJobView(jobInput({ status: "running" })).noticeMessage).toContain("화면을 닫아도")
  })

  it("상한 도달·chain 유실은 원인과 재개 방법을 안내한다", () => {
    expect(toSyncJobView(jobInput({ status: "partial_completed", lastErrorCode: "batch-limit" })).noticeMessage).toContain("이어서 진행")
    expect(toSyncJobView(jobInput({ status: "interrupted", lastErrorCode: "chain-dispatch-failed" })).noticeMessage).toContain("이어서 진행")
  })

  it("안내 문구에 내부 코드·토큰·stack trace가 없다", () => {
    for (const status of ["running", "completed", "partial_completed", "interrupted", "failed"] as const) {
      const message = toSyncJobView(jobInput({ status, lastErrorCode: "chain-dispatch-failed" })).noticeMessage
      expect(message).not.toMatch(/token|secret|Bearer|supabase|at\s+\w+\s+\(/i)
    }
  })

  it("시작 결과별 안내를 한글로 돌려준다", () => {
    expect(syncJobNoticeMessage("started", undefined, 900)).toContain("900건")
    expect(syncJobNoticeMessage("resumed", undefined, 80)).toContain("이어서 진행")
    expect(syncJobNoticeMessage("already-active", undefined, 0)).toContain("이미 자동 동기화가 진행 중")
    expect(syncJobNoticeMessage("nothing-to-sync", undefined, 0)).toContain("잔여 0건")
    expect(syncJobNoticeMessage("failed", "resume-conflict", 0)).toContain("다른 처리가 먼저 진행")
    expect(syncJobNoticeMessage(undefined, undefined, 0)).toBeUndefined()
  })
})

describe("브라우저 자동 루프 제거", () => {
  it("수동 버튼은 1회 실행만 제출하고 자동 재제출 버튼이 없다", () => {
    const markup = renderToStaticMarkup(<ManualSyncSubmitButton />)
    expect(markup).toContain("한 번 실행 (50건)")
    // 예전 브라우저 루프 버튼("남은 항목 자동 동기화")과 auto=1 값 제출이 사라졌는지 확인한다.
    expect(markup).not.toContain("남은 항목 자동 동기화")
    expect(markup).not.toContain('name="auto"')
  })
})
