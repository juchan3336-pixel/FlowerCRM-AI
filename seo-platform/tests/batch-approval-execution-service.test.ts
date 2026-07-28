import { beforeEach, describe, expect, it, vi } from "vitest"

import { buildApprovalPlaceSnapshot, mintActivationToken, type ApprovalCandidateInput } from "@/lib/batch/approval-policy"

// 오케스트레이션을 실제 코드로 검증한다 — 승인·배치 저장소와 생성 서비스는 상태를 가진 대역으로 바꾼다.
// 대역은 PR-A에서 검증한 조건부 전이·CAS 계약을 그대로 재현한다 (활성화 원자 소진, tick CAS).
vi.mock("server-only", () => ({}))

// ── 승인 저장소 대역 (상태 기반) ──────────────────────────────────
type Approval = {
  id: string
  status: string
  approved_by: string
  approval_expires_at: string
  approved_place_ids: string[]
  approved_max_cost_usd: number
  approval_snapshot: unknown
  execution_token_hash: string
  activation_consumed_at: string | null
  execution_tick: number
  batch_run_id: string | null
  last_error_code: string | null
  last_error_message: string | null
}
const approvals: Approval[] = []

const approvalRepo = {
  findApprovalByTokenHash: (h: string) => Promise.resolve(approvals.find((a) => a.execution_token_hash === h) ?? null),
  findApprovalById: (id: string) => Promise.resolve(approvals.find((a) => a.id === id) ?? null),
  markQueued: (id: string) => {
    const a = approvals.find((x) => x.id === id)
    if (a?.status === "approved") a.status = "queued"
    return Promise.resolve(a ?? null)
  },
  activateApproval: ({ executionTokenHash, nowIso }: { executionTokenHash: string; nowIso: string }) => {
    const a = approvals.find((x) => x.execution_token_hash === executionTokenHash)
    if (a && (a.status === "approved" || a.status === "queued") && a.activation_consumed_at === null && a.batch_run_id === null && Date.parse(a.approval_expires_at) > Date.parse(nowIso)) {
      a.status = "running"
      a.activation_consumed_at = nowIso
      return Promise.resolve(a)
    }
    return Promise.resolve(null)
  },
  linkBatchRun: (id: string, batchRunId: string) => {
    const a = approvals.find((x) => x.id === id)
    if (a?.status === "running" && a.batch_run_id === null) {
      a.batch_run_id = batchRunId
      return Promise.resolve(a)
    }
    return Promise.resolve(null)
  },
  advanceExecutionTick: ({ approvalId, expectedTick }: { approvalId: string; expectedTick: number }) => {
    const a = approvals.find((x) => x.id === approvalId)
    if (a?.status === "running" && a.execution_tick === expectedTick) {
      a.execution_tick = expectedTick + 1
      return Promise.resolve(true)
    }
    return Promise.resolve(false)
  },
  expireApproval: (id: string) => {
    const a = approvals.find((x) => x.id === id)
    if (a && (a.status === "approved" || a.status === "queued")) a.status = "expired"
    return Promise.resolve(a ?? null)
  },
  completeApproval: (id: string) => {
    const a = approvals.find((x) => x.id === id)
    if (a?.status === "running") a.status = "completed"
    return Promise.resolve(a ?? null)
  },
  failApproval: (id: string, f: { code: string; message: string }) => {
    const a = approvals.find((x) => x.id === id)
    if (a && (a.status === "queued" || a.status === "running")) {
      a.status = "failed"
      a.last_error_code = f.code
      a.last_error_message = f.message.slice(0, 300)
    }
    return Promise.resolve(a ?? null)
  },
  cancelApproval: (id: string) => {
    const a = approvals.find((x) => x.id === id)
    if (a && ["approved", "queued", "running"].includes(a.status)) a.status = "cancelled"
    return Promise.resolve(a ?? null)
  },
  createApproval: () => Promise.resolve({ kind: "already-active" as const }),
}
vi.mock("@/lib/batch/supabase-approval-repository", () => ({ createSupabaseApprovalRepository: () => approvalRepo }))

// ── 배치 저장소 대역 ──────────────────────────────────────────────
type Item = { id: string; batch_id: string; place_id: string; sequence: number; status: string }
type Run = { id: string; status: string }
const runs: Run[] = []
const items: Item[] = []
const recordedResults: { itemId: string; patch: { status: string; lastErrorCode?: string | null } }[] = []

