import { describe, expect, it } from "vitest"

import { summarizeRunForHistory } from "@/lib/batch/batch-view"
import { decideBatchItemOutcome } from "@/lib/batch/quality-policy"
import type { QualityReport } from "@/lib/ai/content-quality"

describe("Batch 이력 요약", () => {
  it("summarizes a completed generate run with ready/needs_review counts", () => {
    const view = summarizeRunForHistory({
      kind: "generate",
      status: "completed",
      totals: { items: 4, ready: 3, warn_ready: 0, needs_review: 1, failed: 0, skipped: 0 },
    })
    expect(view.kindLabel).toBe("AI 일괄 생성")
    expect(view.statusLabel).toBe("완료")
    expect(view.summary).toBe("4건 · ready 3 · 확인 필요 1")
  })

  it("summarizes a publish run and counts warn_ready into ready", () => {
    const publish = summarizeRunForHistory({ kind: "publish", status: "completed", totals: { items: 3, published: 3 } })
    expect(publish.kindLabel).toBe("일괄 게시")
    expect(publish.summary).toBe("3건 · 게시 3")

    const warn = summarizeRunForHistory({ kind: "generate", status: "completed", totals: { items: 2, ready: 1, warn_ready: 1 } })
    expect(warn.summary).toBe("2건 · ready 2")
  })

  it("handles running/cancelled runs and malformed totals safely", () => {
    expect(summarizeRunForHistory({ kind: "generate", status: "running", totals: null }).statusLabel).toBe("진행 중")
    expect(summarizeRunForHistory({ kind: "publish", status: "cancelled", totals: { items: 5, published: 2, skipped: 3 } }).summary).toBe("5건 · 게시 2 · 건너뜀 3")
    expect(summarizeRunForHistory({ kind: "generate", status: "failed", totals: "broken" }).summary).toBe("0건")
  })
})

describe("정책 문서 v1.1 정합성 — 코드 동작은 변경하지 않는다", () => {
  const failReport = (code: string): QualityReport => ({ status: "fail", issues: [{ code, level: "fail", message: "test" }] })

  it("keeps returning kind:failed for content FAIL at the policy layer (service maps it to needs_review)", () => {
    // 콘텐츠 FAIL — 정책 계층 반환값은 v1과 동일하게 유지된다 (문서만 개정).
    expect(decideBatchItemOutcome(failReport("banned:delivery-guarantee"))).toEqual({ kind: "failed", reason: "quality-fail:banned:delivery-guarantee" })
  })

  it("keeps the repeat:faq single-FAIL controlled retry", () => {
    expect(decideBatchItemOutcome(failReport("repeat:faq"))).toEqual({ kind: "retry-faq", reason: "quality-fail-repeat-faq" })
  })
})
