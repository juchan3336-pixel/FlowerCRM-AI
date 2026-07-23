import { describe, expect, it } from "vitest"

import {
  BATCH_EVENT_LABELS,
  buildEventIdempotencyKey,
  recordBatchEventSafely,
  sanitizeEventDetail,
  toEventInsertRow,
  type BatchEventInsertRow,
} from "@/lib/batch/event-log"
import { computeCoreMetrics, computeEventMetrics, EMPTY_EVENT_METRICS } from "@/lib/batch/metrics"
import type { BatchRunEventRow, BatchRunEventType, BatchRunRow } from "@/types/database"

describe("Batch 이벤트 라벨·멱등성 키", () => {
  it("labels every event type in Korean", () => {
    const types: BatchRunEventType[] = [
      "run_created",
      "run_started",
      "item_claimed",
      "item_step_changed",
      "item_result_recorded",
      "items_skipped",
      "item_interrupted_marked",
      "run_cancel_requested",
      "run_finished",
      "verification_updated",
    ]
    for (const type of types) {
      expect(BATCH_EVENT_LABELS[type].length).toBeGreaterThan(0)
    }
  })

  it("builds deterministic idempotency keys from item/type/transition/step", () => {
    const key = buildEventIdempotencyKey({ batchId: "b1", itemId: "i1", eventType: "item_claimed", fromStatus: "queued", toStatus: "processing", step: "generating" })
    expect(key).toBe("i1:item_claimed:queued:processing:generating")
    // run 수준 이벤트는 itemId가 빈 문자열 — 배치당 한 번만 남는다.
    expect(buildEventIdempotencyKey({ batchId: "b1", eventType: "run_started", toStatus: "running" })).toBe(":run_started::running:")
    // 동일 전이 재호출 → 같은 키 (unique 충돌 no-op)
    expect(buildEventIdempotencyKey({ batchId: "b1", itemId: "i1", eventType: "item_claimed", fromStatus: "queued", toStatus: "processing", step: "generating" })).toBe(key)
  })
})

describe("detail allowlist sanitizer", () => {
  it("keeps only allowed summary fields and drops content/secret-like payloads", () => {
    const sanitized = sanitizeEventDetail({
      trigger: "resume",
      error_code: "quality-fail:banned:delivery-guarantee",
      skip_reason: "cancelled-by-user",
      http_status: 200,
      verification_status: "verified",
      tokens_input: 913,
      cost_usd: 0.0008,
      cancelled_by_user: true,
      description: "생성 본문 전체...",
      faq: [{ q: "질문" }],
      meta_description: "메타 설명",
      OPENAI_API_KEY: "sk-xxx",
      stack: "Error: at ...",
      nested: { deep: "object" },
    })
    expect(sanitized).toEqual({
      trigger: "resume",
      error_code: "quality-fail:banned:delivery-guarantee",
      skip_reason: "cancelled-by-user",
      http_status: 200,
      verification_status: "verified",
      tokens_input: 913,
      cost_usd: 0.0008,
      cancelled_by_user: true,
    })
  })

  it("drops oversized strings even on allowed keys", () => {
    expect(sanitizeEventDetail({ error_code: "x".repeat(300) })).toEqual({})
  })
})

describe("fire-and-forget 기록", () => {
  it("swallows thrown insert errors — Batch 본 처리에 영향 없음", async () => {
    await expect(
      recordBatchEventSafely(() => {
        throw new Error("db down")
      }, { batchId: "b1", eventType: "run_created" }),
    ).resolves.toBeUndefined()
  })

  it("treats unique-violation(23505) as a normal no-op and passes sanitized rows to insert", async () => {
    const rows: BatchEventInsertRow[] = []
    await recordBatchEventSafely(
      (row) => {
        rows.push(row)
        return Promise.resolve({ errorCode: "23505" })
      },
      { batchId: "b1", itemId: "i1", eventType: "item_result_recorded", fromStatus: "processing", toStatus: "ready", detail: { error_code: null, description: "본문" } },
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.idempotency_key).toBe("i1:item_result_recorded:processing:ready:")
    expect(rows[0]?.detail).toEqual({ error_code: null })
  })
})

function runRow(overrides: Partial<BatchRunRow>): BatchRunRow {
  return {
    id: "r1",
    kind: "generate",
    status: "completed",
    created_by: "admin",
    settings: { estimated_cost_usd: 0.004 },
    totals: { actual_cost_usd: 0.0032 },
    started_at: "2026-07-23T00:00:00Z",
    finished_at: "2026-07-23T00:01:00Z",
    created_at: "2026-07-23T00:00:00Z",
    updated_at: "2026-07-23T00:01:00Z",
    ...overrides,
  }
}

