// Batch 운영 v1 공통 타입 — 상태·설정·집계. DB 행 타입은 types/database.ts의 BatchRunRow/BatchRunItemRow.
import type { BatchItemStatus, BatchItemStep, BatchRunKind } from "@/types/database"

export const BATCH_MAX_ITEMS = 5

// 장시간 멈춘 processing 판정 기준 — 이 시간 넘게 갱신이 없으면 interrupted로 본다.
export const BATCH_STALE_PROCESSING_MS = 10 * 60 * 1000

export type BatchWarnPolicy = "auto-ready" | "hold"

export type BatchRunSettings = {
  readonly max_items: number
  readonly max_cost_usd: number
  readonly warn_policy: BatchWarnPolicy
  readonly usd_krw_rate: number
  // 시작 모달에서 "공식 검증 완료" 명시 승인 여부 — verified 상태와 함께 이중 확인
  readonly official_check_approved: boolean
  readonly estimated_tokens: number
  readonly estimated_cost_usd: number
}

// 게시 배치 설정 — 생성 배치와 달리 AI 비용이 없고, 승인 1회의 주체·시각을 기록한다.
export type BatchPublishRunSettings = {
  readonly max_items: number
  // 시작 폼에서 "게시 승인" 명시 체크 1회 — 승인 시점 스냅샷(approval_snapshot)이 item별로 고정된다.
  readonly publish_approved: boolean
  readonly approved_by: string | null
  readonly approved_at: string
}

export type BatchItemOutcome =
  | { readonly kind: "auto-ready"; readonly targetStatus: "ready" | "warn_ready" }
  | { readonly kind: "needs-review"; readonly reason: "warn-other" | "warn-count" }
  | { readonly kind: "retry-faq"; readonly reason: "quality-fail-repeat-faq" }
  // 업종에 맞지 않는 어휘 — 재시도 1회로 교정을 시도하고, 남으면 item을 failed로 닫는다.
  | { readonly kind: "retry-vocabulary"; readonly reason: "forbidden-mode-vocabulary" }
  | { readonly kind: "failed"; readonly reason: string }

export type BatchStepContext = {
  readonly kind: BatchRunKind
  readonly step: BatchItemStep
  readonly batchId: string
  readonly placeId: string
}

// 재개 화면 표시용 요약
export type BatchResumeSummary = {
  readonly resumableItemIds: readonly string[]
  readonly interruptedItemIds: readonly string[]
}

export type BatchItemStatusCounts = Readonly<Partial<Record<BatchItemStatus, number>>>
