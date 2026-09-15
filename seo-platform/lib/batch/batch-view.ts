// Batch 시작 계획·집계 순수 로직 — 서버 액션과 진행 화면이 공유하고 테스트로 고정한다.
import type { BatchRunItemRow, Json } from "@/types/database"
import type { BatchCandidateDecision } from "./candidate-policy"
import { estimateBatchCost, isEstimateOverLimit, type BatchCostEstimate } from "./cost-policy"
import { BATCH_MAX_ITEMS } from "./types"

export type BatchStartPlan =
  | { readonly kind: "ok"; readonly placeIds: readonly string[]; readonly estimate: BatchCostEstimate }
  | { readonly kind: "invalid"; readonly reason: "empty" | "too-many" | "duplicate" | "official-check-required" | "ineligible" | "cost-limit"; readonly detail?: string }

export function planBatchStart(input: Readonly<{
  placeIds: readonly string[]
  decisions: ReadonlyMap<string, BatchCandidateDecision>
  officialCheckApproved: boolean
  maxCostUsd: number
  usdKrwRate: number
}>): BatchStartPlan {
  const unique = [...new Set(input.placeIds)]
  if (unique.length !== input.placeIds.length) {
    return { kind: "invalid", reason: "duplicate" }
  }
  if (unique.length === 0) {
    return { kind: "invalid", reason: "empty" }
  }
  if (unique.length > BATCH_MAX_ITEMS) {
    return { kind: "invalid", reason: "too-many" }
  }
  if (!input.officialCheckApproved) {
    return { kind: "invalid", reason: "official-check-required" }
  }
  for (const placeId of unique) {
    const decision = input.decisions.get(placeId)
    if (!decision?.eligible) {
      return { kind: "invalid", reason: "ineligible", detail: decision === undefined ? placeId : `${placeId}:${decision.reason}` }
    }
  }
  const estimate = estimateBatchCost(unique.length, input.usdKrwRate)
  if (isEstimateOverLimit(estimate, input.maxCostUsd)) {
    return { kind: "invalid", reason: "cost-limit" }
  }
  return { kind: "ok", placeIds: unique, estimate }
}

export type BatchTotals = {
  readonly items: number
  readonly ready: number
  readonly warn_ready: number
  readonly needs_review: number
  readonly failed: number
  readonly skipped: number
  readonly interrupted: number
  readonly published: number
  readonly publish_failed: number
  readonly tokens_input: number
  readonly tokens_output: number
  readonly actual_cost_usd: number
}

export function summarizeBatchTotals(items: readonly Pick<BatchRunItemRow, "status" | "tokens_input" | "tokens_output" | "cost_usd">[]): BatchTotals {
  const totals = {
    items: items.length,
    ready: 0,
    warn_ready: 0,
    needs_review: 0,
    failed: 0,
    skipped: 0,
    interrupted: 0,
    published: 0,
    publish_failed: 0,
    tokens_input: 0,
    tokens_output: 0,
    actual_cost_usd: 0,
  }
  for (const item of items) {
    switch (item.status) {
      case "ready":
        totals.ready += 1
        break
      case "warn_ready":
        totals.warn_ready += 1
        break
      case "needs_review":
        totals.needs_review += 1
        break
      case "failed":
        totals.failed += 1
        break
      case "skipped":
        totals.skipped += 1
        break
      case "interrupted":
        totals.interrupted += 1
        break
      case "published":
        totals.published += 1
        break
      case "publish_failed":
        totals.publish_failed += 1
        break
      default:
        break
    }
    totals.tokens_input += item.tokens_input ?? 0
    totals.tokens_output += item.tokens_output ?? 0
    totals.actual_cost_usd += item.cost_usd ?? 0
  }
  // 부동소수 잔여 정리 (표시용 6자리)
  totals.actual_cost_usd = Math.round(totals.actual_cost_usd * 1e6) / 1e6
  return totals
}

export function totalsToJson(totals: BatchTotals): Json {
  return totals
}

