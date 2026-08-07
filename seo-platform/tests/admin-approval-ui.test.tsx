import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { ADMIN_NAV_ITEMS, isAdminNavItemActive } from "@/components/admin/admin-data"
import { ApprovalLaunchFormView, approvalFilterCounts, formatVerifiedAt, type ApprovalCandidateItem } from "@/components/admin/approval-launch-form"
import { approvalWarning, canCancelApproval, describeApprovalError, describeApprovalPump, describeApprovalStatus } from "@/lib/batch/approval-view"
import { approvalMaxCostUsd } from "@/lib/batch/cost-policy"
import { BATCH_MAX_ITEMS } from "@/lib/batch/types"

vi.mock("@/app/admin/batch/approve/actions", () => ({
  approveAndGenerateAction: () => undefined,
  cancelApprovalAction: () => undefined,
}))

function item(id: string, name: string, overrides: Partial<ApprovalCandidateItem> = {}): ApprovalCandidateItem {
  return {
    placeId: id,
    name,
    region: "부산 · 해운대구",
    address: "부산 해운대구 센텀로 1",
    phone: "051-000-0000",
    verifiedAt: "2026-07-20T05:00:00.000Z",
    verificationSourceUrls: ["https://example.test/a"],
    estimatedTokens: 1250,
    estimatedCostUsd: 0.001,
    eligible: true,
    reason: null,
    category: "funeral",
    contentMode: "condolence",
    hasGeneration: false,
    seoPageStatus: null,
    ...overrides,
  }
}

describe("승인 화면 후보 표", () => {
  it("renders every required column and the row number", () => {
    const markup = renderToStaticMarkup(
      createElement(ApprovalLaunchFormView, { candidates: [item("p1", "장소하나")], isPending: false, usdKrwRate: 1400 }),
    )
    for (const header of ["No.", "장소명", "지역", "주소", "전화", "공식 검증 출처", "검증일시", "예상 비용"]) {
      expect(markup).toContain(header)
    }
    expect(markup).toContain("장소하나")
    expect(markup).toContain("051-000-0000")
  })

  it("renders verified_at as KST, never a raw ISO timestamp", () => {
    // Given / When: 검증일시가 UTC ISO로 들어온다.
    expect(formatVerifiedAt("2026-07-23T05:08:20.699+00:00")).toBe("2026-07-23 14:08 KST")
    expect(formatVerifiedAt(null)).toBe("-")

    const markup = renderToStaticMarkup(
      createElement(ApprovalLaunchFormView, {
        candidates: [item("p1", "장소하나", { verifiedAt: "2026-07-23T05:08:20.699+00:00" })],
        isPending: false,
        usdKrwRate: 1400,
      }),
    )
    // Then: 화면에는 KST 표기만 남고 ISO 원문은 노출되지 않는다.
    expect(markup).toContain("2026-07-23 14:08 KST")
    expect(markup).not.toContain("2026-07-23T05:08")
  })

  it("marks ineligible candidates with a reason and disables their checkbox", () => {
    const markup = renderToStaticMarkup(
      createElement(ApprovalLaunchFormView, {
        candidates: [item("p2", "생성이력있음", { eligible: false, reason: "has-generation" })],
        isPending: false,
        usdKrwRate: 1400,
      }),
    )
    expect(markup).toContain("불가")
    expect(markup).toContain("기존 AI 생성 이력이 있음")
    expect(markup).toContain("disabled")
  })

  it("shows the Korean empty state when there is no candidate", () => {
    const markup = renderToStaticMarkup(createElement(ApprovalLaunchFormView, { candidates: [], isPending: false, usdKrwRate: 1400 }))
    expect(markup).toContain("현재 자동 생성 가능한 장소가 없습니다")
    expect(markup).toContain("선택할 수 있는 장소가 없습니다")
    // 부적격 목록 자체가 없으므로 섹션도 렌더링하지 않는다.
    expect(markup).not.toContain("생성할 수 없는 업체")
  })

  it("disables the approve button with nothing selected and shows a zero cost cap", () => {
    const markup = renderToStaticMarkup(createElement(ApprovalLaunchFormView, { candidates: [item("p1", "장소하나")], isPending: false, usdKrwRate: 1400 }))
    expect(markup).toContain("AI 생성 시작 (0곳)")
    expect(markup).toContain("disabled")
    // 아무것도 선택하지 않았는데 상한 금액이 표시되면 오해를 준다.
    expect(approvalMaxCostUsd(0)).toBe(0)
    expect(markup).toContain("$0.0000")
  })
})

