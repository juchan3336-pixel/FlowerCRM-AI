// pump lease migration이 실제로 존재하는 컬럼만 참조하는지 SQL 본문으로 검증한다.
//
// 2026-07-31: 이 migration이 batch_approvals에 없는 activated_at으로 인덱스·정렬을 걸어
// Production 적용이 42703(column does not exist)으로 통째 롤백됐다. 타입 정의에 optional로 얹혀 있어
// typecheck도 통과했고, 실제 SQL을 실행하는 테스트가 없어 merge까지 통과했다.
// 그래서 "migration이 쓰는 컬럼이 원본 스키마에 실제로 있는지"를 여기서 고정한다.
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const leaseMigrationPath = resolve("supabase/migrations/202607310001_batch_approval_pump_lease.sql")
const approvalsMigrationPath = resolve("supabase/migrations/202607240001_batch_approvals.sql")
const verifyPath = resolve("supabase/operations/verify_batch_pump_lease_migration.sql")

async function readSql(path: string): Promise<string> {
  return readFile(path, "utf8")
}

// 주석은 사고 경위를 설명하느라 컬럼 이름을 언급할 수 있으므로, 부정 단언은 DDL 본문에만 적용한다.
function withoutComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
}

// 원본 migration의 create table 블록에서 최상위 컬럼 이름만 뽑는다.
async function approvalColumnNames(): Promise<readonly string[]> {
  const sql = withoutComments(await readSql(approvalsMigrationPath))
  const start = sql.indexOf("create table public.batch_approvals")
  const body = sql.slice(start, sql.indexOf("\n);", start))
  return body
    .split("\n")
    .map((line) => /^\s{2}([a-z_]+)\s/u.exec(line)?.[1])
    .filter((name): name is string => name !== undefined && name !== "constraint" && name !== "check")
}

describe("batch_approvals pump lease migration", () => {
  it("승인 테이블에는 activated_at 컬럼이 없다", async () => {
    const columns = await approvalColumnNames()
    expect(columns).toContain("activation_consumed_at")
    expect(columns).toContain("approved_at")
    expect(columns).not.toContain("activated_at")
  })

  it("migration 본문이 activated_at을 참조하지 않는다", async () => {
    const sql = withoutComments(await readSql(leaseMigrationPath))
    expect(sql).not.toContain("activated_at")
  })

  it("migration이 참조하는 컬럼이 전부 실제 스키마에 존재한다", async () => {
    const sql = withoutComments(await readSql(leaseMigrationPath))
    const columns = await approvalColumnNames()
    const added = ["lease_token_hash", "lease_expires_at", "pump_attempt"]

    // 인덱스 정의와 RPC의 where/order 절에서 쓰는 컬럼들.
    const referenced = ["status", "batch_run_id", "activation_consumed_at", "approved_at", "id", ...added]
    for (const column of referenced) {
      expect(sql).toContain(column)
      // 이번 migration이 새로 추가하는 3개를 빼면 원본 스키마에 있어야 한다.
      if (!added.includes(column)) {
        expect(columns).toContain(column)
      }
    }
  })

  it("lease 컬럼 3개를 재실행 가능하게 추가한다", async () => {
    const sql = await readSql(leaseMigrationPath)
    expect(sql).toContain("add column if not exists lease_token_hash text")
    expect(sql).toContain("add column if not exists lease_expires_at timestamptz")
    expect(sql).toContain("add column if not exists pump_attempt integer not null default 0")
    expect(sql).toContain("create index if not exists batch_approvals_pump_claim_idx")
    expect(sql).toContain("create or replace function public.claim_batch_pump_lease")
  })

  it("인덱스와 정렬이 activate 시각(activation_consumed_at) 기준이다", async () => {
    const sql = withoutComments(await readSql(leaseMigrationPath))
    expect(sql).toContain("on public.batch_approvals (activation_consumed_at, approved_at, id)")
    expect(sql).toContain("order by activation_consumed_at asc nulls last, approved_at asc, id asc")
  })

  it("승인 게이트를 RPC 조건으로 강제한다 (running + batch_run 연결만)", async () => {
    const sql = withoutComments(await readSql(leaseMigrationPath))
    expect(sql).toContain("where status = 'running'")
    expect(sql).toContain("batch_run_id is not null")
    expect(sql).toContain("for update skip locked")
    // approved·queued를 집어가는 조건이 없어야 한다.
    expect(sql).not.toMatch(/status\s+in\s*\(\s*'approved'/u)
  })

  it("RPC 실행 권한은 service_role 전용이다", async () => {
    const sql = withoutComments(await readSql(leaseMigrationPath))
    expect(sql).toContain("revoke all on function public.claim_batch_pump_lease(timestamptz, text, integer) from anon")
    expect(sql).toContain("revoke all on function public.claim_batch_pump_lease(timestamptz, text, integer) from authenticated")
    expect(sql).toContain("grant execute on function public.claim_batch_pump_lease(timestamptz, text, integer) to service_role")
  })

  it("롤백 절차를 주석으로 남긴다", async () => {
    const sql = await readSql(leaseMigrationPath)
    expect(sql).toContain("drop function if exists public.claim_batch_pump_lease")
    expect(sql).toContain("drop index if exists public.batch_approvals_pump_claim_idx")
    expect(sql).toContain("drop column if exists pump_attempt")
  })
})

describe("pump lease 검증 SQL", () => {
  it("activated_at 부재를 직접 확인한다", async () => {
    const sql = await readSql(verifyPath)
    expect(sql).toContain("B9 RPC에 activated_at 참조 없음")
    expect(sql).toContain("B10 인덱스에 activated_at 참조 없음")
    expect(sql).toContain("B11 batch_approvals에 activated_at 컬럼 없음")
    expect(sql).toContain("B8 RPC 정렬이 activation_consumed_at 기준")
  })

  it("읽기 전용이고 한 문장이다", async () => {
    const sql = await readSql(verifyPath)
    // 라벨 문자열에도 update 같은 단어가 들어가므로("for update skip locked" 검사 항목),
    // 단순 단어 검색이 아니라 "문장을 시작하는 키워드"만 본다.
    const statements = withoutComments(sql)
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)

    expect(statements).toHaveLength(1)
    for (const statement of statements) {
      expect(statement.toLowerCase()).toMatch(/^(with|select)\b/u)
    }
  })
})
