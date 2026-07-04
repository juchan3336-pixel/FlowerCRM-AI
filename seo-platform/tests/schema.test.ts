import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const migrationPath = resolve("supabase/migrations/202607030001_initial_foundation.sql")

async function readMigration(): Promise<string> {
  return readFile(migrationPath, "utf8")
}

describe("Supabase foundation migration", () => {
  it("creates required tables with RLS enabled", async () => {
    const sql = await readMigration()
    const tables = ["places", "seo_pages", "ai_generations", "sync_runs", "sync_errors", "settings"]

    for (const table of tables) {
      expect(sql).toContain(`create table public.${table}`)
      expect(sql).toContain(`alter table public.${table} enable row level security`)
    }
  })

  it("protects public reads with a published-safe view", async () => {
    const sql = await readMigration()

    expect(sql).toContain("create view public.published_place_pages")
    expect(sql).toContain("with (security_barrier = true)")
    expect(sql).toContain("where sp.status = 'published'")
    expect(sql).not.toContain("security_invoker = true")
    expect(sql).not.toMatch(/published_place_pages[\s\S]*(p\.phone|email|memo|imported_payload|synced_at)/)
  })

  it("keeps anon raw table reads closed while granting the safe view", async () => {
    const sql = await readMigration()

    expect(sql).toContain("revoke all on public.places from anon")
    expect(sql).toContain("revoke all on public.seo_pages from anon")
    expect(sql).not.toContain("on public.seo_pages for select to anon")
    expect(sql).toContain("grant select on public.published_place_pages to anon, authenticated")
  })

  it("keeps statuses, indexes, uniqueness, and updated_at triggers in the schema", async () => {
    const sql = await readMigration()

    expect(sql).toContain("source_key text not null unique")
    expect(sql).toContain("status in ('draft', 'published', 'noindex', 'archived')")
    expect(sql).toContain("create trigger places_set_updated_at")
    expect(sql).toContain("create index seo_pages_status_type_idx")
    expect(sql).toContain("jsonb_typeof(faq) = 'array'")
  })
})