describe("확인 모달", () => {
  it("states cost, cap, selected names, and the four safety notes", () => {
    const markup = renderToStaticMarkup(
      createElement(ApprovalLaunchFormView, {
        candidates: [item("p1", "장소하나"), item("p2", "장소둘")],
        isPending: false,
        usdKrwRate: 1400,
        initialSelected: ["p1", "p2"],
        initialConfirmOpen: true,
      }),
    )
    expect(markup).toContain("AI 생성 시작 확인")
    expect(markup).toContain("2곳")
    expect(markup).toContain("장소하나")
    expect(markup).toContain("장소둘")
    expect(markup).toContain(`$${approvalMaxCostUsd(2).toFixed(4)}`)
    expect(markup).toContain("AI 생성은 Preview 환경에서만 실행됩니다")
    expect(markup).toContain("자동 게시가 켜져 있으면 문제 없는 결과는 게시까지 자동 진행됩니다")
    expect(markup).toContain("자동 게시가 꺼져 있으면 3단계 · 게시에서 직접 게시합니다")
    expect(markup).toContain("브라우저를 닫아도 서버에서 계속 진행됩니다")
  })

  // PR-D — 서버 액션 redirect는 소프트 내비게이션이라 모달 상태가 살아남는다.
  // 부모가 confirmOpen을 소유하면 요청이 끝난 뒤 닫을 수 있어야 한다.
  it("lets the parent close the modal once the request settles", () => {
    const open = renderToStaticMarkup(
      createElement(ApprovalLaunchFormView, {
        candidates: [item("p1", "장소하나")],
        isPending: false,
        usdKrwRate: 1400,
        initialSelected: ["p1"],
        confirmOpen: true,
      }),
    )
    expect(open).toContain("AI 생성 시작 확인")

    // 요청이 끝나 부모가 false로 내리면 모달은 사라진다 (성공·확정 실패·불확실 모두 동일).
    const closed = renderToStaticMarkup(
      createElement(ApprovalLaunchFormView, {
        candidates: [item("p1", "장소하나")],
        isPending: false,
        usdKrwRate: 1400,
        initialSelected: ["p1"],
        confirmOpen: false,
      }),
    )
    expect(closed).not.toContain("AI 생성 시작 확인")
  })

  it("spins and blocks re-submit while pending", () => {
    const markup = renderToStaticMarkup(
      createElement(ApprovalLaunchFormView, {
        candidates: [item("p1", "장소하나")],
        isPending: true,
        usdKrwRate: 1400,
        initialSelected: ["p1"],
        initialConfirmOpen: true,
      }),
    )
    expect(markup).toContain("animate-spin")
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain("요청 중...")
    expect(markup).toContain("창을 닫지 말고")
  })
})

