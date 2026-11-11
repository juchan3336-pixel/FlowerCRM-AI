// Collect 외부 예약 dispatch — 순수 정책 (I/O 없음).
//
// GitHub의 schedule 트리거가 이 저장소에서 대부분 실행되지 않아(Collect: 30분 cron에 하루 3~4회),
// Supabase Cron이 이 endpoint를 부르고 endpoint가 workflow_dispatch를 보낸다.
// 요청자가 정할 수 있는 것은 "지금 한 번 시도하라"뿐이다. 저장소·워크플로·ref·수집 한도·쓰기 여부는
// 전부 서버가 고정하고, 쓰기 여부는 DB의 제어 행(mode)만 결정한다.
//
// Enrich 예약(lib/enrich-dispatch)과는 코드·테이블·서명키·토큰을 공유하지 않는다. 서명 대상에
// 경로가 들어가므로 Enrich용 서명은 여기서 통과하지 못한다.
import { createHmac, timingSafeEqual } from "node:crypto"

export const COLLECT_DISPATCH_PATH = "/api/collect/dispatch"
export const COLLECT_DISPATCH_TIMESTAMP_HEADER = "x-collect-dispatch-timestamp"
export const COLLECT_DISPATCH_SIGNATURE_HEADER = "x-collect-dispatch-signature"

export const COLLECT_REPOSITORY = { owner: "juchan3336-pixel", repo: "FlowerCRM-AI", workflow: "collect.yml", ref: "main" } as const
/** 워크플로의 수동 실행 기본값과 같다. 탐색에 쓰는 시간은 20분까지이고, 저장은 그 뒤에 한다. */
export const COLLECT_DISPATCH_INPUTS = {
  collect_preset: "custom",
  limit: "300",
  max_queue_visits: "40",
  max_runtime_ms: "1200000",
  debug: "false",
} as const

/** 한 slot = 90분. slot마다 dispatch는 최대 1회이고, 지나간 slot은 보충하지 않는다. */
export const COLLECT_SLOT_MS = 90 * 60 * 1000
/**
 * slot 경계는 UTC 00:45, 02:15, 03:45 …이다. Enrich의 경계(00:00, 01:30 …)와 45분 어긋나게 두어
 * 두 워크플로가 같은 시각에 시작하지 않게 한다(동시 실행을 막는 장치는 아니다).
 */
export const COLLECT_SLOT_OFFSET_MS = 45 * 60 * 1000
/** 서명 유효 시간. 과거 5분, 미래 1분(시계 오차)까지만 받는다. */
export const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000
export const SIGNATURE_MAX_FUTURE_MS = 60 * 1000

/** 같은 워크플로에 이 상태의 run이 하나라도 있으면 이번 slot은 건너뛴다. */
export const BUSY_RUN_STATUSES = ["queued", "in_progress", "requested", "waiting", "pending"] as const

export type CollectDispatchMode = "dry_run" | "live"

export type CollectDispatchOutcome =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "conflict"; readonly reason: "missing-env" | "not-production" }
  | { readonly kind: "noop"; readonly reason: "disabled" | "duplicate-slot" | "busy" | "blocked" | "check-failed" | "out-of-time" | "lost-claim" }
  | { readonly kind: "sent"; readonly slot: string; readonly mode: CollectDispatchMode; readonly runId: number | null }
  | { readonly kind: "rejected"; readonly slot: string; readonly httpStatus: number }
  | { readonly kind: "unknown"; readonly slot: string }
  | { readonly kind: "failed" }

export function slotForTime(nowMs: number): string {
  const index = Math.floor((nowMs - COLLECT_SLOT_OFFSET_MS) / COLLECT_SLOT_MS)
  return new Date(index * COLLECT_SLOT_MS + COLLECT_SLOT_OFFSET_MS).toISOString()
}

/**
 * slot은 요청이 도착한 시각이 아니라 서명된 시각에서 나온다. 같은 서명을 유효 시간 안에 다시
 * 보내도 같은 slot이 되어 한 번만 처리된다 — 구간 경계를 사이에 두고 보내도 마찬가지다.
 * timestamp는 verifyDispatchSignature를 통과한 값만 넘긴다.
 */
export function slotForSignedTimestamp(timestamp: string): string {
  return slotForTime(Number(timestamp) * 1000)
}