// 실제 누적 비용 — 실패·재시도 비용 포함(item.cost_usd에 합산 기록됨).
export function actualCostSoFar(items: readonly Pick<BatchRunItemRow, "cost_usd">[]): number {
  return items.reduce((total, item) => total + (item.cost_usd ?? 0), 0)
}

// 마지막 상태 갱신 시각 — run과 item들의 updated_at 중 가장 최근 값 (없으면 null).
export function latestBatchUpdatedAt(runUpdatedAt: string | null, items: readonly Pick<BatchRunItemRow, "updated_at">[]): string | null {
  let latest: string | null = runUpdatedAt
  for (const item of items) {
    if (latest === null || Date.parse(item.updated_at) > Date.parse(latest)) {
      latest = item.updated_at
    }
  }
  return latest
}

// 생성 배치 상세의 게시 연결 배너 판정 — item 상태(ready·warn_ready)만으로는 부족하다.
// publish pump가 이미 게시한 장소는 places.status가 draft가 아니므로, draft 장소 수로 CTA를 센다.
// 적격 item은 있는데 draft 장소가 0이면 자동 게시가 끝난 것 — CTA 대신 완료 안내를 보여준다.
export type PublishLinkBanner =
  | { readonly kind: "none" }
  | { readonly kind: "publishable"; readonly draftCount: number }
  | { readonly kind: "auto-published"; readonly publishableCount: number }

export function decidePublishLinkBanner(input: Readonly<{
  isPublishRun: boolean
  isRunning: boolean
  publishableStatusCount: number
  draftPlaceCount: number
}>): PublishLinkBanner {
  if (input.isPublishRun || input.isRunning || input.publishableStatusCount === 0) {
    return { kind: "none" }
  }
  if (input.draftPlaceCount > 0) {
    return { kind: "publishable", draftCount: input.draftPlaceCount }
  }
  return { kind: "auto-published", publishableCount: input.publishableStatusCount }
}

// Batch 이력 목록 한 행의 표시용 요약 — totals jsonb에서 안전하게 집계 문구를 만든다.
export type BatchRunHistoryView = {
  readonly kindLabel: "AI 일괄 생성" | "일괄 게시"
  readonly statusLabel: "진행 중" | "완료" | "중단됨" | "실패"
  readonly summary: string
}

export function summarizeRunForHistory(run: Readonly<{ kind: "generate" | "publish"; status: "running" | "completed" | "cancelled" | "failed"; totals: unknown }>): BatchRunHistoryView {
  const kindLabel = run.kind === "publish" ? "일괄 게시" : "AI 일괄 생성"
  const statusLabel = run.status === "running" ? "진행 중" : run.status === "completed" ? "완료" : run.status === "cancelled" ? "중단됨" : "실패"
  const totals = (typeof run.totals === "object" && run.totals !== null ? run.totals : {}) as Partial<BatchTotals>
  const items = totals.items ?? 0
  const parts: string[] = [`${String(items)}건`]
  if (run.kind === "generate") {
    const ready = (totals.ready ?? 0) + (totals.warn_ready ?? 0)
    if (ready > 0) parts.push(`ready ${String(ready)}`)
    if ((totals.needs_review ?? 0) > 0) parts.push(`확인 필요 ${String(totals.needs_review ?? 0)}`)
    if ((totals.failed ?? 0) > 0) parts.push(`실패 ${String(totals.failed ?? 0)}`)
  } else {
    if ((totals.published ?? 0) > 0) parts.push(`게시 ${String(totals.published ?? 0)}`)
    if ((totals.publish_failed ?? 0) > 0) parts.push(`게시 실패 ${String(totals.publish_failed ?? 0)}`)
  }
  if ((totals.skipped ?? 0) > 0) parts.push(`건너뜀 ${String(totals.skipped ?? 0)}`)
  return { kindLabel, statusLabel, summary: parts.join(" · ") }
}

// 진행 화면 표시용 KST 시각 (MM-DD HH:mm:ss). 파싱 불가 값은 null.
export function formatBatchKstTime(iso: string | null): string | null {
  if (iso === null) {
    return null
  }
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) {
    return null
  }
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(parsed))
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "00"
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`
}