describe("적격·부적격 목록 분리", () => {
  it("splits eligible candidates from blocked ones so blocked places never look selectable", () => {
    const markup = renderToStaticMarkup(
      createElement(ApprovalLaunchFormView, {
        candidates: [item("ok", "적격장소"), item("no", "대구병원 장례식장", { eligible: false, reason: "has-generation" })],
        isPending: false,
        usdKrwRate: 1400,
      }),
    )
    expect(markup).toContain("AI 생성 가능한 업체")
    expect(markup).toContain("생성할 수 없는 업체 (자동 제외)")
    expect(markup).toContain("자동 생성 불가 — 기존 AI 생성 이력이 있음")
    expect(markup).toContain("자동으로 제외되었습니다")
    // 부적격 장소에는 체크박스가 없다 — 적격 1건에 대한 체크박스만 존재한다.
    expect(markup.match(/type="checkbox"/g)?.length).toBe(2) // 적격 1건 + 승인 확인 체크박스
    expect(markup).toContain("대구병원 장례식장")
  })

  it("shows the zero-eligible notice when every candidate is blocked", () => {
    const markup = renderToStaticMarkup(
      createElement(ApprovalLaunchFormView, {
        candidates: [item("no", "대구병원 장례식장", { eligible: false, reason: "has-generation" })],
        isPending: false,
        usdKrwRate: 1400,
      }),
    )
    expect(markup).toContain("현재 자동 생성 가능한 장소가 없습니다")
    expect(markup).toContain("공식 검증이 완료됐고 기존 AI 생성 이력과 SEO 페이지가 없는 장소만 선택할 수 있습니다")
    // 후보 0곳이므로 승인 버튼은 계속 비활성이고 상한도 0이다.
    expect(markup).toContain("AI 생성 시작 (0곳)")
    expect(markup).toContain("$0.0000")
  })

  it("keeps the zero-eligible notice hidden when a selectable candidate exists", () => {
    const markup = renderToStaticMarkup(
      createElement(ApprovalLaunchFormView, { candidates: [item("ok", "적격장소")], isPending: false, usdKrwRate: 1400 }),
    )
    expect(markup).not.toContain("현재 자동 생성 가능한 장소가 없습니다")
  })
})

describe("관리자 메뉴 active 판정", () => {
  const navItem = (href: string) => {
    const found = ADMIN_NAV_ITEMS.find((entry) => entry.href === href)
    if (found === undefined) throw new Error(`nav item not registered: ${href}`)
    return found
  }
  const approve = navItem("/admin/batch/approve")
  const history = navItem("/admin/batch")
  const places = navItem("/admin/places")
  const publish = navItem("/admin/batch/publish/new")

  it("registers the step menus separately", () => {
    expect(approve.label).toBe("2단계 · AI 생성")
    expect(publish.label).toBe("3단계 · 게시")
    expect(history.label).toBe("진행 이력")
  })

  it("activates only the AI-generation step menu on the approval route", () => {
    expect(isAdminNavItemActive(approve, "/admin/batch/approve")).toBe(true)
    expect(isAdminNavItemActive(history, "/admin/batch/approve")).toBe(false)
  })

  it("activates only the history menu on the history and detail routes", () => {
    for (const path of ["/admin/batch", "/admin/batch/new", "/admin/batch/8f2c1b90-0000-0000-0000-000000000000"]) {
      expect(isAdminNavItemActive(history, path)).toBe(true)
      expect(isAdminNavItemActive(approve, path)).toBe(false)
    }
    // 게시 화면은 3단계 메뉴가 가져간다 — 진행 이력은 켜지지 않는다.
    expect(isAdminNavItemActive(publish, "/admin/batch/publish/new")).toBe(true)
    expect(isAdminNavItemActive(history, "/admin/batch/publish/new")).toBe(false)
  })

  it("keeps unrelated menus unaffected", () => {
    expect(isAdminNavItemActive(places, "/admin/places")).toBe(true)
    expect(isAdminNavItemActive(places, "/admin/batch")).toBe(false)
    expect(isAdminNavItemActive(history, "")).toBe(false)
  })
})

