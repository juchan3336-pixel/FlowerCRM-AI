import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { BatchLaunchFormView, type BatchLaunchCandidate } from "@/components/admin/batch-launch-form"
import { formatBatchItemReason, formatQualityIssueCode, QUALITY_ISSUE_LABELS } from "@/lib/batch/reason-labels"

describe("Batch 사유 한글 라벨", () => {
  it("maps every required issue code to the approved Korean label", () => {
    expect(formatQualityIssueCode("banned:delivery-guarantee")).toBe("배송 가능 여부를 확정적으로 표현함")
    expect(formatQualityIssueCode("repeat:title")).toBe("기존 페이지와 제목 구조가 유사함")
    expect(formatQualityIssueCode("repeat:faq")).toBe("기존 페이지와 FAQ 질문이 중복됨")
    expect(formatQualityIssueCode("repeat:keywords")).toBe("기존 페이지와 키워드 구성이 유사함")
    expect(formatQualityIssueCode("invalid:internal-link")).toBe("존재하지 않는 내부 링크가 포함됨")
    expect(formatQualityIssueCode("banned:affiliation")).toBe("공식 제휴·지정 업체로 오인될 표현이 포함됨")
    expect(formatQualityIssueCode("address:mismatch")).toBe("공식 주소와 생성 콘텐츠의 주소가 일치하지 않음")
  })

  it("formats the 삼천포서울 case — composite quality-fail code without exposing the raw code", () => {
    const label = formatBatchItemReason("quality-fail:banned:delivery-guarantee")
    expect(label).toBe("배송 가능 여부를 확정적으로 표현함 — 품질 검사를 통과하지 못했습니다.")
    expect(label).not.toContain("quality-fail")
    expect(label).not.toContain("banned:")
  })

  it("formats multi-code quality-fail reasons with deduplicated labels", () => {
    const label = formatBatchItemReason("quality-fail:repeat:faq,banned:affiliation")
    expect(label).toContain("기존 페이지와 FAQ 질문이 중복됨")
    expect(label).toContain("공식 제휴·지정 업체로 오인될 표현이 포함됨")
    expect(label).toContain("품질 검사를 통과하지 못했습니다")
  })

  it("maps batch flow reasons (cost limit, interruption, cancellation)", () => {
    expect(formatBatchItemReason("skipped_cost_limit")).toBe("설정한 비용 한도에 도달하여 처리하지 않음")
    expect(formatBatchItemReason("interrupted")).toBe("작업이 중단되어 이어서 진행이 필요함")
    expect(formatBatchItemReason("cancelled-by-user")).toBe("사용자가 중단하여 남은 항목을 건너뜀")
    expect(formatBatchItemReason("content-changed")).toContain("승인 이후 콘텐츠가 변경")
  })

  it("falls back to a safe generic label for unknown codes and never echoes the raw code", () => {
    const label = formatBatchItemReason("some-internal-new-code-xyz")
    expect(label).toBe("처리 중 문제가 발생했습니다. 상세 원인은 감사 로그(사유 코드)에서 확인하세요.")
    expect(label).not.toContain("some-internal-new-code-xyz")
    const issueLabel = formatQualityIssueCode("brand-new:issue")
    expect(issueLabel).not.toContain("brand-new")
  })

  it("keeps the source map immutable and returns null for empty reasons — DB 원본은 표시 계층에서 건드리지 않는다", () => {
    const original = "quality-fail:banned:delivery-guarantee"
    formatBatchItemReason(original)
    expect(original).toBe("quality-fail:banned:delivery-guarantee")
    expect(Object.isFrozen(QUALITY_ISSUE_LABELS) || typeof QUALITY_ISSUE_LABELS === "object").toBe(true)
    expect(formatBatchItemReason(null)).toBeNull()
    expect(formatBatchItemReason("  ")).toBeNull()
  })
})

const CANDIDATES: readonly BatchLaunchCandidate[] = [
  { placeId: "p1", name: "진주중앙병원 장례식장", region: "경남 진주시", address: "경남 진주시 촉석로 178", eligible: true, reason: null },
  { placeId: "p2", name: "대구기독병원 장례식장", region: "대구 달서구", address: "대구 달서구 달구벌대로 1750", eligible: true, reason: null },
]

describe("일괄 생성 최종 확인 모달 pending UX", () => {
  it("opens as a dialog with the summary and an active 일괄 생성 시작 button", () => {
    const markup = renderToStaticMarkup(
      <BatchLaunchFormView candidates={CANDIDATES} initialConfirmOpen initialSelected={["p1", "p2"]} isPending={false} productionBlocked={false} usdKrwRate={1400} />,
    )
    expect(markup).toContain("일괄 생성 최종 확인")
    expect(markup).toContain('role="dialog"')
    expect(markup).toContain("일괄 생성 시작")
    expect(markup).toContain("취소")
    expect(markup).not.toContain("배치 생성 준비 중...")
  })

  it("shows 배치 생성 준비 중... with spinner and blocks both buttons while pending", () => {
    const markup = renderToStaticMarkup(
      <BatchLaunchFormView candidates={CANDIDATES} initialConfirmOpen initialSelected={["p1", "p2"]} isPending productionBlocked={false} usdKrwRate={1400} />,
    )
    // Then: 확인 버튼 pending 문구 + spinner + aria-busy, 취소·시작 모두 disabled (중복 클릭·모달 닫기 차단).
    expect(markup).toContain("배치 생성 준비 중...")
    expect(markup).toContain("animate-spin")
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain("창을 닫지 말고 잠시만 기다려 주세요")
    expect((markup.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it("keeps the PR #28 initial-form pending markers intact (no regression)", () => {
    const markup = renderToStaticMarkup(
      <BatchLaunchFormView candidates={CANDIDATES} initialSelected={["p1"]} isPending productionBlocked={false} usdKrwRate={1400} />,
    )
    expect(markup).toContain("배치 준비 중...")
    expect(markup).toContain('aria-busy="true"')
  })
})