const batchRepo = {
  getRun: (id: string) => Promise.resolve(runs.find((r) => r.id === id) ?? null),
  listItems: (batchId: string) => Promise.resolve(items.filter((i) => i.batch_id === batchId).map((i) => ({ ...i }))),
  markStaleItemsInterrupted: () => Promise.resolve([]),
  claimNextItem: (batchId: string) => {
    const next = items.filter((i) => i.batch_id === batchId && ["queued", "interrupted"].includes(i.status)).sort((a, b) => a.sequence - b.sequence)[0]
    if (next === undefined) return Promise.resolve(null)
    next.status = "processing"
    return Promise.resolve({ ...next })
  },
  recordItemResult: (itemId: string, patch: { status: string; lastErrorCode?: string | null }) => {
    const it = items.find((i) => i.id === itemId)
    if (it?.status === "processing") {
      it.status = patch.status
      recordedResults.push({ itemId, patch })
      return Promise.resolve(true)
    }
    return Promise.resolve(false)
  },
}
vi.mock("@/lib/batch/supabase-batch-repository", () => ({ createSupabaseBatchRepository: () => batchRepo }))

// ── 생성 서비스 대역 ──────────────────────────────────────────────
const startGenerationBatch = vi.fn<(input: { placeIds: readonly string[]; createdBy: string; maxCostUsd?: number }) => Promise<unknown>>()
const processNextGenerationItem = vi.fn<(batchId: string, opts: unknown) => Promise<{ runStatus: string; done: boolean; processed: unknown }>>()
const cancelGenerationBatch = vi.fn<(batchId: string, actor: string) => Promise<void>>(() => Promise.resolve())
vi.mock("@/lib/batch/generation-batch-service", () => ({
  startGenerationBatch: (input: { placeIds: readonly string[]; createdBy: string; maxCostUsd?: number }) => startGenerationBatch(input),
  processNextGenerationItem: (batchId: string, opts: unknown) => processNextGenerationItem(batchId, opts),
  cancelGenerationBatch: (batchId: string, actor: string) => cancelGenerationBatch(batchId, actor),
}))

// ── supabase 클라이언트 대역 (snapshot 재검증용 place/gen/seo 읽기) ──
type Place = { id: string; name: string; address: string | null; phone: string | null; slug: string | null; status: string; official_verification_status: string | null }
const places: Place[] = []
const generationsByPlace = new Map<string, number>()
const seoPagesByPlace = new Set<string>()

function fakeSelect(table: string, columns: string, opts?: { count?: string; head?: boolean }) {
  let placeId = ""
  const builder = {
    eq(_col: string, val: string) {
      placeId = val
      return builder
    },
    maybeSingle() {
      if (table === "places") return Promise.resolve({ data: places.find((p) => p.id === placeId) ?? null, error: null })
      if (table === "seo_pages") return Promise.resolve({ data: seoPagesByPlace.has(placeId) ? { id: "seo" } : null, error: null })
      return Promise.resolve({ data: null, error: null })
    },
    then(resolve: (v: { count: number | null; error: null }) => void) {
      // head+count 경로 (ai_generations)
      resolve({ count: generationsByPlace.get(placeId) ?? 0, error: null })
    },
  }
  void columns
  void opts
  return builder
}
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => ({ select: (columns: string, opts?: { count?: string; head?: boolean }) => fakeSelect(table, columns, opts) }),
  }),
}))

// ── fixtures ──────────────────────────────────────────────────────
const NOW = "2026-07-24T05:00:00.000Z"
const FUTURE = "2026-07-24T05:30:00.000Z"
const PAST = "2026-07-24T04:00:00.000Z"

function candidate(id: string, name: string): ApprovalCandidateInput {
  return {
    place: { id, name, address: `주소 ${name}`, phone: "055-000-0000", slug: `funeral-${id}`, status: "draft", official_verification_status: "verified", verification_source_urls: ["http://x"] },
    generationCount: 0,
    seoPageExists: false,
    estimatedTokens: 1250,
    estimatedCostUsd: 0.001,
  }
}

