// 소재 승인 스냅샷 — 승인한 그 문안·이미지·주문 링크만 밖으로 나가게 한다.
//
// 승인 시점의 내용을 해시로 고정하고, 내보내기·게시 확인 직전에 다시 계산해 비교한다.
// 문안, 이미지, 목적지, 추적 링크 중 하나라도 바뀌면 해시가 달라져 승인이 무효가 된다.
import { createHash } from "node:crypto"

import type { QualityReport } from "@/lib/ai/content-quality"

import { checkDestinationUrl } from "./order-destination"
import type { MarketingVariantDraft } from "./types"

export function computeVariantApprovalHash(variant: MarketingVariantDraft): string {
  // 순서를 고정한 결정적 직렬화 — 같은 내용은 항상 같은 해시.
  const canonical = JSON.stringify([
    variant.mode,
    variant.channel,
    variant.destination,
    variant.orderUrl,
    variant.copy.title,
    variant.copy.body,
    variant.copy.caption ?? null,
    variant.copy.imageTexts ?? [],
    variant.imageRefs,
  ])
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

export type VariantApprovalSnapshot = {
  readonly revision: number
  readonly approvalHash: string
  readonly approvedBy: string
  readonly approvedAt: string
}

export type ApprovalDecision = { readonly ok: true; readonly snapshot: VariantApprovalSnapshot } | { readonly ok: false; readonly reason: "quality-fail" | "order-url-not-allowed" | "approver-missing" }

export type ApproveVariantInput = {
  readonly variant: MarketingVariantDraft
  readonly quality: QualityReport
  readonly approvedBy: string
  readonly approvedAt: string
}

// 품질 FAIL은 승인할 수 없다 — 보정 후 다시 검사해야 한다. WARN은 사람이 보고 승인할 수 있다.
export function approveVariant(input: ApproveVariantInput): ApprovalDecision {
  if (input.approvedBy.trim().length === 0) {
    return { ok: false, reason: "approver-missing" }
  }
  if (input.quality.status === "fail") {
    return { ok: false, reason: "quality-fail" }
  }
  if (!checkDestinationUrl(input.variant.destination, input.variant.orderUrl).ok) {
    return { ok: false, reason: "order-url-not-allowed" }
  }
  return {
    ok: true,
    snapshot: { revision: input.variant.revision, approvalHash: computeVariantApprovalHash(input.variant), approvedBy: input.approvedBy, approvedAt: input.approvedAt },
  }
}

export function isVariantApprovalValid(snapshot: VariantApprovalSnapshot, current: MarketingVariantDraft): boolean {
  return snapshot.revision === current.revision && snapshot.approvalHash === computeVariantApprovalHash(current)
}

export type ManualPostConfirmation = {
  readonly postedUrl: string
  readonly confirmedBy: string
  readonly confirmedAt: string
  // 어느 승인본이 게시됐는지
  readonly revision: number
  readonly approvalHash: string
}

export type ManualConfirmDecision = { readonly ok: true; readonly confirmation: ManualPostConfirmation } | { readonly ok: false; readonly reason: "approval-stale" | "posted-url-invalid" | "confirmer-missing" }

export type ConfirmManualPostInput = {
  readonly snapshot: VariantApprovalSnapshot
  readonly current: MarketingVariantDraft
  readonly postedUrl: string
  readonly confirmedBy: string
  readonly confirmedAt: string
}

// 사람 게시 확인 — 복사·다운로드만으로는 게시 완료가 되지 않는다. 실제 게시 글 주소가 있어야 한다.
export function confirmManualPost(input: ConfirmManualPostInput): ManualConfirmDecision {
  if (input.confirmedBy.trim().length === 0) {
    return { ok: false, reason: "confirmer-missing" }
  }
  if (!isVariantApprovalValid(input.snapshot, input.current)) {
    return { ok: false, reason: "approval-stale" }
  }
  if (!isHttpsUrl(input.postedUrl)) {
    return { ok: false, reason: "posted-url-invalid" }
  }
  return {
    ok: true,
    confirmation: { postedUrl: input.postedUrl, confirmedBy: input.confirmedBy, confirmedAt: input.confirmedAt, revision: input.snapshot.revision, approvalHash: input.snapshot.approvalHash },
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}
