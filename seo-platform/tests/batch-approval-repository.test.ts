import { beforeEach, describe, expect, it, vi } from "vitest"

import { hashActivationToken, mintActivationToken, type ApprovalPlaceSnapshot } from "@/lib/batch/approval-policy"

// 저장소는 server-only + supabase 의존 — 상태를 가진 fake 테이블로 조건부 UPDATE 계약을 검증한다.
// fake는 실제 PostgREST filter semantics(eq/in/is/gt)와 unique 제약(토큰 해시·활성 1건)을 재현한다.
vi.mock("server-only", () => ({}))

type FakeRow = {
  id: string
  status: string
  approved_by: string
  approved_at: string
  approval_expires_at: string
  approved_place_ids: string[]
  approved_max_cost_usd: number
  approval_snapshot: unknown
  execution_token_hash: string
  activation_consumed_at: string | null
  execution_tick: number
  batch_run_id: string | null
  last_tick_at: string | null
  last_error_code: string | null
  last_error_message: string | null
  preview_deployment_sha: string | null
  created_at: string
  updated_at: string
}

const ACTIVE_STATUSES = ["approved", "queued", "running"]
const rows: FakeRow[] = []
let idSequence = 0

type Filter =
  | { readonly kind: "eq"; readonly column: string; readonly value: unknown }
  | { readonly kind: "in"; readonly column: string; readonly values: readonly unknown[] }
  | { readonly kind: "is"; readonly column: string; readonly value: null }
  | { readonly kind: "gt"; readonly column: string; readonly value: string }

function matches(row: FakeRow, filters: readonly Filter[]): boolean {
  return filters.every((filter) => {
    const current = (row as Record<string, unknown>)[filter.column]
    switch (filter.kind) {
      case "eq":
        return current === filter.value
      case "in":
        return filter.values.includes(current)
      case "is":
        return current === null
      case "gt":
        return typeof current === "string" && Date.parse(current) > Date.parse(filter.value)
    }
  })
}

function makeUpdateBuilder(values: Record<string, unknown>) {
  const filters: Filter[] = []
  const builder = {
    eq(column: string, value: unknown) {
      filters.push({ kind: "eq", column, value })
      return builder
    },
    in(column: string, list: readonly unknown[]) {
      filters.push({ kind: "in", column, values: list })
      return builder
    },
    is(column: string, value: null) {
      filters.push({ kind: "is", column, value })
      return builder
    },
    gt(column: string, value: string) {
      filters.push({ kind: "gt", column, value })
      return builder
    },
    select() {
      const updated: FakeRow[] = []
      for (const row of rows) {
        if (matches(row, filters)) {
          Object.assign(row, values)
          updated.push({ ...row })
        }
      }
      return Promise.resolve({ data: updated, error: null })
    },
  }
  return builder
}

function makeSelectBuilder() {
  const filters: Filter[] = []
  const builder = {
    eq(column: string, value: unknown) {
      filters.push({ kind: "eq", column, value })
      return builder
    },
    maybeSingle() {
      const found = rows.find((row) => matches(row, filters))
      return Promise.resolve({ data: found === undefined ? null : { ...found }, error: null })
    },
  }
  return builder
}