describe("승인 이력 정책", () => {
  it("warns when a running approval never linked a batch run", () => {
    expect(approvalWarning({ status: "running", batchRunId: null, lastErrorCode: null })).toEqual({
      kind: "start-interrupted",
      message: "실행 시작 중단 — 취소 후 새 승인이 필요합니다",
    })
  })

  it("자동 생성이 지연됐을 때만 경고하고, 정상 대기에는 침묵한다", () => {
    // 1분 주기의 정상 대기는 경고가 아니다 — 예전에는 발사 실패 표식만으로 재개를 유도했다.
    expect(approvalWarning({ status: "running", batchRunId: "batch-1", lastErrorCode: "chain-dispatch-failed", pumpDelayed: false })).toBeNull()

    const warning = approvalWarning({ status: "running", batchRunId: "batch-1", lastErrorCode: null, pumpDelayed: true })
    expect(warning?.kind).toBe("stalled")
    expect(warning?.message).toContain("지연")
    expect(warning?.message).toContain("처리된 분량은 유지")
  })

  it("자동 생성 상태를 처리 중·대기·지연으로 구분한다", () => {
    const now = "2026-07-31T00:02:30.000Z"

    const busy = describeApprovalPump({ status: "running", leaseExpiresAt: "2026-07-31T00:04:00.000Z", lastTickAt: "2026-07-31T00:02:00.000Z", pumpAttempt: 3, nowIso: now })
    expect(busy.busy).toBe(true)
    expect(busy.stateLabel).toBe("AI 생성 처리 중")
    expect(busy.attemptLabel).toBe("3회")

    const waiting = describeApprovalPump({ status: "running", leaseExpiresAt: null, lastTickAt: "2026-07-31T00:02:00.000Z", pumpAttempt: 3, nowIso: now })
    expect(waiting.busy).toBe(false)
    expect(waiting.delayed).toBe(false)
    expect(waiting.stateLabel).toContain("다음 자동 생성 대기")

    // 마지막 진행 이후 lease(120초) + 주기(60초)를 넘긴 경우만 지연이다.
    const delayed = describeApprovalPump({ status: "running", leaseExpiresAt: null, lastTickAt: "2026-07-31T00:02:00.000Z", pumpAttempt: 3, nowIso: "2026-07-31T00:06:00.000Z" })
    expect(delayed.delayed).toBe(true)
    expect(delayed.stateLabel).toBe("자동 생성 지연")

    expect(describeApprovalPump({ status: "completed", leaseExpiresAt: null, lastTickAt: null, pumpAttempt: 5, nowIso: now }).stateLabel).toBe("자동 생성 없음")
  })

  it("warns on expired and failed, stays silent while healthy", () => {
    expect(approvalWarning({ status: "expired", batchRunId: null, lastErrorCode: null })?.kind).toBe("expired")
    expect(approvalWarning({ status: "failed", batchRunId: "b", lastErrorCode: "start-failed" })?.kind).toBe("failed")
    expect(approvalWarning({ status: "running", batchRunId: "batch-1", lastErrorCode: null })).toBeNull()
    expect(approvalWarning({ status: "completed", batchRunId: "batch-1", lastErrorCode: null })).toBeNull()
  })

  it("allows cancel only before terminal states", () => {
    expect(canCancelApproval("approved")).toBe(true)
    expect(canCancelApproval("queued")).toBe(true)
    expect(canCancelApproval("running")).toBe(true)
    expect(canCancelApproval("completed")).toBe(false)
    expect(canCancelApproval("failed")).toBe(false)
    expect(canCancelApproval("expired")).toBe(false)
    expect(canCancelApproval("cancelled")).toBe(false)
  })

  it("사용자 문구에 self-chain·발사 같은 내부 구조 용어를 쓰지 않는다", () => {
    const messages = [
      approvalWarning({ status: "running", batchRunId: null, lastErrorCode: null })?.message ?? "",
      approvalWarning({ status: "running", batchRunId: "b", lastErrorCode: null, pumpDelayed: true })?.message ?? "",
      describeApprovalError("chain-dispatch-failed") ?? "",
      describeApprovalPump({ status: "running", leaseExpiresAt: null, lastTickAt: null, pumpAttempt: 0, nowIso: "2026-07-31T00:00:00.000Z" }).stateLabel,
    ]
    for (const message of messages) {
      expect(message).not.toMatch(/self-chain|발사|dispatch|tick|chain/i)
    }
  })

  it("labels statuses and hides raw internal error codes", () => {
    expect(describeApprovalStatus("running").label).toBe("자동 생성 중")
    expect(describeApprovalStatus("completed").tone).toBe("accent")
    expect(describeApprovalError("chain-dispatch-failed")).toBe("이전 자동 진행 구조에서 중단")
    expect(describeApprovalError("kick-failed:unauthorized")).toBe("실행 서버 호출 실패")
    expect(describeApprovalError("some-unknown-internal-code")).toBe("실행 오류")
    expect(describeApprovalError(null)).toBeNull()
  })
})