function seedApproval(placeCount: number, overrides: Partial<Approval> = {}): { approval: Approval; token: string; snapshot: ReturnType<typeof buildApprovalPlaceSnapshot>[] } {
  const cands = Array.from({ length: placeCount }, (_, i) => candidate(`0000000${String(i)}-0000-0000-0000-00000000000${String(i)}`, `장소${String(i)}`))
  const snapshot = cands.map((c) => buildApprovalPlaceSnapshot(c))
  const minted = mintActivationToken()
  const approval: Approval = {
    id: "approval-1",
    status: "approved",
    approved_by: "admin@midmgroup.com",
    approval_expires_at: FUTURE,
    approved_place_ids: cands.map((c) => c.place.id),
    approved_max_cost_usd: 0.05,
    approval_snapshot: snapshot,
    execution_token_hash: minted.tokenHash,
    activation_consumed_at: null,
    execution_tick: 0,
    batch_run_id: null,
    last_error_code: null,
    last_error_message: null,
    ...overrides,
  }
  approvals.push(approval)
  // place 저장소에도 스냅샷과 일치하는 장소를 넣는다.
  for (const c of cands) {
    places.push({ id: c.place.id, name: c.place.name, address: c.place.address, phone: c.place.phone, slug: c.place.slug, status: "draft", official_verification_status: "verified" })
  }
  return { approval, token: minted.token, snapshot }
}

function seedRunWithItems(batchId: string, placeIds: readonly string[]): void {
  runs.push({ id: batchId, status: "running" })
  placeIds.forEach((placeId, index) => items.push({ id: `item-${String(index)}`, batch_id: batchId, place_id: placeId, sequence: index + 1, status: "queued" }))
}

// processNextGenerationItem 대역: 다음 claimable 1건을 ready로 만들고 done 판정.
function wireProcessNext(): void {
  processNextGenerationItem.mockImplementation((batchId: string) => {
    const next = items.filter((i) => i.batch_id === batchId && ["queued", "interrupted"].includes(i.status)).sort((a, b) => a.sequence - b.sequence)[0]
    if (next === undefined) {
      const run = runs.find((r) => r.id === batchId)
      if (run) run.status = "completed"
      return Promise.resolve({ runStatus: "completed", done: true, processed: null })
    }
    next.status = "ready"
    return Promise.resolve({ runStatus: "running", done: false, processed: { placeId: next.place_id, status: "ready", reason: null } })
  })
}

async function importService() {
  return import("@/lib/batch/approval-execution-service")
}

beforeEach(() => {
  approvals.length = 0
  runs.length = 0
  items.length = 0
  recordedResults.length = 0
  places.length = 0
  generationsByPlace.clear()
  seoPagesByPlace.clear()
  startGenerationBatch.mockReset()
  processNextGenerationItem.mockReset()
  cancelGenerationBatch.mockClear()
  wireProcessNext()
})

