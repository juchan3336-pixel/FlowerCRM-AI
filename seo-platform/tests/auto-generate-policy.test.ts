// 자동 생성 캠페인 판정 계약 — 스위치·설정 해석·예산·정지·재승인 금지.
// 이 기능은 사람 클릭 없이 승인을 만들므로, "애매하면 아무것도 하지 않는다"가 모든 분기의 기본값이어야 한다.
import { describe, expect, it } from "vitest"

import {
  AUTO_GENERATE_MAX_DAILY_LIMIT,
  autoGenerateApprover,
  decideAutoGenerateStep,
  isAutoGenerateApprover,
  kstDayStartIso,
  parseAutoGenerateCampaign,
  parseAutoGenerateSetting,
  type AutoGenerateCampaign,
  type CampaignApprovalSummary,
} from "@/lib/batch/auto-generate-policy"
import { BATCH_MAX_ITEMS } from "@/lib/batch/types"

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const NOW = "2026-11-10T06:00:00.000Z" // 15:00 KST

function campaign(overrides: Partial<AutoGenerateCampaign> = {}): AutoGenerateCampaign {
  return {
    id: "pilot-1",
    expiresAt: "2026-12-10T00:00:00.000Z",
    batchSize: 20,
    dailyLimit: 100,
    totalLimit: 969,
    allowPlaceIds: Array.from({ length: 50 }, (_, index) => id(index + 1)),
    resumeAfter: null,
    ...overrides,
  }
}

function approval(status: string, approvedAt: string, placeIds: readonly string[]): CampaignApprovalSummary {
  return { status, approvedAt, placeIds }
}

function decide(overrides: Partial<Parameters<typeof decideAutoGenerateStep>[0]> = {}) {
  return decideAutoGenerateStep({ enabled: true, campaign: campaign(), nowIso: NOW, activeApprovalCount: 0, campaignApprovals: [], ...overrides })
}

describe("스위치 해석", () => {
  it('"on"만 켜짐이다', () => {
    expect(parseAutoGenerateSetting("on")).toBe(true)
    expect(parseAutoGenerateSetting(" ON ")).toBe(true)
    for (const value of ["off", "", "true", true, 1, null, undefined, { on: true }]) {
      expect(parseAutoGenerateSetting(value)).toBe(false)
    }
  })
})

describe("캠페인 설정 해석", () => {
  const valid = { id: "pilot-1", expiresAt: "2026-12-10T00:00:00.000Z", batchSize: 20, dailyLimit: 20, totalLimit: 20, allowPlaceIds: [id(1), id(2)] }

  it("올바른 설정을 그대로 읽는다", () => {
    expect(parseAutoGenerateCampaign(valid)).toEqual({ ...valid, resumeAfter: null })
    expect(parseAutoGenerateCampaign({ ...valid, resumeAfter: "2026-11-11T00:00:00.000Z" })?.resumeAfter).toBe("2026-11-11T00:00:00.000Z")
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
    ["allowPlaceIds 누락", { ...valid, allowPlaceIds: undefined }],
    ["allowPlaceIds에 UUID 아닌 값", { ...valid, allowPlaceIds: [id(1), "all"] }],
    ["allowPlaceIds 중복", { ...valid, allowPlaceIds: [id(1), id(1)] }],
    ["resumeAfter 해석 불가", { ...valid, resumeAfter: "yesterday" }],
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

describe("한 걸음 판정", () => {
  it("스위치가 꺼져 있으면 아무것도 하지 않는다", () => {
    expect(decide({ enabled: false })).toEqual({ kind: "disabled" })
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

  it("이미 승인에 들어갔던 장소는 결과와 무관하게 다시 내지 않는다", () => {
    const decision = decide({ campaignApprovals: [approval("completed", "2026-11-10T01:00:00.000Z", [id(1), id(2)])] })
    expect(decision.kind === "ready" && decision.pendingPlaceIds[0]).toBe(id(3))
    expect(decision.kind === "ready" && decision.pendingPlaceIds).not.toContain(id(1))
  })

  it.each(["failed", "cancelled", "expired"])("직전 승인이 %s면 멈춘다", (status) => {
    expect(decide({ campaignApprovals: [approval(status, "2026-11-10T01:00:00.000Z", [id(1)])] })).toEqual({ kind: "halted", status })
  })

  it("실패 뒤에 정상 완료된 승인이 있으면 멈추지 않는다", () => {
    const decision = decide({
      campaignApprovals: [approval("failed", "2026-11-10T01:00:00.000Z", [id(1)]), approval("completed", "2026-11-10T02:00:00.000Z", [id(2)])],
    })
    expect(decision.kind).toBe("ready")
  })

  it("resumeAfter 이전의 실패는 정지 사유가 아니지만, 그 장소는 여전히 다시 승인하지 않는다", () => {
    const decision = decide({
      campaign: campaign({ resumeAfter: "2026-11-10T03:00:00.000Z" }),
      campaignApprovals: [approval("failed", "2026-11-10T01:00:00.000Z", [id(1)])],
    })
    expect(decision.kind).toBe("ready")
    expect(decision.kind === "ready" && decision.pendingPlaceIds).not.toContain(id(1))
  })

  it("resumeAfter 이후에 다시 실패하면 다시 멈춘다", () => {
    const decision = decide({
      campaign: campaign({ resumeAfter: "2026-11-10T03:00:00.000Z" }),
      campaignApprovals: [approval("failed", "2026-11-10T04:00:00.000Z", [id(1)])],
    })
    expect(decision).toEqual({ kind: "halted", status: "failed" })
  })

  it("하루 한도는 KST 오늘 승인한 장소 수로 센다 — 실패분도 환급하지 않는다", () => {
    const today = Array.from({ length: 20 }, (_, index) => id(index + 1))
    expect(decide({ campaign: campaign({ dailyLimit: 20 }), campaignApprovals: [approval("completed", "2026-11-10T01:00:00.000Z", today)] })).toEqual({ kind: "daily-limit" })
    // 어제(KST) 승인분은 오늘 한도를 쓰지 않는다.
    expect(decide({ campaign: campaign({ dailyLimit: 20 }), campaignApprovals: [approval("completed", "2026-11-09T14:00:00.000Z", today)] }).kind).toBe("ready")
  })

  it("남은 하루 한도가 batchSize보다 작으면 그만큼만 승인한다", () => {
    const decision = decide({
      campaign: campaign({ dailyLimit: 25 }),
      campaignApprovals: [approval("completed", "2026-11-10T01:00:00.000Z", Array.from({ length: 20 }, (_, index) => id(index + 1)))],
    })
    expect(decision).toMatchObject({ kind: "ready", capacity: 5 })
  })

  it("전체 한도에 닿으면 멈춘다", () => {
    const decision = decide({
      campaign: campaign({ totalLimit: 20 }),
      campaignApprovals: [approval("completed", "2026-11-08T01:00:00.000Z", Array.from({ length: 20 }, (_, index) => id(index + 1)))],
    })
    expect(decision).toEqual({ kind: "total-limit" })
  })

  it("allowlist를 다 쓰면 완료다", () => {
    const all = campaign().allowPlaceIds
    expect(decide({ campaignApprovals: [approval("completed", "2026-11-09T01:00:00.000Z", all)] })).toEqual({ kind: "exhausted" })
  })

  it("한 번에 배치 상한을 넘겨 승인하지 않는다", () => {
    const decision = decide()
    expect(decision.kind === "ready" && decision.capacity).toBeLessThanOrEqual(BATCH_MAX_ITEMS)
  })
})
