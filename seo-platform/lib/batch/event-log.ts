// Batch 이벤트 로그 순수 계층 (PR-S4) — 라벨·멱등성 키·detail allowlist·안전 기록 래퍼.
// 이벤트는 파생 감사 기록이다: 저장 실패·중복 충돌은 Batch 본 처리에 절대 영향을 주지 않는다.
import type { BatchRunEventType, Json } from "@/types/database"

export const BATCH_EVENT_LABELS: Readonly<Record<BatchRunEventType, string>> = {
  run_created: "배치 생성됨",
  run_started: "실행 시작",
  item_claimed: "장소 처리 시작",
  item_step_changed: "단계 전환",
  item_result_recorded: "장소 결과 기록",
  items_skipped: "남은 장소 건너뜀",
  item_interrupted_marked: "중단됨 판정",
  run_cancel_requested: "사용자 중단 요청",
  run_finished: "배치 종료",
  verification_updated: "공개 검증 갱신",
}

// detail 저장 allowlist — 생성 본문·FAQ·메타 설명·토큰(인증)·환경변수·stack trace·민감 원문은 어떤 경로로도 저장하지 않는다.
const DETAIL_ALLOWED_KEYS = [
  "trigger",
  "retry_count",
  "error_code",
  "skip_reason",
  "skipped_count",
  "http_status",
  "verification_status",
  "tokens_input",
  "tokens_output",
  "cost_usd",
  "cancelled_by_user",
] as const

export type BatchEventDetail = Partial<Record<(typeof DETAIL_ALLOWED_KEYS)[number], string | number | boolean | null>>

// allowlist 외 키와 원시값이 아닌 값(객체·배열·장문 문자열)을 제거한다.
export function sanitizeEventDetail(detail: Readonly<Record<string, unknown>>): BatchEventDetail {
  const sanitized: Record<string, string | number | boolean | null> = {}
  for (const key of DETAIL_ALLOWED_KEYS) {
    const value = detail[key]
    if (value === undefined) {
      continue
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") {
      sanitized[key] = value
    } else if (typeof value === "string" && value.length <= 200) {
      sanitized[key] = value
    }
  }
  return sanitized
}

export type NewBatchEvent = {
  readonly batchId: string
  readonly itemId?: string | null
  readonly eventType: BatchRunEventType
  readonly fromStatus?: string | null
  readonly toStatus?: string | null
  readonly step?: string | null
  readonly actor?: string | null
  readonly detail?: Readonly<Record<string, unknown>>
}

// 결정적 멱등성 키 — 동일 전이·동일 액션 재호출은 (batch_id, idempotency_key) unique 충돌로 no-op가 된다.
// 형식: itemId:eventType:fromStatus:toStatus:step (run 수준 이벤트는 itemId가 빈 문자열)
export function buildEventIdempotencyKey(event: NewBatchEvent): string {
  return [event.itemId ?? "", event.eventType, event.fromStatus ?? "", event.toStatus ?? "", event.step ?? ""].join(":")
}

export type BatchEventInsertRow = {
  readonly batch_id: string
  readonly item_id: string | null
  readonly event_type: BatchRunEventType
  readonly from_status: string | null
  readonly to_status: string | null
  readonly step: string | null
  readonly actor: string | null
  readonly detail: Json
  readonly idempotency_key: string
}

export function toEventInsertRow(event: NewBatchEvent): BatchEventInsertRow {
  return {
    batch_id: event.batchId,
    item_id: event.itemId ?? null,
    event_type: event.eventType,
    from_status: event.fromStatus ?? null,
    to_status: event.toStatus ?? null,
    step: event.step ?? null,
    actor: event.actor ?? null,
    detail: sanitizeEventDetail(event.detail ?? {}),
    idempotency_key: buildEventIdempotencyKey(event),
  }
}

export type EventInsertFn = (row: BatchEventInsertRow) => Promise<{ readonly errorCode: string | null }>

// fire-and-forget 기록 — 실패는 console.error만 남기고 삼킨다. unique 충돌(23505)은 정상 no-op.
export async function recordBatchEventSafely(insert: EventInsertFn, event: NewBatchEvent): Promise<void> {
  try {
    const result = await insert(toEventInsertRow(event))
    if (result.errorCode !== null && result.errorCode !== "23505") {
      console.error("[batch-events] insert failed", { batchId: event.batchId, eventType: event.eventType, errorCode: result.errorCode })
    }
  } catch (error) {
    console.error("[batch-events] insert threw", { batchId: event.batchId, eventType: event.eventType, error: error instanceof Error ? error.message : String(error) })
  }
}