describe("activate", () => {
  // PR-D — activate는 접수(batch 생성·연결)까지만 하고 즉시 202를 반환한다.
  // item 처리를 이 요청 안에서 끝내면 호출자 timeout을 넘겨 성공한 실행이 실패로 오분류된다.
  it("accepts, starts the batch, links the run, and hands the first item to tick 0", async () => {
    const { token } = seedApproval(2)
    startGenerationBatch.mockImplementation((input: { placeIds: readonly string[]; createdBy: string }) => {
      seedRunWithItems("batch-1", input.placeIds)
      return Promise.resolve({ kind: "started", batchId: "batch-1" })
    })
    const { executeActivate } = await importService()
    const result = await executeActivate({ activationToken: token, nowIso: NOW, previewDeploymentSha: "sha1" })

    expect(result.outcome).toEqual({ kind: "accepted", approvalStatus: "running" })
    expect(result.nextTick).toEqual({ approvalId: "approval-1", tick: 0 })
    const a = approvals[0]
    expect(a?.status).toBe("running")
    expect(a?.activation_consumed_at).toBe(NOW)
    expect(a?.batch_run_id).toBe("batch-1")
    // tick CAS는 tick 요청에서 수행한다 — activate는 전진시키지 않는다.
    expect(a?.execution_tick).toBe(0)
    // 어떤 item도 activate 요청 안에서 처리되지 않는다.
    expect(items.filter((i) => i.status === "ready")).toHaveLength(0)
    expect(processNextGenerationItem).not.toHaveBeenCalled()
  })

  it("passes the approval's approved_max_cost_usd to startGenerationBatch as the execution cost cap (F1)", async () => {
    // 승인값을 글로벌 기본값(0.05)과 다른 값으로 둬서 실제 승인값이 흘러가는지 구분한다.
    const { token } = seedApproval(2, { approved_max_cost_usd: 0.02 })
    startGenerationBatch.mockImplementation((input: { placeIds: readonly string[] }) => {
      seedRunWithItems("batch-1", input.placeIds)
      return Promise.resolve({ kind: "started", batchId: "batch-1" })
    })
    const { executeActivate } = await importService()
    await executeActivate({ activationToken: token, nowIso: NOW, previewDeploymentSha: "sha1" })

    expect(startGenerationBatch).toHaveBeenCalledWith(expect.objectContaining({ maxCostUsd: 0.02 }))
  })

  it("rejects an unknown activation token (401)", async () => {
    seedApproval(1)
    const { executeActivate } = await importService()
    const result = await executeActivate({ activationToken: "wrong-token", nowIso: NOW, previewDeploymentSha: null })
    expect(result.outcome.kind).toBe("unauthorized")
    expect(startGenerationBatch).not.toHaveBeenCalled()
  })

  it("expires an approval past its deadline (410) without consuming the token", async () => {
    const { token } = seedApproval(1, { approval_expires_at: PAST })
    const { executeActivate } = await importService()
    const result = await executeActivate({ activationToken: token, nowIso: NOW, previewDeploymentSha: null })
    expect(result.outcome.kind).toBe("expired")
    expect(approvals[0]?.status).toBe("expired")
    expect(approvals[0]?.activation_consumed_at).toBeNull()
  })

  it("blocks reuse: a consumed token cannot activate again", async () => {
    const { token } = seedApproval(1)
    startGenerationBatch.mockImplementation((input: { placeIds: readonly string[] }) => {
      seedRunWithItems("batch-1", input.placeIds)
      return Promise.resolve({ kind: "started", batchId: "batch-1" })
    })
    const { executeActivate } = await importService()
    await executeActivate({ activationToken: token, nowIso: NOW, previewDeploymentSha: null })
    // 두 번째 활성화 시도 — running 상태 + 소진됨 → conflict
    const second = await executeActivate({ activationToken: token, nowIso: NOW, previewDeploymentSha: null })
    expect(second.outcome.kind).toBe("conflict")
    expect(startGenerationBatch).toHaveBeenCalledTimes(1)
  })

  it("compensates to failed when startGenerationBatch fails (running→failed, token stays consumed)", async () => {
    const { token } = seedApproval(2)
    startGenerationBatch.mockResolvedValue({ kind: "already-running" })
    const { executeActivate } = await importService()
    const result = await executeActivate({ activationToken: token, nowIso: NOW, previewDeploymentSha: null })
    expect(result.outcome.kind).toBe("conflict")
    const a = approvals[0]
    expect(a?.status).toBe("failed")
    expect(a?.last_error_code).toBe("start-failed")
    expect(a?.activation_consumed_at).toBe(NOW) // 소진 유지 → 자동 재활성화 금지
  })

  it("pre-flight blocks and fails the approval when a place changed after approval", async () => {
    const { token } = seedApproval(1)
    // 승인 후 주소 변경 → snapshot hash 불일치
    if (places[0]) places[0].address = "변경된 주소"
    const { executeActivate } = await importService()
    const result = await executeActivate({ activationToken: token, nowIso: NOW, previewDeploymentSha: null })
    expect(result.outcome.kind).toBe("conflict")
    expect(result.outcome.kind === "conflict" && result.outcome.reason).toContain("preflight")
    expect(approvals[0]?.status).toBe("failed")
    expect(startGenerationBatch).not.toHaveBeenCalled()
    expect(approvals[0]?.activation_consumed_at).toBeNull() // 토큰 미소진
  })

  it("pre-flight blocks a place that already has a generation or seo_page", async () => {
    const { token } = seedApproval(1)
    generationsByPlace.set(places[0]?.id ?? "", 1)
    const { executeActivate } = await importService()
    const result = await executeActivate({ activationToken: token, nowIso: NOW, previewDeploymentSha: null })
    expect(result.outcome.kind === "conflict" && result.outcome.reason).toContain("has-generation")
    expect(startGenerationBatch).not.toHaveBeenCalled()
  })

  // PR-D — 1건 배치도 activate 요청 안에서 끝내지 않는다. 접수만 하고 tick=0에서 처리한다.
  it("does not complete a single-place batch inside activate — it hands off to tick 0", async () => {
    const { token } = seedApproval(1)
    startGenerationBatch.mockImplementation((input: { placeIds: readonly string[] }) => {
      seedRunWithItems("batch-1", input.placeIds)
      return Promise.resolve({ kind: "started", batchId: "batch-1" })
    })
    const { executeActivate, executeTick } = await importService()

    const activated = await executeActivate({ activationToken: token, nowIso: NOW, previewDeploymentSha: null })
    expect(activated.outcome).toEqual({ kind: "accepted", approvalStatus: "running" })
    expect(activated.nextTick).toEqual({ approvalId: "approval-1", tick: 0 })
    expect(approvals[0]?.status).toBe("running")
    expect(items.filter((i) => i.status === "ready")).toHaveLength(0)

    // 첫 tick이 CAS 0→1 후 실제로 처리하고, 1건이므로 여기서 완료된다.
    const first = await executeTick({ approvalId: "approval-1", tick: 0, nowIso: NOW, previewDeploymentSha: null })
    expect(first.outcome).toEqual({ kind: "completed", approvalStatus: "completed" })
    expect(approvals[0]?.status).toBe("completed")
    expect(approvals[0]?.execution_tick).toBe(1)
  })
})

