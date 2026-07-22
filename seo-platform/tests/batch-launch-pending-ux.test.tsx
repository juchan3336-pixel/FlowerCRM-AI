import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import {
  BATCH_SUBMIT_FAILED_MESSAGE,
  BatchFailureToast,
  BatchLaunchFormView,
  createSubmitGate,
  type BatchLaunchCandidate,
} from "@/components/admin/batch-launch-form"
import { BatchProgressControlsView } from "@/components/admin/batch-progress"
import { formatBatchKstTime, latestBatchUpdatedAt } from "@/lib/batch/batch-view"

const FIRST_CANDIDATE: BatchLaunchCandidate = {
  placeId: "11111111-1111-4111-8111-111111111111",
  name: "곽병원 장례식장",
  region: "대구",
  address: "대구 중구 국채보상로 531",
  eligible: true,
  reason: null,
}

const CANDIDATES: readonly BatchLaunchCandidate[] = [
  FIRST_CANDIDATE,
  { placeId: "22222222-2222-4222-8222-222222222222", name: "제일병원 장례식장", region: "경남", address: "경남 진주시 진주대로 885", eligible: true, reason: null },
]

describe("batch launch form pending UX", () => {
  it("renders the idle submit button with the selected count and no pending markers", () => {
    // Given: 1건 선택된 유휴 상태.
    const markup = renderToStaticMarkup(
      <BatchLaunchFormView candidates={CANDIDATES} initialSelected={[FIRST_CANDIDATE.placeId]} isPending={false} productionBlocked={false} usdKrwRate={1400} />,
    )

    // Then: 시작 버튼 활성 + pending 문구·spinner 없음.
    expect(markup).toContain("AI 일괄 생성 시작 (1건)")
    expect(markup).not.toContain("배치 준비 중...")
    expect(markup).not.toContain("animate-spin")
    expect(markup).not.toContain('aria-busy="true"')
  })

  it("disables the submit button with 배치 준비 중... and a spinner while pending", () => {
    // Given: 클릭 직후 pending 상태.
    const markup = renderToStaticMarkup(
      <BatchLaunchFormView candidates={CANDIDATES} initialSelected={[FIRST_CANDIDATE.placeId]} isPending productionBlocked={false} usdKrwRate={1400} />,
    )

    // Then: '배치 준비 중...' + disabled(중복 클릭 차단) + spinner + aria-busy + 로딩 안내.
    expect(markup).toContain("배치 준비 중...")
    expect(markup).not.toContain("AI 일괄 생성 시작")
    expect(markup).toContain("animate-spin")
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain("배치를 생성하고 있습니다")
    expect(markup).toContain('disabled=""')
  })

  it("disables every checkbox while pending so the submitted selection cannot drift", () => {
    // Given: pending 상태 (선택 2건 + 공식 확인 체크박스).
    const markup = renderToStaticMarkup(
      <BatchLaunchFormView candidates={CANDIDATES} initialSelected={CANDIDATES.map((candidate) => candidate.placeId)} isPending productionBlocked={false} usdKrwRate={1400} />,
    )

    // Then: 후보 2건 + 공식 확인 + 시작 버튼까지 모두 disabled.
    expect((markup.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(4)
  })

  it("blocks re-entry through the submit gate until the in-flight request releases", () => {
    // Given: 전송 게이트.
    const gate = createSubmitGate()

    // When / Then: 첫 획득만 성공하고 해제 전 재획득은 모두 거부된다 (중복 batch 생성 금지).
    expect(gate.tryAcquire()).toBe(true)
    expect(gate.tryAcquire()).toBe(false)
    expect(gate.tryAcquire()).toBe(false)
    gate.release()
    expect(gate.tryAcquire()).toBe(true)
  })

  it("renders the failure toast with the transport error message", () => {
    const markup = renderToStaticMarkup(<BatchFailureToast message={BATCH_SUBMIT_FAILED_MESSAGE} />)
    expect(markup).toContain("배치 시작 실패")
    expect(markup).toContain("배치 시작 요청을 보내지 못했습니다")
    expect(markup).toContain('role="alert"')
  })
})

describe("batch progress running UX", () => {
  it("shows the sequential spinner while the client loop is running", () => {
    const markup = renderToStaticMarkup(<BatchProgressControlsView batchId="batch-1" hasClaimable looping stopRequested={false} />)
    expect(markup).toContain("순차 처리 중…")
    expect(markup).toContain("animate-spin")
    expect(markup).not.toContain("이어서 진행")
  })

  it("shows an animated waiting notice with 이어서 진행 when paused — never a static done-looking state", () => {
    // Given: 새로고침 직후 (loop 미가동, 남은 건 있음).
    const markup = renderToStaticMarkup(<BatchProgressControlsView batchId="batch-1" hasClaimable looping={false} stopRequested={false} />)

    // Then: 대기 중 명시 + 애니메이션 + 이어서 진행 버튼.
    expect(markup).toContain("진행 대기 중 — 아직 완료되지 않았습니다")
    expect(markup).toContain("animate-pulse")
    expect(markup).toContain("이어서 진행")
    expect(markup).toContain('aria-live="polite"')
  })

  it("disables 중단 after a stop was requested", () => {
    const markup = renderToStaticMarkup(<BatchProgressControlsView batchId="batch-1" hasClaimable={false} looping stopRequested />)
    expect(markup).toContain('disabled=""')
    expect(markup).toContain("중단 (남은 건 건너뜀)")
  })
})

describe("batch last-updated display helpers", () => {
  it("picks the most recent updated_at across the run and its items", () => {
    const latest = latestBatchUpdatedAt("2026-07-22T06:32:06.000Z", [
      { updated_at: "2026-07-22T06:32:22.500Z" },
      { updated_at: "2026-07-22T06:32:37.715Z" },
    ])
    expect(latest).toBe("2026-07-22T06:32:37.715Z")
  })

  it("falls back to the run timestamp when items carry none", () => {
    expect(latestBatchUpdatedAt("2026-07-22T06:32:06.000Z", [])).toBe("2026-07-22T06:32:06.000Z")
    expect(latestBatchUpdatedAt(null, [])).toBeNull()
  })

  it("formats timestamps as KST MM-DD HH:mm:ss and rejects invalid input", () => {
    // 06:32 UTC = 15:32 KST.
    expect(formatBatchKstTime("2026-07-22T06:32:37.000Z")).toBe("07-22 15:32:37")
    expect(formatBatchKstTime("not-a-date")).toBeNull()
    expect(formatBatchKstTime(null)).toBeNull()
  })
})
