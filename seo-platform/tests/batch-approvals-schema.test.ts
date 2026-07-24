import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const migrationPath = resolve("supabase/migrations/202607240001_batch_approvals.sql")

async function readMigration(): Promise<string> {
  return readFile(migrationPath, "utf8")
}

// 주석은 "저장 금지" 원칙을 문서화하므로, 부정 단언은 실제 DDL 본문에만 적용한다.
async function readMigrationWithoutComments(): Promise<string> {
  const sql = await readMigration()
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
}

describe("batch_approvals migration (설계 파일 — 적용은 사용자 SQL Editor)", () => {
  it("creates the table with RLS enabled and zero anon/authenticated policies", async () => {
    const sql = await readMigration()
    expect(sql).toContain("create table public.batch_approvals")
    expect(sql).toContain("alter table public.batch_approvals enable row level security")
    // service role 전용 — 정책을 만들지 않는다 (기존 batch 테이블과 동일 계약).
    expect(sql).not.toContain("create policy")
    expect(sql).not.toMatch(/grant\s+(select|insert|update|delete)/i)
  })

  it("locks the status machine and numeric invariants with CHECK constraints", async () => {
    const sql = await readMigration()
    expect(sql).toContain("status in ('approved', 'queued', 'running', 'completed', 'failed', 'expired', 'cancelled')")
    // 빈 배열 거부: array_length('{}')는 NULL이라 coalesce 없이는 CHECK가 통과된다 (2026-07-24 검수 반영).
    expect(sql).toContain("check (coalesce(array_length(approved_place_ids, 1), 0) between 1 and 5)")
    expect(sql).toContain("check (approved_max_cost_usd > 0)")
    expect(sql).toContain("check (approval_expires_at > approved_at)")
    expect(sql).toContain("check (execution_tick >= 0)")
  })

  it("keeps no nullable-bypass variant of the place-count check", async () => {
    const ddl = await readMigrationWithoutComments()
    // coalesce 없는 구형 CHECK(빈 배열 우회형)가 DDL 본문에 남아 있지 않다.
    expect(ddl).not.toMatch(/check \(array_length\(approved_place_ids, 1\) between/)
  })

  it("stores only the activation token hash and records its consumption", async () => {
    const sql = await readMigration()
    const ddl = await readMigrationWithoutComments()
    expect(sql).toContain("execution_token_hash text not null unique")
    expect(sql).toContain("activation_consumed_at timestamptz")
    // 토큰 원문·secret 계열 컬럼이 DDL 본문에 존재하지 않는다 (주석은 저장 금지 원칙 문서화용).
    expect(ddl).not.toMatch(/execution_token\s+text/)
    expect(ddl).not.toMatch(/chain_secret/i)
    expect(ddl).not.toMatch(/bypass/i)
  })

  it("allows only one active approval at a time via a partial unique index", async () => {
    const sql = await readMigration()
    expect(sql).toContain("create unique index batch_approvals_single_active_idx")
    expect(sql).toMatch(/where status in \('approved', 'queued', 'running'\)/)
  })

  it("links batch_runs without destructive cascade and keeps updated_at fresh", async () => {
    const sql = await readMigration()
    expect(sql).toContain("references public.batch_runs(id) on delete set null")
    expect(sql).toContain("create trigger batch_approvals_set_updated_at")
    expect(sql).toContain("execute function public.set_updated_at()")
  })

  it("freezes the approval snapshot and audit fields", async () => {
    const sql = await readMigration()
    expect(sql).toContain("approved_place_ids uuid[] not null")
    expect(sql).toContain("approval_snapshot jsonb not null")
    expect(sql).toContain("approved_by text not null")
    expect(sql).toContain("approval_expires_at timestamptz not null")
    expect(sql).toContain("execution_tick integer not null default 0")
    expect(sql).toContain("preview_deployment_sha text")
  })

  it("does not touch existing batch tables", async () => {
    const sql = await readMigration()
    expect(sql).not.toMatch(/alter table public\.batch_runs\b/)
    expect(sql).not.toMatch(/alter table public\.batch_run_items\b/)
    expect(sql).not.toMatch(/alter table public\.batch_run_events\b/)
    expect(sql).not.toMatch(/drop\s/i)
  })
})
