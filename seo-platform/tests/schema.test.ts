import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { PLACE_STATUSES, SEO_PAGE_STATUSES, SEO_PAGE_TYPES } from "@/lib/domain/constants"

const foundationMigrationPath = resolve("supabase/migrations/202607030001_initial_foundation.sql")
const placeLifecycleMigrationPath = resolve("supabase/migrations/202607070001_place_seo_page_lifecycle.sql")

async function readFoundationMigration(): Promise<string> {
  return readFile(foundationMigrationPath, "utf8")
}

async function readPlaceLifecycleMigration(): Promise<string> {
  return readFile(placeLifecycleMigrationPath, "utf8")
}

describe("Supabase foundation migration", () => {
  it("creates required tables with RLS enabled", async () => {
    const sql = await readFoundationMigration()
    const tables = ["places", "seo_pages", "ai_generations", "sync_runs", "sync_errors", "settings"]

    for (const table of tables) {
      expect(sql).toContain(`create table public.${table}`)
      expect(sql).toContain(`alter table public.${table} enable row level security`)
    }
  })

  it("protects public reads with a published-safe view", async () => {
    const sql = await readFoundationMigration()

    expect(sql).toContain("create view public.published_place_pages")
    expect(sql).toContain("with (security_barrier = true)")
    expect(sql).toContain("where sp.status = 'published'")
    expect(sql).not.toContain("security_invoker = true")
    expect(sql).not.toMatch(/published_place_pages[\s\S]*(p\.phone|email|memo|imported_payload|synced_at)/)
  })

  it("keeps anon raw table reads closed while granting the safe view", async () => {
    const sql = await readFoundationMigration()

    expect(sql).toContain("revoke all on public.places from anon")
    expect(sql).toContain("revoke all on public.seo_pages from anon")
    expect(sql).not.toContain("on public.seo_pages for select to anon")
    expect(sql).toContain("grant select on public.published_place_pages to anon, authenticated")
  })

  it("keeps statuses, indexes, uniqueness, and updated_at triggers in the schema", async () => {
    const sql = await readFoundationMigration()

    expect(sql).toContain("source_key text not null unique")
    expect(sql).toContain("status in ('draft', 'published', 'noindex', 'archived')")
    expect(sql).toContain("create trigger places_set_updated_at")
    expect(sql).toContain("create index seo_pages_status_type_idx")
    expect(sql).toContain("jsonb_typeof(faq) = 'array'")
  })

  it("adds place SEO pages with the ready lifecycle in a follow-up migration", async () => {
    const sql = await readPlaceLifecycleMigration()

    expect(SEO_PAGE_TYPES).toContain("place")
    expect(SEO_PAGE_STATUSES).toEqual(["draft", "ready", "published", "archived"])
    expect(PLACE_STATUSES).toEqual(["draft", "published", "noindex", "archived"])
    expect(sql).toContain("page_type in ('area', 'funeral', 'hospital', 'product', 'place')")
    expect(sql).toContain("status in ('draft', 'ready', 'published', 'archived')")
    expect(sql).toContain("update public.seo_pages")
    expect(sql).toContain("set status = 'archived'")
    expect(sql).toContain("where status = 'noindex'")
    expect(sql).toContain("create unique index seo_pages_one_place_page_per_place_idx")
    expect(sql).toContain("where page_type = 'place' and place_id is not null")
  })

  it("keeps noindex out of SEO-page lifecycle while preserving published-only public pages", async () => {
    const sql = await readPlaceLifecycleMigration()

    expect(SEO_PAGE_STATUSES).not.toContain("noindex")
    expect(sql).not.toContain("status in ('draft', 'published', 'noindex', 'archived')")
    expect(sql).toContain("where sp.status = 'published'")
    expect(sql).not.toContain("on public.seo_pages for select to anon")
    expect(sql).not.toContain("grant select on public.seo_pages to anon")
  })
})
