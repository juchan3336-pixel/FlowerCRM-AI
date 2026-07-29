import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import AdminSyncPage, { AdminSyncContent } from "@/app/admin/sync/page"
import { loadAdminSync } from "@/lib/admin/sync"
import type { AdminSyncRepository } from "@/lib/admin/sync"
import { loadAdminSyncCoverage } from "@/lib/admin/supabase-sync-coverage"

describe("admin sync", () => {
  it("renders deterministic sync status and count summary when Supabase env is absent", async () => {
    // Given: the fixture-backed admin sync placeholder page.
    const page = await AdminSyncPage()

    // When: the server component is rendered without live Supabase or Google Sheets credentials.
    const markup = renderToStaticMarkup(page)

    // Then: the latest run and its deterministic counters are visible.
    for (const value of ["최신 fixture 동기화", "completed", "삽입", "2", "갱신", "0", "제외", "0", "실패", "1"] as const) {
      expect(markup).toContain(value)
    }
  })

  it("loads Supabase sync runs and errors through the read-only seam", async () => {
    // Given: a credential-free fake repository matching sync_runs and sync_errors rows.
    const repository: AdminSyncRepository = {
      latestRun() {
        return Promise.resolve({
          id: "sync_run_1",
          source: "google_sheets",
          started_at: "2026-07-03T00:00:00.000Z",
          finished_at: "2026-07-03T00:01:00.000Z",
          status: "completed",
          total_rows: 12,
          inserted_count: 5,
          updated_count: 4,
          skipped_count: 2,
          failed_count: 1,
          message: "Loaded from Supabase tables",
        })
      },
      listRecentRuns() {
        return Promise.resolve([
          {
            id: "sync_run_2",
            source: "google_sheets",
            started_at: "2026-07-03T00:02:00.000Z",
            finished_at: null,
            status: "running",
            total_rows: 300,
            inserted_count: 0,
            updated_count: 0,
            skipped_count: 0,
            failed_count: 0,
            message: "Running next batch",
          },
          {
            id: "sync_run_1",
            source: "google_sheets",
            started_at: "2026-07-03T00:00:00.000Z",
            finished_at: "2026-07-03T00:01:00.000Z",
            status: "completed",
            total_rows: 12,
            inserted_count: 5,
            updated_count: 4,
            skipped_count: 2,
            failed_count: 1,
            message: "Loaded from Supabase tables",
          },
        ])
      },
      listErrors(syncRunId) {
        return Promise.resolve([
          {
            id: "sync_error_1",
            sync_run_id: syncRunId,
            source_sheet_name: "기업 DB",
            source_row_number: 9,
            source_payload: { redacted: true },
            error_code: "invalid_shape",
            error_message: "Required company name is missing",
            created_at: "2026-07-03T00:01:00.000Z",
          },
        ])
      },
      coverage() {
        return Promise.resolve({ importedPlaces: 9, latestSourceRowNumber: 12, missingSourceRows: [8, 10], openRunningRuns: 1 })
      },
    }

    // When: sync status is loaded and rendered through the same admin content component.
    const syncStatus = await loadAdminSync(repository)
    const markup = renderToStaticMarkup(createElement(AdminSyncContent, { syncStatus }))

    // Then: table-backed run and error summaries render without exposing source payloads.
    expect(syncStatus.source).toBe("supabase")
    for (const value of ["최신 Supabase 동기화", "Loaded from Supabase tables", "2026-07-03 09:01 KST", "가져오기 범위", "가져온 장소", "9", "누락 행 미리보기: 8, 10", "최근 동기화 실행", "진행 중", "running", "300", "12", "5", "4", "2", "1", "Row 9"] as const) {
      expect(markup).toContain(value)
    }
    expect(markup).not.toContain("redacted")
  })

  it("pages beyond the first capped source-row chunk before previewing missing rows", async () => {
    // Given: an imported Google Sheets range that extends past the first 1000-row page.
    const fetchPageCalls: number[] = []
    const coverage = await loadAdminSyncCoverage({
      countImportedPlaces: () => Promise.resolve(5450),
      countOpenRunningRuns: () => Promise.resolve(0),
      latestSourceRowNumber: () => Promise.resolve(5450),
      fetchMissingSourceRowsPage: (offset, limit) => {
        fetchPageCalls.push(offset)
        return Promise.resolve(numberRange(offset === 0 ? 2 : offset + 2, offset === 0 ? limit + 1 : Math.min(offset + limit + 1, 5450)))
      },
    })

    // When: the coverage helper reads imported count, latest row, and the missing-row preview.
    // Then: the latest row is the real maximum and the preview stays empty instead of inventing gaps from a capped first page.
    expect(coverage.importedPlaces).toBe(5450)
    expect(coverage.latestSourceRowNumber).toBe(5450)
    expect(coverage.missingSourceRows).toEqual([])
    expect(fetchPageCalls).toEqual([0, 1000, 2000, 3000, 4000, 5000])
  })

  it("returns an empty coverage preview when no non-null source rows exist", async () => {
    // Given: a store with no imported Google Sheets rows.
    const coverage = await loadAdminSyncCoverage({
      countImportedPlaces: () => Promise.resolve(0),
      countOpenRunningRuns: () => Promise.resolve(0),
      latestSourceRowNumber: () => Promise.resolve(null),
      fetchMissingSourceRowsPage: () => Promise.resolve([]),
    })

    // When: the coverage helper is asked for status.
    // Then: the latest row is null and no missing preview rows are reported.
    expect(coverage).toEqual({ importedPlaces: 0, latestSourceRowNumber: null, missingSourceRows: [], openRunningRuns: 0 })
  })

  it("labels the latest running sync by start time", async () => {
    // Given: the latest Supabase run is still running.
    const repository: AdminSyncRepository = {
      latestRun() {
        return Promise.resolve({
          id: "sync_run_running",
          source: "google_sheets",
          started_at: "2026-07-06T06:17:31.432423+00:00",
          finished_at: null,
          status: "running",
          total_rows: 0,
          inserted_count: 0,
          updated_count: 0,
          skipped_count: 0,
          failed_count: 0,
          message: null,
        })
      },
      listRecentRuns() {
        return Promise.resolve([])
      },
      listErrors() {
        return Promise.resolve([])
      },
      coverage() {
        return Promise.resolve({ importedPlaces: 0, latestSourceRowNumber: null, missingSourceRows: [], openRunningRuns: 1 })
      },
    }

    // When: the admin sync status is rendered.
    const syncStatus = await loadAdminSync(repository)
    const markup = renderToStaticMarkup(createElement(AdminSyncContent, { syncStatus }))

    // Then: the timestamp is clearly a start time, not a finished time.
    expect(markup).toContain("시작 시각 2026-07-06 15:17 KST · 0행 기준")
    expect(markup).not.toContain("2026-07-06T06:17:31.432423+00:00")
  })

  it("renders sync errors and exposes the manual sync action", async () => {
    // Given: the fixture-backed admin sync placeholder page.
    const page = await AdminSyncPage()

    // When: the server component is rendered to static markup.
    const markup = renderToStaticMarkup(page)

    // Then: row-level errors are listed and the manual sync affordance is available.
    for (const value of ["동기화 오류 목록", "기업 DB", "Row 4", "invalid_shape", "필수 회사명이 없습니다"] as const) {
      expect(markup).toContain(value)
    }
    expect(markup).toContain("한 번 실행")
    expect(markup).toContain("신규 데이터 동기화 시작")
    expect(markup).not.toContain(" disabled=\"")
  })

  // migration 미적용(sync_jobs 테이블 없음) 상태의 Preview 회귀 방어.
  // 이 테스트는 Supabase env가 없어 job 조회가 아예 일어나지 않는 경로 = 테이블 미존재와 같은 결과다.
  it("keeps the whole sync screen working when the sync_jobs table is not there yet", async () => {
    const markup = renderToStaticMarkup(await AdminSyncPage())

    // Then: 신규 카드는 fallback 문구만 띄우고 오류로 무너지지 않는다.
    expect(markup).toContain("신규 데이터 자동 연속 동기화")
    expect(markup).toContain("아직 자동 연속 동기화 기록이 없습니다")
    // 진행 수치·재개·중단 버튼은 job이 없으므로 나오지 않는다.
    expect(markup).not.toContain("이어서 진행")
    expect(markup).not.toContain("중단 요청 중")

    // Then: 기존 화면(최신 실행 상태·가져오기 범위·최근 실행·오류 목록·수동 실행)은 그대로 남는다.
    for (const section of ["최신 실행 상태", "가져오기 범위", "최근 동기화 실행", "동기화 오류 목록", "한 번 실행 (50건)"] as const) {
      expect(markup).toContain(section)
    }

    // Then: 시작 버튼은 활성 상태로 남되, 눌러야만 서버 액션이 돈다 (렌더 시점 DB 쓰기 없음).
    expect(markup).toContain("신규 데이터 동기화 시작")
    expect(markup).not.toContain("sync_jobs")
  })

  it("drives continuous sync from the server, not a browser resubmit loop", async () => {
    // Given: 브라우저 자동 루프(auto=1 재제출)를 쓰던 예전 경로의 쿼리로 진입.
    const page = await AdminSyncPage({ searchParams: Promise.resolve({ auto: "1", failed: "0", rows: "50", sync: "completed" }) })

    // When: the admin page renders.
    const markup = renderToStaticMarkup(page)

    // Then: 브라우저가 다음 배치를 다시 제출하는 컨트롤은 더 이상 없고, 서버 연속 처리 안내로 대체됐다.
    expect(markup).not.toContain("자동 동기화 중...")
    expect(markup).not.toContain("남은 항목 자동 동기화")
    expect(markup).not.toContain("name=\"auto\"")
    expect(markup).toContain("서버가 50건 단위로 스스로 이어서 실행합니다")
    expect(markup).toContain("브라우저를 닫아도 계속 진행됩니다")
    expect(markup).toContain("수동 동기화 완료")
  })

  it("renders a clear retry link when manual sync failed", async () => {
    // Given: a previous manual sync attempt redirected back with a safe failure reason.
    const page = await AdminSyncPage({ searchParams: Promise.resolve({ sync: "failed", reason: "supabase-write" }) })

    // When: the server component is rendered to static markup.
    const markup = renderToStaticMarkup(page)

    // Then: the notice explains the failure class and offers a query-clearing retry path.
    expect(markup).toContain("수동 동기화가 Supabase 쓰기 중 실패했습니다")
    expect(markup).toContain("href=\"/admin/sync\"")
    expect(markup).toContain("상태 지우고 재시도")
    expect(markup).toContain("한 번 실행")
    expect(markup).toContain("신규 데이터 동기화 시작")
    expect(markup).not.toContain(" disabled=\"")
  })

  it("does not expose private tokens in the admin sync placeholder", async () => {
    // Given: sync fixtures may be near credential-backed infrastructure later.
    const page = await AdminSyncPage()

    // When: the placeholder status page is rendered.
    const markup = renderToStaticMarkup(page)

    // Then: service-role names, bearer tokens, and private fixture values are absent from markup.
    for (const privateToken of [
      "SUPABASE_SERVICE_ROLE_KEY",
      "service_role",
      "GOOGLE_SERVICE_ACCOUNT_JSON",
      "Bearer ",
      "private@example.com",
      "imported_payload",
      "refresh_token",
    ] as const) {
      expect(markup).not.toContain(privateToken)
    }
  })
})

function numberRange(start: number, end: number): readonly number[] {
  const numbers: number[] = []
  for (let value = start; value <= end; value += 1) {
    numbers.push(value)
  }
  return numbers
}
