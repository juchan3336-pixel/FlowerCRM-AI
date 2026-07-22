// Batch item 상태 머신 — 전이는 단방향이며, 조건부 UPDATE(기대 상태 일치 시에만)로 멱등성을 보장한다.
// 브라우저 이탈 후 재개: 마지막 완료 item 다음의 queued/interrupted만 다시 claim 가능하다.
import type { BatchItemStatus } from "@/types/database"
import { BATCH_STALE_PROCESSING_MS } from "./types"

// 허용 전이표 (from → to 집합). 여기 없는 전이는 전부 거부된다.
const ITEM_TRANSITIONS: Readonly<Record<BatchItemStatus, readonly BatchItemStatus[]>> = {
  queued: ["processing", "skipped"],
  processing: ["ready", "warn_ready", "needs_review", "failed", "interrupted", "skipped"],
  interrupted: ["processing", "skipped"],
  ready: ["processing", "skipped"],
  warn_ready: ["processing", "skipped"],
  needs_review: [],
  failed: [],
  skipped: [],
  published: [],
  publish_failed: [],
}

// 게시 배치에서 processing 이후 도달 가능한 종료 상태
const PUBLISH_TERMINALS: readonly BatchItemStatus[] = ["published", "publish_failed"]

export function canTransitionItem(from: BatchItemStatus, to: BatchItemStatus, kind: "generate" | "publish" = "generate"): boolean {
  if (kind === "publish" && from === "processing" && PUBLISH_TERMINALS.includes(to)) {
    return true
  }
  return ITEM_TRANSITIONS[from].includes(to)
}

// ready/warn_ready → processing 은 게시 배치의 claim 전이다 (생성 배치에서는 발생하지 않음).
export function claimableStatusesFor(kind: "generate" | "publish"): readonly BatchItemStatus[] {
  return kind === "generate" ? ["queued", "interrupted"] : ["ready", "warn_ready", "interrupted"]
}

// 장시간 멈춘 processing 판정 — updated_at 기준. 자동 재개는 하지 않고 표시·'이어서 진행' 대상만 만든다.
export function isStaleProcessing(input: Readonly<{ status: BatchItemStatus; updatedAt: string; now: string; staleMs?: number | undefined }>): boolean {
  if (input.status !== "processing") {
    return false
  }
  const updated = Date.parse(input.updatedAt)
  const now = Date.parse(input.now)
  if (Number.isNaN(updated) || Number.isNaN(now)) {
    return false
  }
  return now - updated >= (input.staleMs ?? BATCH_STALE_PROCESSING_MS)
}

export function isTerminalItemStatus(status: BatchItemStatus): boolean {
  return ["ready", "warn_ready", "needs_review", "failed", "skipped", "published", "publish_failed"].includes(status)
}
