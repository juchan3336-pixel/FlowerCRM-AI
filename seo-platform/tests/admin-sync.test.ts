import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import AdminSyncPage, { AdminSyncContent } from "@/app/admin/sync/page"
import { loadAdminSync } from "@/lib/admin/sync"
import type { AdminSyncRepository } from "@/lib/admin/sync"

describe("admin sync", () => {
  it("renders deterministic sync status and count summary when Supabase env is absent", async () => {
    // Given: the fixture-backed admin sync placeholder page.
    const page = await AdminSyncPage()

    // When: the server component is rendered without live Supabase or Google Sheets credentials.
    const markup = renderToStaticMarkup(page)

    // Then: the latest run and its deterministic counters are visible.
    for (const value of ["Latest fixture sync", "completed", "Inserted", "2", "Updated", "0", "Skipped", "0", "Failed", "1"] as const) {
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
    for (const value of ["Latest Supabase sync", "Loaded from Supabase tables", "2026-07-03 09:01 KST", "Import coverage", "Imported places", "9", "Missing rows preview: 8, 10", "Recent sync runs", "Still running", "running", "300", "12", "5", "4", "2", "1", "Row 9"] as const) {
      expect(markup).toContain(value)
    }
    expect(markup).not.toContain("redacted")
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
    expect(markup).toContain("Started at 2026-07-06 15:17 KST from 0 rows")
    expect(markup).not.toContain("2026-07-06T06:17:31.432423+00:00")
  })

  it("renders sync errors and exposes the manual sync action", async () => {
    // Given: the fixture-backed admin sync placeholder page.
    const page = await AdminSyncPage()

    // When: the server component is rendered to static markup.
    const markup = renderToStaticMarkup(page)

    // Then: row-level errors are listed and the manual sync affordance is available.
    for (const value of ["Sync error list", "기업 DB", "Row 4", "invalid_shape", "Required company name is missing"] as const) {
      expect(markup).toContain(value)
    }
    expect(markup).toContain("Run once")
    expect(markup).toContain("Auto sync remaining")
    expect(markup).not.toContain(" disabled=\"")
  })

  it("keeps auto sync active after a successful non-empty batch", async () => {
    // Given: an auto sync redirect reports a successful batch with rows.
    const page = await AdminSyncPage({ searchParams: Promise.resolve({ auto: "1", failed: "0", rows: "50", sync: "completed" }) })

    // When: the admin page renders the auto controls.
    const markup = renderToStaticMarkup(page)

    // Then: the auto control remains visible for the browser to submit the next batch.
    expect(markup).toContain("Auto syncing...")
    expect(markup).toContain("Manual sync completed")
  })

  it("renders a clear retry link when manual sync failed", async () => {
    // Given: a previous manual sync attempt redirected back with a safe failure reason.
    const page = await AdminSyncPage({ searchParams: Promise.resolve({ sync: "failed", reason: "supabase-write" }) })

    // When: the server component is rendered to static markup.
    const markup = renderToStaticMarkup(page)

    // Then: the notice explains the failure class and offers a query-clearing retry path.
    expect(markup).toContain("Manual sync failed while writing to Supabase")
    expect(markup).toContain("href=\"/admin/sync\"")
    expect(markup).toContain("Clear status and retry")
    expect(markup).toContain("Run once")
    expect(markup).toContain("Auto sync remaining")
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
