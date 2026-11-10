// 자동 생성 캠페인 판정 계약 — 스위치·설정 해석·예산·정지·재승인 금지·실행 허가·고아 복구.
// 이 기능은 사람 클릭 없이 승인을 만들므로, "애매하면 아무것도 하지 않는다"가 모든 분기의 기본값이어야 한다.
import { describe, expect, it } from "vitest"

import {
  AUTO_GENERATE_MAX_DAILY_LIMIT,
  AUTO_GENERATE_MAX_TOTAL_LIMIT,
  AUTO_GENERATE_STALE_APPROVAL_MS,
  autoGenerateApprover,
  decideAutoApprovalRun,
  decideAutoGenerateStep,
  decideOrphanApproval,
  isAutoGenerateApprover,
  kstDayStartIso,
  parseAutoGenerateCampaign,
  parseAutoGenerateMode,
  type ActiveApprovalSummary,
  type AutoGenerateCampaign,
  type CampaignApprovalSummary,
  type CampaignRunSummary,
} from "@/lib/batch/auto-generate-policy"
import { BATCH_MAX_ITEMS } from "@/lib/batch/types"

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const approvalId = (n: number): string => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`
const NOW = "2026-11-10T06:00:00.000Z" // 15:00 KST

function campaign(overrides: Partial<AutoGenerateCampaign> = {}): AutoGenerateCampaign {
  return {
    id: "pilot-1",
    expiresAt: "2026-12-10T00:00:00.000Z",
    batchSize: 20,
    dailyLimit: 100,
    totalLimit: 969,
    allowPlaceIds: Array.from({ length: 50 }, (_, index) => id(index + 1)),
    requireReviewEachBatch: false,
    maxNeedsReviewRatio: 0.1,
    acknowledgedApprovalIds: [],
    ...overrides,
  }
}

function approval(n: number, status: string, approvedAt: string, placeIds: readonly string[]): CampaignApprovalSummary {
  return { id: approvalId(n), status, approvedAt, placeIds, approvedMaxCostUsd: 0.04 }
}

function run(overrides: Partial<CampaignRunSummary> = {}): CampaignRunSummary {
  return { itemCount: 20, failedCount: 0, needsReviewCount: 0, skippedCount: 0, costUnknownCount: 0, actualCostUsd: 0.018, ...overrides }
}

function decide(overrides: Partial<Parameters<typeof decideAutoGenerateStep>[0]> = {}) {
  return decideAutoGenerateStep({ mode: "on", campaign: campaign(), nowIso: NOW, activeApprovalCount: 0, campaignApprovals: [], latestRun: null, ...overrides })
}

const completedYesterday = approval(1, "completed", "2026-11-09T01:00:00.000Z", [id(1), id(2)])

describe("스위치 해석", () => {
  it('"on"·"cancel"만 의미가 있고 나머지는 전부 off다', () => {
    expect(parseAutoGenerateMode("on")).toBe("on")
    expect(parseAutoGenerateMode(" ON ")).toBe("on")
    expect(parseAutoGenerateMode("cancel")).toBe("cancel")
    for (const value of ["off", "", "true", "pause", true, 1, null, undefined, { on: true }]) {
      expect(parseAutoGenerateMode(value)).toBe("off")
    }
  })
})

describe("캠페인 설정 해석", () => {
  const valid = {
    id: "pilot-1",
    expiresAt: "2026-12-10T00:00:00.000Z",
    batchSize: 20,
    dailyLimit: 20,
    totalLimit: 20,
    allowPlaceIds: [id(1), id(2)],
    requireReviewEachBatch: true,
    maxNeedsReviewRatio: 0.1,
    acknowledgedApprovalIds: [],
  }

  it("올바른 설정을 그대로 읽는다", () => {
    expect(parseAutoGenerateCampaign(valid)).toEqual(valid)
    expect(parseAutoGenerateCampaign({ ...valid, acknowledgedApprovalIds: [approvalId(1)] })?.acknowledgedApprovalIds).toEqual([approvalId(1)])
  })

  it.each([
    ["객체가 아님", "on"],
    ["배열", [valid]],
    ["null", null],
    ["id 형식 위반", { ...valid, id: "Pilot 1" }],
    ["만료 시각 해석 불가", { ...valid, expiresAt: "soon" }],
    ["batchSize가 배치 상한 초과", { ...valid, batchSize: BATCH_MAX_ITEMS + 1 }],
    ["batchSize 0", { ...valid, batchSize: 0 }],
    ["dailyLimit가 천장 초과", { ...valid, dailyLimit: AUTO_GENERATE_MAX_DAILY_LIMIT + 1 }],
    ["dailyLimit 소수", { ...valid, dailyLimit: 1.5 }],
    ["totalLimit 문자열", { ...valid, totalLimit: "969" }],
    ["totalLimit가 천장 초과", { ...valid, totalLimit: AUTO_GENERATE_MAX_TOTAL_LIMIT + 1 }],
    ["allowPlaceIds 누락", { ...valid, allowPlaceIds: undefined }],
    ["allowPlaceIds에 UUID 아닌 값", { ...valid, allowPlaceIds: [id(1), "all"] }],
    ["allowPlaceIds 중복", { ...valid, allowPlaceIds: [id(1), id(1)] }],
    ["allowPlaceIds가 천장 초과", { ...valid, allowPlaceIds: Array.from({ length: AUTO_GENERATE_MAX_TOTAL_LIMIT + 1 }, (_, index) => id(index + 1)) }],
    // 기본값으로 채우지 않는다 — 빠뜨린 설정을 느슨한 값으로 해석하면 안전장치가 조용히 꺼진다.
    ["requireReviewEachBatch 누락", { ...valid, requireReviewEachBatch: undefined }],
    ["requireReviewEachBatch 문자열", { ...valid, requireReviewEachBatch: "true" }],
    ["maxNeedsReviewRatio 누락", { ...valid, maxNeedsReviewRatio: undefined }],
    ["maxNeedsReviewRatio 범위 밖", { ...valid, maxNeedsReviewRatio: 1.5 }],
    ["acknowledgedApprovalIds 누락", { ...valid, acknowledgedApprovalIds: undefined }],
    ["acknowledgedApprovalIds에 UUID 아닌 값", { ...valid, acknowledgedApprovalIds: ["latest"] }],
  ])("%s → 캠페인 없음", (_label, value) => {
    expect(parseAutoGenerateCampaign(value)).toBeNull()
  })
})

describe("승인자 표식", () => {
  it("캠페인 승인은 사용자 이메일과 구분되는 접두사를 쓴다", () => {
    expect(autoGenerateApprover("pilot-1")).toBe("auto-generate:pilot-1")
    expect(isAutoGenerateApprover("auto-generate:pilot-1")).toBe(true)
    expect(isAutoGenerateApprover("admin@example.com")).toBe(false)
    expect(isAutoGenerateApprover(null)).toBe(false)
    expect(isAutoGenerateApprover(undefined)).toBe(false)
  })
})

describe("KST 하루 경계", () => {
  it("00:00 KST(= 전날 15:00 UTC)를 돌려준다", () => {
    expect(kstDayStartIso("2026-11-10T06:00:00.000Z")).toBe("2026-11-09T15:00:00.000Z")
    expect(kstDayStartIso("2026-11-10T14:59:59.000Z")).toBe("2026-11-09T15:00:00.000Z")
    expect(kstDayStartIso("2026-11-10T15:00:00.000Z")).toBe("2026-11-10T15:00:00.000Z")
  })
})

describe("한 걸음 판정 — 기본 게이트", () => {
  it.each(["off", "cancel"] as const)("스위치가 %s면 새 승인을 만들지 않는다", (mode) => {
    expect(decide({ mode })).toEqual({ kind: "disabled" })
  })

  it("캠페인 설정이 없거나 해석되지 않으면 아무것도 하지 않는다", () => {
    expect(decide({ campaign: null })).toEqual({ kind: "no-campaign" })
  })

  it("만료된 캠페인은 새 승인을 만들지 않는다", () => {
    expect(decide({ campaign: campaign({ expiresAt: NOW }) })).toEqual({ kind: "campaign-expired" })
  })

  it("진행 중 승인이 있으면 기다린다 (전역 1건)", () => {
    expect(decide({ activeApprovalCount: 1 })).toEqual({ kind: "busy" })
  })

  it("첫 걸음은 allowlist 순서대로 후보를 내고 한도는 batchSize다", () => {
    const decision = decide()
    expect(decision).toMatchObject({ kind: "ready", capacity: 20 })
    expect(decision.kind === "ready" && decision.pendingPlaceIds.slice(0, 3)).toEqual([id(1), id(2), id(3)])
  })

  it("한 번에 배치 상한을 넘겨 승인하지 않는다", () => {
    const decision = decide()
    expect(decision.kind === "ready" && decision.capacity).toBeLessThanOrEqual(BATCH_MAX_ITEMS)
  })
})

describe("한 걸음 판정 — 직전 배치 결과로 멈춤", () => {
  it.each([
    ["failed", "approval-failed"],
    ["cancelled", "approval-cancelled"],
    ["expired", "approval-expired"],
  ])("직전 승인이 %s면 멈춘다", (status, reason) => {
    const latest = approval(1, status, "2026-11-10T01:00:00.000Z", [id(1)])
    expect(decide({ campaignApprovals: [latest] })).toEqual({ kind: "halted", reason, approvalId: latest.id })
  })

  // 배치(run)는 item 결과와 무관하게 completed로 닫힌다 — 승인 상태만 보면 전부 실패한 배치 뒤에도 계속 승인한다.
  it.each([
    ["배치 결과를 읽지 못함", null, "run-unknown"],
    ["item이 하나도 없음", run({ itemCount: 0 }), "run-unknown"],
    ["20건 전부 실패", run({ failedCount: 20 }), "items-failed"],
    ["1건만 실패", run({ failedCount: 1 }), "items-failed"],
    ["비용 상한으로 건너뜀", run({ skippedCount: 3 }), "items-skipped"],
    ["비용 미기록", run({ costUnknownCount: 1 }), "cost-unknown"],
    ["실비가 승인 상한 초과", run({ actualCostUsd: 0.05 }), "cost-over"],
    ["20건 전부 검수 대기", run({ needsReviewCount: 20 }), "needs-review-ratio"],
    ["검수 대기 3건(15%) > 10%", run({ needsReviewCount: 3 }), "needs-review-ratio"],
  ])("completed여도 %s이면 멈춘다", (_label, latestRun, reason) => {
    expect(decide({ campaignApprovals: [completedYesterday], latestRun })).toEqual({ kind: "halted", reason, approvalId: completedYesterday.id })
  })

  it("검수 대기 2건(10%)은 한도 이내라 진행한다", () => {
    expect(decide({ campaignApprovals: [completedYesterday], latestRun: run({ needsReviewCount: 2 }) }).kind).toBe("ready")
  })

  it("정상 완료된 배치 뒤에는 진행한다", () => {
    expect(decide({ campaignApprovals: [completedYesterday], latestRun: run() }).kind).toBe("ready")
  })

  it("파일럿(requireReviewEachBatch)은 정상 완료여도 확인 전까지 멈춘다", () => {
    const pilot = campaign({ requireReviewEachBatch: true })
    expect(decide({ campaign: pilot, campaignApprovals: [completedYesterday], latestRun: run() })).toEqual({
      kind: "halted",
      reason: "awaiting-review",
      approvalId: completedYesterday.id,
    })
  })

  it("그 승인 ID를 확인 목록에 올리면 다음으로 넘어가되, 그 장소는 다시 승인하지 않는다", () => {
    const failed = approval(1, "failed", "2026-11-10T01:00:00.000Z", [id(1)])
    const decision = decide({ campaign: campaign({ acknowledgedApprovalIds: [failed.id] }), campaignApprovals: [failed] })
    expect(decision.kind).toBe("ready")
    expect(decision.kind === "ready" && decision.pendingPlaceIds).not.toContain(id(1))
  })

  it("확인한 실패 뒤에 새로 실패하면 다시 멈춘다 — 확인은 그 승인 하나에만 듣는다", () => {
    const first = approval(1, "failed", "2026-11-10T01:00:00.000Z", [id(1)])
    const second = approval(2, "failed", "2026-11-10T02:00:00.000Z", [id(2)])
    expect(decide({ campaign: campaign({ acknowledgedApprovalIds: [first.id] }), campaignApprovals: [first, second] })).toEqual({
      kind: "halted",
      reason: "approval-failed",
      approvalId: second.id,
    })
  })

  it("정지 판정은 가장 최근 승인만 본다 — 예전 실패 뒤에 정상 완료가 있으면 진행한다", () => {
    const old = approval(1, "failed", "2026-11-09T01:00:00.000Z", [id(1)])
    const recent = approval(2, "completed", "2026-11-09T02:00:00.000Z", [id(2)])
    expect(decide({ campaignApprovals: [old, recent], latestRun: run() }).kind).toBe("ready")
  })
})

describe("한 걸음 판정 — 예산", () => {
  const twenty = Array.from({ length: 20 }, (_, index) => id(index + 1))

  it("하루 한도는 KST 오늘 승인한 장소 수로 센다 — 실패분도 환급하지 않는다", () => {
    const today = approval(1, "completed", "2026-11-10T01:00:00.000Z", twenty)
    expect(decide({ campaign: campaign({ dailyLimit: 20 }), campaignApprovals: [today], latestRun: run() })).toEqual({ kind: "daily-limit" })
    // 어제(KST) 승인분은 오늘 한도를 쓰지 않는다.
    const yesterday = approval(1, "completed", "2026-11-09T14:00:00.000Z", twenty)
    expect(decide({ campaign: campaign({ dailyLimit: 20 }), campaignApprovals: [yesterday], latestRun: run() }).kind).toBe("ready")
  })

  it("남은 하루 한도가 batchSize보다 작으면 그만큼만 승인한다", () => {
    const today = approval(1, "completed", "2026-11-10T01:00:00.000Z", twenty)
    expect(decide({ campaign: campaign({ dailyLimit: 25 }), campaignApprovals: [today], latestRun: run() })).toMatchObject({ kind: "ready", capacity: 5 })
  })

  it("전체 한도에 닿으면 멈춘다", () => {
    const earlier = approval(1, "completed", "2026-11-08T01:00:00.000Z", twenty)
    expect(decide({ campaign: campaign({ totalLimit: 20 }), campaignApprovals: [earlier], latestRun: run() })).toEqual({ kind: "total-limit" })
  })

  it("allowlist를 다 쓰면 완료다", () => {
    const all = approval(1, "completed", "2026-11-09T01:00:00.000Z", campaign().allowPlaceIds)
    expect(decide({ campaignApprovals: [all], latestRun: run({ itemCount: 50 }) })).toEqual({ kind: "exhausted" })
  })

  it("이미 승인에 들어갔던 장소는 결과와 무관하게 다시 내지 않는다", () => {
    const decision = decide({ campaignApprovals: [completedYesterday], latestRun: run() })
    expect(decision.kind === "ready" && decision.pendingPlaceIds[0]).toBe(id(3))
  })
})

describe("진행 중 캠페인 승인의 item 실행 허가", () => {
  const base = { mode: "on" as const, campaign: campaign(), approvedBy: "auto-generate:pilot-1", approvedPlaceIds: [id(1), id(2)], nowIso: NOW }

  it("같은 캠페인·유효 대상이면 실행한다", () => {
    expect(decideAutoApprovalRun(base)).toEqual({ kind: "run" })
  })

  it("스위치가 꺼져 있으면 멈춘다", () => {
    expect(decideAutoApprovalRun({ ...base, mode: "off" })).toEqual({ kind: "pause", reason: "switch-off" })
  })

  it("스위치가 cancel이면 취소한다", () => {
    expect(decideAutoApprovalRun({ ...base, mode: "cancel" })).toEqual({ kind: "cancel" })
  })

  // 스위치만 보면: 캠페인을 지우거나 교체하고 다시 켰을 때 옛 승인의 잔여가 그대로 생성된다.
  it("캠페인 설정이 없으면 스위치가 켜져 있어도 멈춘다", () => {
    expect(decideAutoApprovalRun({ ...base, campaign: null })).toEqual({ kind: "pause", reason: "no-campaign" })
  })

  it("다른 캠페인으로 교체됐으면 옛 승인은 멈춘다", () => {
    expect(decideAutoApprovalRun({ ...base, campaign: campaign({ id: "wave-2" }) })).toEqual({ kind: "pause", reason: "other-campaign" })
  })

  it("캠페인이 만료됐으면 진행 중 승인도 멈춘다", () => {
    expect(decideAutoApprovalRun({ ...base, campaign: campaign({ expiresAt: NOW }) })).toEqual({ kind: "pause", reason: "campaign-expired" })
  })

  it("승인된 장소가 allowlist에서 빠졌으면 멈춘다", () => {
    expect(decideAutoApprovalRun({ ...base, campaign: campaign({ allowPlaceIds: [id(1)] }) })).toEqual({ kind: "pause", reason: "place-not-allowed" })
  })
})

describe("고아 승인 복구 판정", () => {
  const old = new Date(Date.parse(NOW) - AUTO_GENERATE_STALE_APPROVAL_MS - 1000).toISOString()
  const fresh = new Date(Date.parse(NOW) - 30_000).toISOString()
  function active(overrides: Partial<ActiveApprovalSummary> = {}): ActiveApprovalSummary {
    return { id: approvalId(9), status: "approved", approvedBy: "auto-generate:pilot-1", approvedAt: old, activationConsumedAt: null, batchRunId: null, ...overrides }
  }

  it("토큰을 잃은 미활성 캠페인 승인은 닫는다", () => {
    expect(decideOrphanApproval([active()], NOW)).toEqual({ kind: "cancel-unactivated", approvalId: approvalId(9) })
    expect(decideOrphanApproval([active({ status: "queued" })], NOW)).toEqual({ kind: "cancel-unactivated", approvalId: approvalId(9) })
  })

  it("방금 만든 승인은 활성화 중일 수 있으므로 건드리지 않는다", () => {
    expect(decideOrphanApproval([active({ approvedAt: fresh })], NOW)).toEqual({ kind: "none" })
  })

  it("running인데 배치가 연결되지 않은 승인은 닫지 않고 조사 대상으로 알린다", () => {
    expect(decideOrphanApproval([active({ status: "running", activationConsumedAt: old })], NOW)).toEqual({ kind: "stuck-unlinked", approvalId: approvalId(9) })
  })

  it("배치가 연결된 승인은 정상 진행 중이다", () => {
    expect(decideOrphanApproval([active({ status: "running", activationConsumedAt: old, batchRunId: "run-1" })], NOW)).toEqual({ kind: "none" })
  })

  it("토큰이 소진된 approved/queued는 실행 흔적이 있으므로 닫지 않는다", () => {
    expect(decideOrphanApproval([active({ status: "queued", activationConsumedAt: old })], NOW)).toEqual({ kind: "none" })
  })

  it("관리자 승인은 오래돼도 건드리지 않는다", () => {
    expect(decideOrphanApproval([active({ approvedBy: "admin@example.com" })], NOW)).toEqual({ kind: "none" })
  })
})
