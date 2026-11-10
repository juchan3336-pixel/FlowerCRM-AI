// Enrich 외부 예약 dispatch — 순수 정책 (I/O 없음).
//
// GitHub의 schedule 트리거가 이 저장소에서 대부분 실행되지 않아(2026-11-10: 90분 cron을 켠 뒤
// 5시간 반 동안 0회), Supabase Cron이 이 endpoint를 부르고 endpoint가 workflow_dispatch를 보낸다.
// 요청자가 정할 수 있는 것은 "지금 한 번 시도하라"뿐이다. 저장소·워크플로·ref·행 수·쓰기 여부는
// 전부 서버가 고정하고, 쓰기 여부는 DB의 제어 행(mode)만 결정한다.
import { createHmac, timingSafeEqual } from "node:crypto"

export const ENRICH_DISPATCH_PATH = "/api/enrich/dispatch"
export const ENRICH_DISPATCH_TIMESTAMP_HEADER = "x-enrich-dispatch-timestamp"
export const ENRICH_DISPATCH_SIGNATURE_HEADER = "x-enrich-dispatch-signature"

export const ENRICH_REPOSITORY = { owner: "juchan3336-pixel", repo: "FlowerCRM-AI", workflow: "enrich.yml", ref: "main" } as const
export const ENRICH_DISPATCH_LIMIT = "50"

/** 한 slot = UTC 기준 90분. slot마다 dispatch는 최대 1회이고, 지나간 slot은 보충하지 않는다. */
export const ENRICH_SLOT_MS = 90 * 60 * 1000
/** 서명 유효 시간. 과거 5분, 미래 1분(시계 오차)까지만 받는다. */
export const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000
export const SIGNATURE_MAX_FUTURE_MS = 60 * 1000

/** 같은 워크플로에 이 상태의 run이 하나라도 있으면 이번 slot은 건너뛴다. */
export const BUSY_RUN_STATUSES = ["queued", "in_progress", "requested", "waiting", "pending"] as const

export type EnrichDispatchMode = "dry_run" | "live"

export type EnrichDispatchOutcome =
  | { readonly kind: "unauthorized" }
  | { readonly kind: "conflict"; readonly reason: "missing-env" | "not-production" }
  | { readonly kind: "noop"; readonly reason: "disabled" | "duplicate-slot" | "busy" | "blocked-unknown" | "check-failed" }
  | { readonly kind: "sent"; readonly slot: string; readonly mode: EnrichDispatchMode; readonly runId: number | null }
  | { readonly kind: "rejected"; readonly slot: string; readonly httpStatus: number }
  | { readonly kind: "unknown"; readonly slot: string }
  | { readonly kind: "failed" }

export function slotForTime(nowMs: number): string {
  return new Date(Math.floor(nowMs / ENRICH_SLOT_MS) * ENRICH_SLOT_MS).toISOString()
}

/** 서명 대상 문자열. SQL(pgcrypto)과 Node가 글자 하나까지 같은 값을 만들어야 한다. */
export function signaturePayload(timestamp: string, rawBody: string): string {
  return `${timestamp}.POST.${ENRICH_DISPATCH_PATH}.${rawBody}`
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

export type EnrichDispatchEnvironment =
  | { readonly ok: true; readonly signingSecret: string; readonly githubToken: string }
  | { readonly ok: false; readonly blockedBy: "missing-env" | "not-production" }

/** Production에서만 동작한다. 빈 값은 미설정과 같다. */
export function resolveEnrichDispatchEnvironment(env: Record<string, string | undefined>): EnrichDispatchEnvironment {
  if (env["VERCEL_ENV"] !== "production") return { ok: false, blockedBy: "not-production" }
  const signingSecret = env["ENRICH_DISPATCH_SIGNING_SECRET"] ?? ""
  const githubToken = env["ENRICH_GITHUB_TOKEN"] ?? ""
  const required = [env["NEXT_PUBLIC_SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"], signingSecret, githubToken]
  if (required.some((value) => value === undefined || value === "")) return { ok: false, blockedBy: "missing-env" }
  return { ok: true, signingSecret, githubToken }
}

/**
 * workflow_dispatch 입력. 쓰기 여부는 mode에서만 나온다 — 알 수 없는 mode는 dry-run으로 닫는다.
 * start_row는 넣지 않는다(시트의 SYSTEM 커서가 정한다).
 */
export function workflowInputs(mode: EnrichDispatchMode, dispatchId: string): Record<string, string> {
  return {
    limit: ENRICH_DISPATCH_LIMIT,
    dry_run: mode === "live" ? "false" : "true",
    from_start: "false",
    dispatch_id: dispatchId,
  }
}

export function httpStatusForOutcome(outcome: EnrichDispatchOutcome): number {
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
export function safeResponseBody(outcome: EnrichDispatchOutcome): Record<string, string | number | null> {
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