/** 서명 대상 문자열. SQL(pgcrypto)과 Node가 글자 하나까지 같은 값을 만들어야 한다. */
export function signaturePayload(timestamp: string, rawBody: string): string {
  return `${timestamp}.POST.${COLLECT_DISPATCH_PATH}.${rawBody}`
}

export function signDispatchRequest(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(signaturePayload(timestamp, rawBody), "utf8").digest("hex")
}

export type SignatureCheck = {
  readonly secret: string
  readonly timestamp: string | null
  readonly signature: string | null
  readonly rawBody: string
  readonly nowMs: number
}

/**
 * 서명 검증. 어떤 이유로 거절됐는지는 호출자에게도 알려주지 않는다(전부 false).
 * timestamp는 epoch 초의 10진 정수 문자열만 받는다.
 */
export function verifyDispatchSignature({ secret, timestamp, signature, rawBody, nowMs }: SignatureCheck): boolean {
  if (secret.length < 32 || timestamp === null || signature === null) return false
  if (!/^[0-9]{10}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) return false
  const sentAtMs = Number(timestamp) * 1000
  if (nowMs - sentAtMs > SIGNATURE_MAX_AGE_MS || sentAtMs - nowMs > SIGNATURE_MAX_FUTURE_MS) return false
  const expected = Buffer.from(signDispatchRequest(secret, timestamp, rawBody), "hex")
  const presented = Buffer.from(signature, "hex")
  return expected.length === presented.length && timingSafeEqual(expected, presented)
}

export type CollectDispatchEnvironment =
  | { readonly ok: true; readonly signingSecret: string; readonly githubToken: string }
  | { readonly ok: false; readonly blockedBy: "missing-env" | "not-production" }

/** Production에서만 동작한다. 빈 값은 미설정과 같다. */
export function resolveCollectDispatchEnvironment(env: Record<string, string | undefined>): CollectDispatchEnvironment {
  if (env["VERCEL_ENV"] !== "production") return { ok: false, blockedBy: "not-production" }
  const signingSecret = env["COLLECT_DISPATCH_SIGNING_SECRET"] ?? ""
  const githubToken = env["COLLECT_GITHUB_TOKEN"] ?? ""
  const required = [env["NEXT_PUBLIC_SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"], signingSecret, githubToken]
  if (required.some((value) => value === undefined || value === "")) return { ok: false, blockedBy: "missing-env" }
  return { ok: true, signingSecret, githubToken }
}

/**
 * workflow_dispatch 입력. 쓰기 여부는 mode에서만 나온다 — 알 수 없는 mode는 dry-run으로 닫는다.
 * 어디서부터 수집할지는 넣지 않는다(시트의 SYSTEM 큐 위치가 정한다).
 */
export function workflowInputs(mode: CollectDispatchMode, dispatchId: string): Record<string, string> {
  return {
    ...COLLECT_DISPATCH_INPUTS,
    dry_run: mode === "live" ? "false" : "true",
    dispatch_id: dispatchId,
  }
}

export function httpStatusForOutcome(outcome: CollectDispatchOutcome): number {
  switch (outcome.kind) {
    case "unauthorized":
      return 401
    case "conflict":
      return 409
    case "noop":
      return 200
    case "sent":
      return 202
    case "rejected":
    case "unknown":
      return 502
    case "failed":
      return 500
  }
}

/**
 * 응답 본문. pg_net이 응답을 몇 시간 보관하므로 여기에는 허용한 필드만 싣는다 —
 * 토큰·서명·GitHub 오류 원문은 어떤 경우에도 들어가지 않는다.
 */
export function safeResponseBody(outcome: CollectDispatchOutcome): Record<string, string | number | null> {
  switch (outcome.kind) {
    case "unauthorized":
    case "failed":
      return { result: outcome.kind }
    case "conflict":
    case "noop":
      return { result: outcome.kind, reason: outcome.reason }
    case "sent":
      return { result: "sent", slot: outcome.slot, mode: outcome.mode, runId: outcome.runId }
    case "rejected":
      return { result: "rejected", slot: outcome.slot, httpStatus: outcome.httpStatus }
    case "unknown":
      return { result: "unknown", slot: outcome.slot }
  }
}