const fakeClient = {
  from(table: string) {
    if (table !== "batch_approvals") {
      throw new Error(`unexpected table: ${table}`)
    }
    return {
      insert(values: Record<string, unknown>) {
        return {
          select() {
            return {
              single() {
                // unique 제약 재현: 토큰 해시 전역 유일 + 활성 승인(approved/queued/running) 전역 1건
                const duplicateToken = rows.some((row) => row.execution_token_hash === values["execution_token_hash"])
                const activeExists = rows.some((row) => ACTIVE_STATUSES.includes(row.status))
                if (duplicateToken || activeExists) {
                  return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } })
                }
                idSequence += 1
                const now = new Date().toISOString()
                const row: FakeRow = {
                  id: `approval-${String(idSequence)}`,
                  status: "approved",
                  approved_by: String(values["approved_by"]),
                  approved_at: now,
                  approval_expires_at: String(values["approval_expires_at"]),
                  approved_place_ids: values["approved_place_ids"] as string[],
                  approved_max_cost_usd: Number(values["approved_max_cost_usd"]),
                  approval_snapshot: values["approval_snapshot"],
                  execution_token_hash: String(values["execution_token_hash"]),
                  activation_consumed_at: null,
                  execution_tick: 0,
                  batch_run_id: null,
                  last_tick_at: null,
                  last_error_code: null,
                  last_error_message: null,
                  preview_deployment_sha: null,
                  created_at: now,
                  updated_at: now,
                }
                rows.push(row)
                return Promise.resolve({ data: { ...row }, error: null })
              },
            }
          },
        }
      },
      update(values: Record<string, unknown>) {
        return makeUpdateBuilder(values)
      },
      select() {
        return makeSelectBuilder()
      },
    }
  },
}

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceRoleClient: () => fakeClient }))

const FUTURE = new Date(Date.now() + 30 * 60 * 1000).toISOString()
const PAST = new Date(Date.now() - 60 * 1000).toISOString()
const NOW = new Date().toISOString()

const SNAPSHOT: readonly ApprovalPlaceSnapshot[] = [
  {
    place_id: "11111111-1111-1111-1111-111111111111",
    name: "예시병원 장례식장",
    address: "경남 예시시 예시로 1",
    phone: "055-000-0000",
    slug: "funeral-yesi",
    official_verification_status: "verified",
    verification_source_urls: ["http://example.com"],
    had_generation: false,
    had_seo_page: false,
    estimated_tokens: 1250,
    estimated_cost_usd: 0.001,
    snapshot_hash: "a".repeat(64),
  },
]

async function createRepository() {
  const { createSupabaseApprovalRepository } = await import("@/lib/batch/supabase-approval-repository")
  return createSupabaseApprovalRepository()
}

async function createApprovedRow(tokenHash: string, expiresAt = FUTURE) {
  const repository = await createRepository()
  const result = await repository.createApproval({
    approvedBy: "admin@midmgroup.com",
    approvalExpiresAt: expiresAt,
    approvedPlaceIds: [SNAPSHOT[0]?.place_id ?? ""],
    approvedMaxCostUsd: 0.05,
    approvalSnapshot: SNAPSHOT,
    executionTokenHash: tokenHash,
  })
  if (result.kind !== "created") {
    throw new Error("expected created")
  }
  return { repository, approval: result.approval }
}

