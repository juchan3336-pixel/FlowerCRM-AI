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
    }

    // When: sync status is loaded and rendered through the same admin content component.
    const syncStatus = await loadAdminSync(repository)
    const markup = renderToStaticMarkup(createElement(AdminSyncContent, { syncStatus }))

    // Then: table-backed run and error summaries render without exposing source payloads.
    expect(syncStatus.source).toBe("supabase")
    for (const value of ["Latest Supabase sync", "Loaded from Supabase tables", "12", "5", "4", "2", "1", "Row 9"] as const) {
      expect(markup).toContain(value)
    }
    expect(markup).not.toContain("redacted")
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
    expect(markup).toContain("Run Google Sheets sync")
    expect(markup).not.toContain("disabled")
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
