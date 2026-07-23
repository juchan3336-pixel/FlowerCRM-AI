// Batch WARN v1 기본 정책 — 자동 ready 범위를 코드로 고정한다.
// PASS/issues 0 → ready · repeat:title 단독 1건 → warn_ready(auto-ready) · 그 외 WARN → needs_review
// WARN 2건 이상 → needs_review(hold) · FAIL(repeat:faq) → 제어 재시도 1회
// 그 외 콘텐츠 FAIL: 여기서는 kind:"failed"(자동 진행 불가)를 반환하지만, 서비스 계층
// (generation-batch-service)이 preview를 보존한 채 item을 needs_review로 기록한다 —
// 검토 가능한 콘텐츠 결함은 사용자 확인 대상이고, item의 failed는 시스템 오류·검증 불가 전용이다.
// (정책 문서: docs/content-quality-policy.md v1.1)
import type { QualityReport } from "@/lib/ai/content-quality"
import type { BatchItemOutcome, BatchWarnPolicy } from "./types"

// 자동 ready가 허용되는 WARN 코드 화이트리스트 — 안전 결함이 아닌 다양성 관찰 항목만.
const AUTO_READY_WARN_CODES: readonly string[] = ["repeat:title"]

export function decideBatchItemOutcome(quality: QualityReport, warnPolicy: BatchWarnPolicy = "auto-ready"): BatchItemOutcome {
  if (quality.status === "fail") {
    const failCodes = quality.issues.filter((issue) => issue.level === "fail").map((issue) => issue.code)
    if (failCodes.length === 1 && failCodes[0] === "repeat:faq") {
      return { kind: "retry-faq", reason: "quality-fail-repeat-faq" }
    }
    return { kind: "failed", reason: `quality-fail:${failCodes.join(",")}` }
  }

  if (quality.status === "pass") {
    return { kind: "auto-ready", targetStatus: "ready" }
  }

  // WARN
  const warnCodes = quality.issues.filter((issue) => issue.level === "warn").map((issue) => issue.code)
  if (warnCodes.length >= 2) {
    return { kind: "needs-review", reason: "warn-count" }
  }
  const single = warnCodes[0]
  if (single !== undefined && AUTO_READY_WARN_CODES.includes(single) && warnPolicy === "auto-ready") {
    return { kind: "auto-ready", targetStatus: "warn_ready" }
  }
  return { kind: "needs-review", reason: "warn-other" }
}