// PR-D — approval은 연결된 run의 최종 상태를 그대로 따라간다 (예전엔 무조건 completed로 닫았다).
describe("approval/run 상태 수렴", () => {
  async function activateThenSetRunStatus(runStatus: string) {
    const { token } = seedApproval(2)
    startGenerationBatch.mockImplementation((input: { placeIds: readonly string[] }) => {
      seedRunWithItems("batch-1", input.placeIds)
      return Promise.resolve({ kind: "started", batchId: "batch-1" })
    })
    const svc = await importService()
    await svc.executeActivate({ activationToken: token, nowIso: NOW, previewDeploymentSha: null })
    const run = runs.find((r) => r.id === "batch-1")
    if (run) run.status = runStatus
    return svc
  }

  it("converges to completed when the run completed", async () => {
    const svc = await activateThenSetRunStatus("completed")
    const result = await svc.executeTick({ approvalId: "approval-1", tick: 0, nowIso: NOW, previewDeploymentSha: null })
    expect(result.outcome).toEqual({ kind: "completed", approvalStatus: "completed" })
    expect(approvals[0]?.status).toBe("completed")
  })

  it("converges to failed when the run failed", async () => {
    const svc = await activateThenSetRunStatus("failed")
    const result = await svc.executeTick({ approvalId: "approval-1", tick: 0, nowIso: NOW, previewDeploymentSha: null })
    expect(result.outcome).toEqual({ kind: "conflict", reason: "run-failed" })
    expect(approvals[0]?.status).toBe("failed")
  })

  it("converges to cancelled when the run was cancelled", async () => {
    const svc = await activateThenSetRunStatus("cancelled")
    const result = await svc.executeTick({ approvalId: "approval-1", tick: 0, nowIso: NOW, previewDeploymentSha: null })
    expect(result.outcome).toEqual({ kind: "conflict", reason: "run-cancelled" })
    expect(approvals[0]?.status).toBe("cancelled")
  })
})