describe("핵심 지표 — 기존 batch_runs/items만으로 계산", () => {
  it("computes success/ready/warn-fail/publish/verify metrics from fixtures", () => {
    const runs = [runRow({}), runRow({ id: "r2", kind: "publish", settings: {}, totals: {} })]
    const items = [
      { status: "ready", quality_status: "pass", cost_usd: 0.0008, started_at: "2026-07-23T00:00:00Z", finished_at: "2026-07-23T00:00:12Z" },
      { status: "needs_review", quality_status: "fail", cost_usd: 0.0008, started_at: "2026-07-23T00:00:12Z", finished_at: "2026-07-23T00:00:20Z" },
      { status: "warn_ready", quality_status: "warn", cost_usd: 0.0008, started_at: "2026-07-23T00:00:20Z", finished_at: "2026-07-23T00:00:32Z" },
      { status: "published", quality_status: null, cost_usd: null, started_at: "2026-07-23T00:01:00Z", finished_at: "2026-07-23T00:01:02Z" },
      { status: "publish_failed", quality_status: null, cost_usd: null, started_at: "2026-07-23T00:01:02Z", finished_at: "2026-07-23T00:01:03Z" },
    ] as const
    const metrics = computeCoreMetrics(runs, items, [4.5, 2.7])
    expect(metrics.runSuccessRate).toBe(1)
    expect(metrics.readyRate).toBeCloseTo(2 / 3)
    expect(metrics.warnRate).toBeCloseTo(1 / 3)
    expect(metrics.failRate).toBeCloseTo(1 / 3)
    expect(metrics.publishItemSuccessRate).toBeCloseTo(1 / 2)
    expect(metrics.estimatedVsActualRatio).toBeCloseTo(0.8)
    expect(metrics.avgVerifySeconds).toBeCloseTo(3.6)
    expect(metrics.avgCostUsd).toBeCloseTo(0.0008)
  })

  it("degrades to null-safe values with no data (이벤트·데이터 없음에도 화면 오류 없음)", () => {
    const metrics = computeCoreMetrics([], [], [])
    expect(metrics.runSuccessRate).toBeNull()
    expect(metrics.avgItemSeconds).toBeNull()
    expect(computeEventMetrics([])).toEqual(EMPTY_EVENT_METRICS)
  })
})

function eventRow(overrides: Partial<BatchRunEventRow>): BatchRunEventRow {
  return {
    id: Math.random().toString(36).slice(2),
    batch_id: "b1",
    item_id: "i1",
    event_type: "item_claimed",
    from_status: null,
    to_status: null,
    step: null,
    actor: null,
    detail: {},
    idempotency_key: "k",
    created_at: "2026-07-23T00:00:00Z",
    ...overrides,
  }
}

describe("이벤트 기반 지표", () => {
  it("counts interruptions, resumes, cancellations and verification transitions, and averages step durations", () => {
    const events = [
      eventRow({ event_type: "item_claimed", from_status: "queued", to_status: "processing", step: "generating", created_at: "2026-07-23T00:00:00Z" }),
      eventRow({ event_type: "item_step_changed", step: "checking", created_at: "2026-07-23T00:00:10Z" }),
      eventRow({ event_type: "item_result_recorded", from_status: "processing", to_status: "ready", created_at: "2026-07-23T00:00:14Z" }),
      eventRow({ event_type: "item_interrupted_marked", item_id: "i2", from_status: "processing", to_status: "interrupted", created_at: "2026-07-23T00:01:00Z" }),
      eventRow({ event_type: "item_claimed", item_id: "i2", from_status: "interrupted", to_status: "processing", step: "generating", detail: { trigger: "resume" }, created_at: "2026-07-23T00:02:00Z" }),
      eventRow({ event_type: "run_cancel_requested", item_id: null, actor: "admin", created_at: "2026-07-23T00:03:00Z" }),
      eventRow({ event_type: "verification_updated", to_status: "pending", created_at: "2026-07-23T00:03:10Z" }),
      eventRow({ event_type: "verification_updated", to_status: "verified", created_at: "2026-07-23T00:03:15Z" }),
    ]
    const metrics = computeEventMetrics(events)
    expect(metrics.interruptedCount).toBe(1)
    expect(metrics.resumeCount).toBe(1)
    expect(metrics.cancelRequests).toBe(1)
    expect(metrics.avgStepSeconds["generating"]).toBeCloseTo(10)
    expect(metrics.avgStepSeconds["checking"]).toBeCloseTo(4)
    expect(metrics.verificationTransitions).toEqual({ pending: 1, verified: 1 })
  })
})

describe("insert row 구성", () => {
  it("normalizes optional fields and always carries a sanitized default detail", () => {
    const row = toEventInsertRow({ batchId: "b1", eventType: "run_finished", fromStatus: "running", toStatus: "cancelled", detail: { cancelled_by_user: true } })
    expect(row).toMatchObject({ batch_id: "b1", item_id: null, event_type: "run_finished", from_status: "running", to_status: "cancelled", step: null, actor: null, detail: { cancelled_by_user: true } })
    expect(row.idempotency_key).toBe(":run_finished:running:cancelled:")
  })
})