describe("승인 화면 빠른 선택 (카테고리 + 지정 수량)", () => {
  it("selects the top N eligible candidates of the chosen mode filter, replacing the selection", async () => {
    const { quickSelectApprovalCandidates } = await import("@/components/admin/approval-launch-form")
    const candidates = [
      item("f1", "장례1"),
      item("f2", "장례2"),
      item("f3", "장례3", { eligible: false, reason: "has-generation" }),
      item("h1", "호텔1", { category: "호텔", contentMode: "celebration" }),
      item("f4", "장례4"),
      item("f5", "장례5"),
      item("f6", "장례6"),
      item("f7", "장례7"),
    ]

    // 카테고리(모드) 지정 + 수량 지정: condolence 상위 3곳 — 부적격은 건너뛴다.
    expect(quickSelectApprovalCandidates(candidates, "condolence", 3)).toEqual(["f1", "f2", "f4"])
    // 수량이 상한을 넘으면 상한으로 자른다 (fixture의 적격 condolence 후보 수보다 상한이 크면 전부).
    const eligibleCondolence = candidates.filter((entry) => entry.eligible && entry.contentMode === "condolence").map((entry) => entry.placeId)
    expect(quickSelectApprovalCandidates(candidates, "condolence", 99)).toEqual(eligibleCondolence.slice(0, BATCH_MAX_ITEMS))
    // 다른 모드는 그 모드의 적격 후보만.
    expect(quickSelectApprovalCandidates(candidates, "celebration", 5)).toEqual(["h1"])
    expect(quickSelectApprovalCandidates(candidates, "all", 0)).toEqual([])
  })

  it("renders the quick-select controls (count input, auto-select and clear buttons)", () => {
    const markup = renderToStaticMarkup(
      createElement(ApprovalLaunchFormView, { candidates: [item("p1", "장소하나")], isPending: false, usdKrwRate: 1400 }),
    )
    expect(markup).toContain("선택 수량")
    expect(markup).toContain("자동 선택")
    expect(markup).toContain("선택 해제")
    expect(markup).toContain("approval-quick-count")
  })
})

describe("필터 칩 개수", () => {
  it("prefers server-side mode totals over the loaded subset", () => {
    const loaded = [item("f1", "장례1"), item("h1", "호텔1", { category: "호텔", contentMode: "celebration" })]

    // 조회 상한 때문에 화면에는 2곳만 실렸지만 실제 후보는 361곳 — 칩은 진짜 수를 보여준다.
    const withTotals = approvalFilterCounts(loaded, { condolence: 28, celebration: 234, "corporate-celebration": 99 })
    expect(withTotals.condolence).toBe(28)
    expect(withTotals.celebration).toBe(234)
    expect(withTotals["corporate-celebration"]).toBe(99)
    expect(withTotals.all).toBe(361)

    // 총계를 못 받으면 로드된 후보로 센다 (조회 실패 시에도 화면이 비지 않게).
    const withoutTotals = approvalFilterCounts(loaded)
    expect(withoutTotals.all).toBe(2)
    expect(withoutTotals.condolence).toBe(1)
  })

  it("renders the count next to each filter chip", () => {
    const markup = renderToStaticMarkup(
      createElement(ApprovalLaunchFormView, {
        candidates: [item("p1", "장소하나")],
        isPending: false,
        usdKrwRate: 1400,
        modeTotals: { condolence: 28, celebration: 234, "corporate-celebration": 99 },
      }),
    )
    expect(markup).toContain("28")
    expect(markup).toContain("234")
    expect(markup).toContain("361")
  })
})