describe("tick — 5건 순차 self-chain", () => {
  async function activateFive() {
    const { token } = seedApproval(5)
    startGenerationBatch.mockImplementation((input: { placeIds: readonly string[] }) => {
      seedRunWithItems("batch-1", input.placeIds)
      return Promise.resolve({ kind: "started", batchId: "batch-1" })
    })
    const svc = await importService()
    const first = await svc.executeActivate({ activationToken: token, nowIso: NOW, previewDeploymentSha: null })
    return { svc, first }
  }

  it("drives all 5 items to ready then completes, one item per call", async () => {
    const { svc, first } = await activateFive()
    let next = first.nextTick
    let guard = 0
    while (next !== null && guard < 10) {
      guard += 1
      const r = await svc.executeTick({ approvalId: next.approvalId, tick: next.tick, nowIso: NOW, previewDeploymentSha: null })
      next = r.nextTick
      if (r.outcome.kind === "completed") break
    }
    expect(items.filter((i) => i.status === "ready")).toHaveLength(5)
    expect(approvals[0]?.status).toBe("completed")
    expect(runs[0]?.status).toBe("completed")
  })

  it("is a no-op on a duplicate/delayed tick (CAS fail) without processing an item", async () => {
    const { svc, first } = await activateFive()
    const tick = first.nextTick
    expect(tick).not.toBeNull()
    if (tick === null) return
    // 첫 tick(0)을 정상 처리해 execution_tick을 1로 올린다.
    await svc.executeTick({ approvalId: tick.approvalId, tick: tick.tick, nowIso: NOW, previewDeploymentSha: null })
    const readyBefore = items.filter((i) => i.status === "ready").length
    // 같은 tick(0)을 다시 보내면 이미 지나간 값이라 CAS 실패 → no-op
    const stale = await svc.executeTick({ approvalId: tick.approvalId, tick: 0, nowIso: NOW, previewDeploymentSha: null })
    expect(stale.outcome).toEqual({ kind: "noop", reason: "duplicate-tick" })
    expect(items.filter((i) => i.status === "ready")).toHaveLength(readyBefore)
  })

  it("fails only the mismatched item and continues with the rest", async () => {
    const { svc, first } = await activateFive()
    // 두 번째로 처리될 장소(seq2)를 승인 후 변경
    const seq2 = items.find((i) => i.sequence === 2)
    const place2 = places.find((p) => p.id === seq2?.place_id)
    if (place2) place2.phone = "055-999-9999"
    let next = first.nextTick
    let guard = 0
    while (next !== null && guard < 10) {
      guard += 1
      const r = await svc.executeTick({ approvalId: next.approvalId, tick: next.tick, nowIso: NOW, previewDeploymentSha: null })
      next = r.nextTick
      if (r.outcome.kind === "completed") break
    }
    // seq2만 snapshot-mismatch failed, 나머지 4건 ready
    const failed = recordedResults.filter((r) => r.patch.lastErrorCode === "snapshot-mismatch")
    expect(failed).toHaveLength(1)
    expect(items.find((i) => i.sequence === 2)?.status).toBe("failed")
    expect(items.filter((i) => i.status === "ready")).toHaveLength(4)
    expect(approvals[0]?.status).toBe("completed")
  })

  it("rejects a tick for an unknown approval (401)", async () => {
    const { svc } = await activateFive()
    const r = await svc.executeTick({ approvalId: "99999999-9999-9999-9999-999999999999", tick: 1, nowIso: NOW, previewDeploymentSha: null })
    expect(r.outcome.kind).toBe("unauthorized")
  })

  it("no-ops a tick after the approval already completed", async () => {
    const { svc, first } = await activateFive()
    let next = first.nextTick
    let guard = 0
    while (next !== null && guard < 10) {
      guard += 1
      const r = await svc.executeTick({ approvalId: next.approvalId, tick: next.tick, nowIso: NOW, previewDeploymentSha: null })
      next = r.nextTick
      if (r.outcome.kind === "completed") break
    }
    // 완료 후 임의 tick 재호출 → no-op
    const after = await svc.executeTick({ approvalId: "approval-1", tick: 3, nowIso: NOW, previewDeploymentSha: null })
    expect(after.outcome.kind).toBe("noop")
    expect(after.outcome.kind === "noop" && after.outcome.reason).toContain("terminal")
  })

  it("no-ops a tick after the approval was cancelled", async () => {
    const { svc, first } = await activateFive()
    if (approvals[0]) approvals[0].status = "cancelled"
    const next = first.nextTick
    if (next === null) throw new Error("expected next tick")
    const r = await svc.executeTick({ approvalId: next.approvalId, tick: next.tick, nowIso: NOW, previewDeploymentSha: null })
    expect(r.outcome.kind).toBe("noop")
  })

  it("rejects a tick beyond the max limit", async () => {
    const { svc } = await activateFive()
    const r = await svc.executeTick({ approvalId: "approval-1", tick: 99, nowIso: NOW, previewDeploymentSha: null })
    expect(r.outcome.kind).toBe("conflict")
    expect(r.outcome.kind === "conflict" && r.outcome.reason).toBe("tick-limit")
  })

  it("converges to completed when the batch_run already finished (재개 정합)", async () => {
    const { svc, first } = await activateFive()
    // run을 강제로 completed로 만들고 tick 호출
    if (runs[0]) runs[0].status = "completed"
    const next = first.nextTick
    if (next === null) throw new Error("expected next tick")
    const r = await svc.executeTick({ approvalId: next.approvalId, tick: next.tick, nowIso: NOW, previewDeploymentSha: null })
    expect(r.outcome).toEqual({ kind: "completed", approvalStatus: "completed" })
    expect(approvals[0]?.status).toBe("completed")
  })
})