describe("승인 저장소 — 조건부 전이 계약", () => {
  beforeEach(() => {
    rows.length = 0
  })

  it("stores only the token hash, never the plaintext token", async () => {
    const minted = mintActivationToken()
    const { approval } = await createApprovedRow(minted.tokenHash)
    expect(approval.execution_token_hash).toBe(minted.tokenHash)
    expect(approval.status).toBe("approved")
    expect(approval.execution_tick).toBe(0)
    expect(approval.activation_consumed_at).toBeNull()
    // 저장된 행 어디에도 토큰 원문이 없다.
    expect(JSON.stringify(rows)).not.toContain(minted.token)
  })

  it("rejects a second active approval (전역 1건) but allows one after the first terminates", async () => {
    const first = mintActivationToken()
    const { repository } = await createApprovedRow(first.tokenHash)

    const second = await repository.createApproval({
      approvedBy: "admin@midmgroup.com",
      approvalExpiresAt: FUTURE,
      approvedPlaceIds: ["22222222-2222-2222-2222-222222222222"],
      approvedMaxCostUsd: 0.05,
      approvalSnapshot: SNAPSHOT,
      executionTokenHash: mintActivationToken().tokenHash,
    })
    expect(second).toEqual({ kind: "already-active" })

    // 첫 승인이 종료 상태가 되면 새 승인 가능
    const firstRow = rows[0]
    if (firstRow !== undefined) {
      firstRow.status = "completed"
    }
    const third = await repository.createApproval({
      approvedBy: "admin@midmgroup.com",
      approvalExpiresAt: FUTURE,
      approvedPlaceIds: ["33333333-3333-3333-3333-333333333333"],
      approvedMaxCostUsd: 0.05,
      approvalSnapshot: SNAPSHOT,
      executionTokenHash: mintActivationToken().tokenHash,
    })
    expect(third.kind).toBe("created")
  })

  it("activates once, consumes the token, and rejects reuse (재사용 차단)", async () => {
    const minted = mintActivationToken()
    const { repository } = await createApprovedRow(minted.tokenHash)

    const activated = await repository.activateApproval({ executionTokenHash: minted.tokenHash, nowIso: NOW })
    expect(activated?.status).toBe("running")
    expect(activated?.activation_consumed_at).toBe(NOW)

    // 동일 토큰 재활성화 → 0행 no-op
    const reused = await repository.activateApproval({ executionTokenHash: minted.tokenHash, nowIso: NOW })
    expect(reused).toBeNull()
  })

  it("rejects activation for an expired approval and for an unknown token", async () => {
    const minted = mintActivationToken()
    const { repository } = await createApprovedRow(minted.tokenHash, PAST)
    expect(await repository.activateApproval({ executionTokenHash: minted.tokenHash, nowIso: NOW })).toBeNull()
    expect(await repository.activateApproval({ executionTokenHash: hashActivationToken("unknown"), nowIso: NOW })).toBeNull()
  })

  it("rejects re-activation once a batch_run is linked even if consumption were cleared", async () => {
    const minted = mintActivationToken()
    const { repository } = await createApprovedRow(minted.tokenHash)
    await repository.activateApproval({ executionTokenHash: minted.tokenHash, nowIso: NOW })
    const linked = await repository.linkBatchRun(rows[0]?.id ?? "", "batch-run-1")
    expect(linked?.batch_run_id).toBe("batch-run-1")

    // 방어 시나리오: 소진 기록이 지워졌다고 가정해도 batch_run_id 연결이 재활성화를 막는다.
    const row = rows[0]
    if (row !== undefined) {
      row.status = "approved"
      row.activation_consumed_at = null
    }
    expect(await repository.activateApproval({ executionTokenHash: minted.tokenHash, nowIso: NOW })).toBeNull()
  })

  it("links the batch run exactly once (running + unlinked 조건부)", async () => {
    const minted = mintActivationToken()
    const { repository } = await createApprovedRow(minted.tokenHash)
    const approvalId = rows[0]?.id ?? ""

    // running 이전에는 연결 불가
    expect(await repository.linkBatchRun(approvalId, "batch-run-early")).toBeNull()

    await repository.activateApproval({ executionTokenHash: minted.tokenHash, nowIso: NOW })
    expect((await repository.linkBatchRun(approvalId, "batch-run-1"))?.batch_run_id).toBe("batch-run-1")
    // 두 번째 연결은 no-op
    expect(await repository.linkBatchRun(approvalId, "batch-run-2")).toBeNull()
    expect(rows[0]?.batch_run_id).toBe("batch-run-1")
  })

  it("advances the execution tick only on an exact CAS match (중복 tick no-op)", async () => {
    const minted = mintActivationToken()
    const { repository } = await createApprovedRow(minted.tokenHash)
    const approvalId = rows[0]?.id ?? ""

    // running 이전 tick 전진 불가
    expect(await repository.advanceExecutionTick({ approvalId, expectedTick: 0, nowIso: NOW })).toBe(false)

    await repository.activateApproval({ executionTokenHash: minted.tokenHash, nowIso: NOW })
    expect(await repository.advanceExecutionTick({ approvalId, expectedTick: 0, nowIso: NOW, previewDeploymentSha: "sha-1" })).toBe(true)
    expect(rows[0]?.execution_tick).toBe(1)
    expect(rows[0]?.last_tick_at).toBe(NOW)
    expect(rows[0]?.preview_deployment_sha).toBe("sha-1")

    // 같은 기대값의 중복/지연 tick은 CAS 실패로 no-op
    expect(await repository.advanceExecutionTick({ approvalId, expectedTick: 0, nowIso: NOW })).toBe(false)
    expect(rows[0]?.execution_tick).toBe(1)
    // 다음 기대값은 전진
    expect(await repository.advanceExecutionTick({ approvalId, expectedTick: 1, nowIso: NOW })).toBe(true)
    expect(rows[0]?.execution_tick).toBe(2)
  })

  it("expires and cancels only from the allowed states", async () => {
    const minted = mintActivationToken()
    const { repository } = await createApprovedRow(minted.tokenHash)
    const approvalId = rows[0]?.id ?? ""

    // approved → expired 허용
    expect((await repository.expireApproval(approvalId))?.status).toBe("expired")
    // 종료 상태에서 취소 불가
    expect(await repository.cancelApproval(approvalId)).toBeNull()

    // 새 승인으로 running 취소 경로 확인
    const row = rows[0]
    if (row !== undefined) {
      row.status = "cancelled"
    }
    const next = mintActivationToken()
    await createApprovedRow(next.tokenHash)
    await repository.activateApproval({ executionTokenHash: next.tokenHash, nowIso: NOW })
    const runningId = rows[1]?.id ?? ""
    // running은 만료 대상이 아니다
    expect(await repository.expireApproval(runningId)).toBeNull()
    expect((await repository.cancelApproval(runningId))?.status).toBe("cancelled")
  })

  it("completes or fails only from running/queued and truncates error messages", async () => {
    const minted = mintActivationToken()
    const { repository } = await createApprovedRow(minted.tokenHash)
    const approvalId = rows[0]?.id ?? ""

    // approved에서 complete 불가
    expect(await repository.completeApproval(approvalId)).toBeNull()

    await repository.activateApproval({ executionTokenHash: minted.tokenHash, nowIso: NOW })
    expect((await repository.completeApproval(approvalId))?.status).toBe("completed")
    // 재완료 no-op
    expect(await repository.completeApproval(approvalId)).toBeNull()

    // 새 승인으로 failed 경로 + 메시지 절단 확인
    const second = mintActivationToken()
    await createApprovedRow(second.tokenHash)
    await repository.activateApproval({ executionTokenHash: second.tokenHash, nowIso: NOW })
    const failed = await repository.failApproval(rows[1]?.id ?? "", { code: "kick-failed", message: "x".repeat(500) })
    expect(failed?.status).toBe("failed")
    expect(failed?.last_error_code).toBe("kick-failed")
    expect(failed?.last_error_message).toHaveLength(300)
  })

  it("looks up approvals by id and token hash", async () => {
    const minted = mintActivationToken()
    const { repository, approval } = await createApprovedRow(minted.tokenHash)
    expect((await repository.findApprovalById(approval.id))?.id).toBe(approval.id)
    expect((await repository.findApprovalByTokenHash(minted.tokenHash))?.id).toBe(approval.id)
    expect(await repository.findApprovalById("missing")).toBeNull()
    expect(await repository.findApprovalByTokenHash(hashActivationToken("missing"))).toBeNull()
  })

  it("marks queued only from approved (kick 발사 표시)", async () => {
    const minted = mintActivationToken()
    const { repository } = await createApprovedRow(minted.tokenHash)
    const approvalId = rows[0]?.id ?? ""
    expect((await repository.markQueued(approvalId))?.status).toBe("queued")
    // queued에서 재호출 no-op
    expect(await repository.markQueued(approvalId)).toBeNull()
    // queued에서도 활성화는 가능
    expect((await repository.activateApproval({ executionTokenHash: minted.tokenHash, nowIso: NOW }))?.status).toBe("running")
  })
})
