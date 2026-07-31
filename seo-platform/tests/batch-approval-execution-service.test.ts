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
  approved_at: string
  approval_expires_at: string
  approved_place_ids: string[]
  approved_max_cost_usd: number
  approval_snapshot: unknown
  execution_token_hash: string
  activation_consumed_at: string | null
  execution_tick: number
  batch_run_id: string | null
  lease_token_hash: string | null
  lease_expires_at: string | null
  pump_attempt: number
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
  completeApproval: (id: string, leaseTokenHash?: string) => {
    const a = approvals.find((x) => x.id === id)
    if (a?.status !== "running") return Promise.resolve(null)
    // lease 조건부 — 잃은 워커는 남의 진행을 닫지 못한다.
    if (leaseTokenHash !== undefined && a.lease_token_hash !== leaseTokenHash) return Promise.resolve(null)
    a.status = "completed"
    a.lease_token_hash = null
    a.lease_expires_at = null
    return Promise.resolve(a)
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

  // ── pump lease 대역 — 실제 RPC와 같은 조건: running ∧ batch_run 연결 ∧ lease 없음/만료.
  claimPumpLease: ({ leaseTokenHash, leaseSeconds, nowIso }: { leaseTokenHash: string; leaseSeconds: number; nowIso: string }) => {
    const nowMs = Date.parse(nowIso)
    const candidate = approvals
      .filter((a) => a.status === "running" && a.batch_run_id !== null)
      .filter((a) => a.lease_expires_at === null || Date.parse(a.lease_expires_at) <= nowMs)
      // 실제 RPC와 같은 정렬: activate 시각(activation_consumed_at) → 승인 시각 → id.
      // null은 뒤로 민다 (nulls last).
      .sort((a, b) => {
        const at = a.activation_consumed_at === null ? Number.POSITIVE_INFINITY : Date.parse(a.activation_consumed_at)
        const bt = b.activation_consumed_at === null ? Number.POSITIVE_INFINITY : Date.parse(b.activation_consumed_at)
        return at - bt || Date.parse(a.approved_at) - Date.parse(b.approved_at) || a.id.localeCompare(b.id)
      })[0]
    if (candidate === undefined) return Promise.resolve(null)
    candidate.lease_token_hash = leaseTokenHash
    candidate.lease_expires_at = new Date(nowMs + leaseSeconds * 1000).toISOString()
    candidate.pump_attempt += 1
    return Promise.resolve({ ...candidate })
  },
  releasePumpLease: ({ approvalId, leaseTokenHash }: { approvalId: string; leaseTokenHash: string }) => {
    const a = approvals.find((x) => x.id === approvalId)
    if (a?.lease_token_hash === leaseTokenHash) {
      a.lease_token_hash = null
      a.lease_expires_at = null
    }
    return Promise.resolve()
  },
  holdsPumpLease: ({ approvalId, leaseTokenHash }: { approvalId: string; leaseTokenHash: string }) =>
    Promise.resolve(approvals.find((x) => x.id === approvalId)?.lease_token_hash === leaseTokenHash),
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
    approved_at: NOW,
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
    lease_token_hash: null,
    lease_expires_at: null,
    pump_attempt: 0,
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

// Cron 1회 호출 = lease claim 1회 + item 1건. 자기 호출이 없으므로 "다음 tick"을 따라가는 대신
// 스케줄러가 다시 부르는 것을 pumpOnce 반복으로 재현한다.
async function pumpOnce(nowIso = NOW): Promise<{ claimed: boolean; outcomeKind: string }> {
  const svc = await importService()
  const claim = await svc.claimBatchPumpLease({ nowIso })
  if (claim.kind !== "claimed") {
    return { claimed: false, outcomeKind: "idle" }
  }
  const outcome = await svc.runLeasedApprovalStep({
    approval: claim.approval,
    leaseTokenHash: claim.leaseTokenHash,
    nowIso,
    previewDeploymentSha: null,
  })
  return { claimed: true, outcomeKind: outcome.kind }
}

// 잔여가 없어질 때까지 Cron을 계속 돌린다.
async function drainPump(maxCalls = 50): Promise<number> {
  let calls = 0
  for (let i = 0; i < maxCalls; i += 1) {
    const tick = await pumpOnce()
    if (!tick.claimed) {
      break
    }
    calls += 1
  }
  return calls
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
  // activate는 접수(batch 생성·연결)까지만 하고 즉시 202를 반환한다.
  // item 처리를 이 요청 안에서 끝내면 호출자 timeout을 넘겨 성공한 실행이 실패로 오분류된다.
  // 처리 자체는 Cron이 부르는 pump가 맡는다 — activate는 아무것도 발사하지 않는다.
  it("accepts, starts the batch, links the run, and hands the first item to the pump", async () => {
    const { token } = seedApproval(2)
    startGenerationBatch.mockImplementation((input: { placeIds: readonly string[]; createdBy: string }) => {
      seedRunWithItems("batch-1", input.placeIds)
      return Promise.resolve({ kind: "started", batchId: "batch-1" })
    })
    const { executeActivate } = await importService()
    const result = await executeActivate({ activationToken: token, nowIso: NOW, previewDeploymentSha: "sha1" })

    expect(result.outcome).toEqual({ kind: "accepted", approvalStatus: "running" })
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

  // 1건 배치도 activate 요청 안에서 끝내지 않는다. 접수만 하고 첫 Cron 호출이 처리한다.
  it("does not complete a single-place batch inside activate — it hands off to the pump", async () => {
    const { token } = seedApproval(1)
    startGenerationBatch.mockImplementation((input: { placeIds: readonly string[] }) => {
      seedRunWithItems("batch-1", input.placeIds)
      return Promise.resolve({ kind: "started", batchId: "batch-1" })
    })
    const { executeActivate } = await importService()

    const activated = await executeActivate({ activationToken: token, nowIso: NOW, previewDeploymentSha: null })
    expect(activated.outcome).toEqual({ kind: "accepted", approvalStatus: "running" })
    expect(approvals[0]?.status).toBe("running")
    expect(items.filter((i) => i.status === "ready")).toHaveLength(0)

    // 첫 Cron 호출이 실제로 처리하고, 1건이므로 여기서 완료된다.
    const first = await pumpOnce()
    expect(first.outcomeKind).toBe("completed")
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
    await activateThenSetRunStatus("completed")
    const result = await pumpOnce()
    expect(result.outcomeKind).toBe("completed")
    expect(approvals[0]?.status).toBe("completed")
  })

  it("converges to failed when the run failed", async () => {
    await activateThenSetRunStatus("failed")
    const result = await pumpOnce()
    expect(result.outcomeKind).toBe("conflict")
    expect(approvals[0]?.status).toBe("failed")
  })

  it("converges to cancelled when the run was cancelled", async () => {
    await activateThenSetRunStatus("cancelled")
    const result = await pumpOnce()
    expect(result.outcomeKind).toBe("conflict")
    expect(approvals[0]?.status).toBe("cancelled")
  })
})


// Cron 1회 호출 = item 1건. 5곳 승인이면 Cron 5회로 끝난다 — self-fetch는 0이다.
// (예전 self-chain 구조는 승인 상한인 5곳에서 5번째 발사가 508에 걸렸다.)
describe("pump — 5건 순차 처리 (Cron pull)", () => {
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

  it("5건 전부 ready가 되고 승인이 완료된다 — Cron 호출 5회, 호출당 item 1건", async () => {
    await activateFive()
    const calls = await drainPump()

    expect(calls).toBe(5)
    expect(items.filter((i) => i.status === "ready")).toHaveLength(5)
    expect(approvals[0]?.status).toBe("completed")
    expect(runs[0]?.status).toBe("completed")
    expect(approvals[0]?.pump_attempt).toBe(5)
  })

  it("한 번 호출하면 item이 정확히 1건만 처리된다", async () => {
    await activateFive()
    const tick = await pumpOnce()

    expect(tick.claimed).toBe(true)
    expect(items.filter((i) => i.status === "ready")).toHaveLength(1)
    expect(items.filter((i) => i.status === "queued")).toHaveLength(4)
    expect(approvals[0]?.status).toBe("running")
  })

  it("불일치 item만 실패로 건너뛰고 나머지는 계속 진행한다", async () => {
    await activateFive()
    // 두 번째로 처리될 장소(seq2)를 승인 후 변경
    const seq2 = items.find((i) => i.sequence === 2)
    const place2 = places.find((p) => p.id === seq2?.place_id)
    if (place2) place2.phone = "055-999-9999"

    await drainPump()

    const failed = recordedResults.filter((r) => r.patch.lastErrorCode === "snapshot-mismatch")
    expect(failed).toHaveLength(1)
    expect(items.find((i) => i.sequence === 2)?.status).toBe("failed")
    expect(items.filter((i) => i.status === "ready")).toHaveLength(4)
    expect(approvals[0]?.status).toBe("completed")
  })

  it("완료된 승인은 더 이상 claim되지 않는다", async () => {
    await activateFive()
    await drainPump()

    const extra = await pumpOnce()
    expect(extra.claimed).toBe(false)
    expect(items.filter((i) => i.status === "ready")).toHaveLength(5)
  })

  it("취소된 승인은 claim되지 않는다", async () => {
    await activateFive()
    if (approvals[0]) approvals[0].status = "cancelled"

    const tick = await pumpOnce()
    expect(tick.claimed).toBe(false)
    expect(items.filter((i) => i.status === "ready")).toHaveLength(0)
  })

  it("실행 횟수 상한을 넘기면 승인을 실패로 닫는다", async () => {
    await activateFive()
    if (approvals[0]) approvals[0].execution_tick = 99

    const tick = await pumpOnce()
    expect(tick.outcomeKind).toBe("conflict")
    expect(approvals[0]?.status).toBe("failed")
    expect(approvals[0]?.last_error_code).toBe("tick-limit")
  })

  it("batch_run이 이미 끝났으면 승인을 그 결과로 수렴시킨다 (재개 정합)", async () => {
    await activateFive()
    if (runs[0]) runs[0].status = "completed"

    const tick = await pumpOnce()
    expect(tick.outcomeKind).toBe("completed")
    expect(approvals[0]?.status).toBe("completed")
  })
})

describe("pump — 승인 게이트", () => {
  it("activate 하지 않은 approved 승인은 절대 claim되지 않는다", async () => {
    seedApproval(3)
    const svc = await importService()

    const claim = await svc.claimBatchPumpLease({ nowIso: NOW })

    expect(claim.kind).toBe("idle")
    expect(approvals[0]?.status).toBe("approved")
    expect(startGenerationBatch).not.toHaveBeenCalled()
    expect(processNextGenerationItem).not.toHaveBeenCalled()
  })

  it("queued(발사 표시만 된) 승인도 claim되지 않는다", async () => {
    seedApproval(3, { status: "queued" })
    const svc = await importService()
    expect((await svc.claimBatchPumpLease({ nowIso: NOW })).kind).toBe("idle")
  })

  it("batch_run이 연결되지 않은 running 승인은 claim되지 않는다", async () => {
    seedApproval(3, { status: "running", batch_run_id: null })
    const svc = await importService()
    expect((await svc.claimBatchPumpLease({ nowIso: NOW })).kind).toBe("idle")
  })

  for (const status of ["completed", "failed", "cancelled", "expired"] as const) {
    it(`${status} 승인은 claim되지 않는다`, async () => {
      seedApproval(3, { status, batch_run_id: "batch-1" })
      const svc = await importService()
      expect((await svc.claimBatchPumpLease({ nowIso: NOW })).kind).toBe("idle")
    })
  }
})

describe("pump — claim 정렬", () => {
  // 2026-07-31: 이 테이블에 없는 activated_at으로 정렬해 migration이 42703으로 실패했다.
  // 실제 activate 시각 컬럼은 activation_consumed_at이며, 그 순서를 여기서 고정한다.
  function seedRunning(id: string, patch: Partial<Approval>): void {
    const { approval } = seedApproval(1, { status: "running", batch_run_id: "batch-1", ...patch })
    approval.id = id
  }

  it("먼저 activate된 승인을 먼저 가져간다", async () => {
    seedRunning("approval-late", { activation_consumed_at: "2026-07-31T00:05:00.000Z" })
    seedRunning("approval-early", { activation_consumed_at: "2026-07-31T00:01:00.000Z" })
    const svc = await importService()

    const claim = await svc.claimBatchPumpLease({ nowIso: NOW })

    if (claim.kind !== "claimed") {
      throw new Error("expected claimed")
    }
    expect(claim.approval.id).toBe("approval-early")
  })

  it("activate 시각이 비어 있으면 뒤로 민다 (nulls last)", async () => {
    seedRunning("approval-null", { activation_consumed_at: null })
    seedRunning("approval-dated", { activation_consumed_at: "2026-07-31T00:09:00.000Z" })
    const svc = await importService()

    const claim = await svc.claimBatchPumpLease({ nowIso: NOW })

    if (claim.kind !== "claimed") {
      throw new Error("expected claimed")
    }
    expect(claim.approval.id).toBe("approval-dated")
  })

  it("activate 시각이 같으면 승인 시각으로 순서를 확정한다", async () => {
    const sameActivate = "2026-07-31T00:03:00.000Z"
    seedRunning("approval-b", { activation_consumed_at: sameActivate, approved_at: "2026-07-31T00:02:00.000Z" })
    seedRunning("approval-a", { activation_consumed_at: sameActivate, approved_at: "2026-07-31T00:00:30.000Z" })
    const svc = await importService()

    const claim = await svc.claimBatchPumpLease({ nowIso: NOW })

    if (claim.kind !== "claimed") {
      throw new Error("expected claimed")
    }
    expect(claim.approval.id).toBe("approval-a")
  })
})

describe("pump — lease 소유권", () => {
  async function seedRunning() {
    seedApproval(3, { status: "running", batch_run_id: "batch-1" })
    seedRunWithItems("batch-1", approvals[0]?.approved_place_ids ?? [])
    return importService()
  }

  it("동시에 두 pump가 들어오면 승자는 하나뿐이다", async () => {
    const svc = await seedRunning()

    const [first, second] = await Promise.all([svc.claimBatchPumpLease({ nowIso: NOW }), svc.claimBatchPumpLease({ nowIso: NOW })])

    expect([first, second].filter((c) => c.kind === "claimed")).toHaveLength(1)
    expect(approvals[0]?.pump_attempt).toBe(1)
  })

  it("lease를 쥔 승인은 만료 전까지 다시 claim되지 않는다", async () => {
    const svc = await seedRunning()

    expect((await svc.claimBatchPumpLease({ nowIso: "2026-07-31T00:00:00.000Z" })).kind).toBe("claimed")
    // lease 유효시간(120초)의 절반 시점 — 아직 남의 것이다.
    expect((await svc.claimBatchPumpLease({ nowIso: "2026-07-31T00:01:00.000Z" })).kind).toBe("idle")
  })

  it("lease가 만료되면 다음 pump가 같은 승인을 이어받는다", async () => {
    const svc = await seedRunning()

    const dead = await svc.claimBatchPumpLease({ nowIso: "2026-07-31T00:00:00.000Z" })
    expect(dead.kind).toBe("claimed")
    const revived = await svc.claimBatchPumpLease({ nowIso: "2026-07-31T00:03:00.000Z" })

    expect(revived.kind).toBe("claimed")
    expect(approvals[0]?.pump_attempt).toBe(2)
    // 커서(item 상태)는 전진하지 않았으므로 같은 item부터 처리한다.
    expect(items.filter((i) => i.status === "queued")).toHaveLength(3)
  })

  it("lease를 잃은 워커는 승인을 완료로 닫지 못한다", async () => {
    const svc = await seedRunning()

    const stale = await svc.claimBatchPumpLease({ nowIso: "2026-07-31T00:00:00.000Z" })
    if (stale.kind !== "claimed") throw new Error("expected claimed")
    // 그 사이 lease가 만료되고 다른 pump가 가져갔다.
    const winner = await svc.claimBatchPumpLease({ nowIso: "2026-07-31T00:03:00.000Z" })
    expect(winner.kind).toBe("claimed")

    // 죽었다고 생각한 워커가 뒤늦게 끝나고 승인을 닫으려 한다.
    if (runs[0]) runs[0].status = "completed"
    const outcome = await svc.runLeasedApprovalStep({
      approval: stale.approval,
      leaseTokenHash: stale.leaseTokenHash,
      nowIso: "2026-07-31T00:03:30.000Z",
      previewDeploymentSha: null,
    })

    expect(outcome).toEqual({ kind: "noop", reason: "lease-lost" })
    expect(approvals[0]?.status).toBe("running")
  })

  it("item 1건을 끝내면 lease를 놓아 다음 Cron이 곧바로 가져갈 수 있다", async () => {
    const svc = await seedRunning()

    const claim = await svc.claimBatchPumpLease({ nowIso: NOW })
    if (claim.kind !== "claimed") throw new Error("expected claimed")
    await svc.runLeasedApprovalStep({ approval: claim.approval, leaseTokenHash: claim.leaseTokenHash, nowIso: NOW, previewDeploymentSha: null })

    expect(approvals[0]?.lease_token_hash).toBeNull()
    expect(approvals[0]?.lease_expires_at).toBeNull()
    expect((await svc.claimBatchPumpLease({ nowIso: NOW })).kind).toBe("claimed")
  })
})
