// 승인 Batch 자동 실행 v1 — 실행 정책 순수 계층 (PR-B).
// 환경 게이트·응답 매핑·self-chain 상한 판정만 담는다 (DB·네트워크 없음 → 단위 테스트 가능).
// 실제 오케스트레이션은 approval-execution-service, HTTP 배선은 app/api/batch/execute/route.ts.
import { timingSafeEqual } from "node:crypto"

import { CHAIN_SECRET_MIN_LENGTH } from "./approval-policy"

// Vercel 엣지가 Deployment Protection에서 이미 검증하지만, 미들웨어 밖 endpoint라 방어적으로 한 번 더 확인한다.
export function verifyBypassHeader(headerValue: string | null, bypassSecret: string): boolean {
  if (headerValue === null || bypassSecret.length === 0) {
    return false
  }
  const provided = Buffer.from(headerValue, "utf8")
  const expected = Buffer.from(bypassSecret, "utf8")
  if (provided.length !== expected.length) {
    return false
  }
  return timingSafeEqual(provided, expected)
}

// Authorization: Bearer <token> 에서 토큰만 추출.
export function extractBearerToken(authorizationHeader: string | null): string | null {
  if (authorizationHeader === null) {
    return null
  }
  const match = /^Bearer\s+(.+)$/.exec(authorizationHeader.trim())
  return match?.[1]?.trim() ?? null
}

// 실행 endpoint가 코드상 요구하는 환경변수 (이번 PR은 값을 설정하지 않는다 — 게이트만 구현).
export type ExecuteEnvironment = {
  readonly VERCEL_ENV?: string | undefined
  readonly AI_PROVIDER?: string | undefined
  readonly OPENAI_API_KEY?: string | undefined
  readonly OPENAI_MODEL?: string | undefined
  readonly BATCH_CHAIN_SECRET?: string | undefined
  readonly PREVIEW_EXEC_BASE_URL?: string | undefined
  readonly VERCEL_AUTOMATION_BYPASS_SECRET?: string | undefined
}

export type ExecuteEnvironmentBlock =
  | "production-blocked" // Production 배포에서는 자동 실행을 하드 거부한다 (AI_PROVIDER=fake 유지 원칙).
  | "provider-not-openai" // fake·미설정 provider면 거부 (실데이터 오염 방지).
  | "chain-secret-missing" // BATCH_CHAIN_SECRET 미설정·32자 미만.
  | "base-url-missing" // PREVIEW_EXEC_BASE_URL 미설정.
  | "bypass-secret-missing" // VERCEL_AUTOMATION_BYPASS_SECRET 미설정 (self-chain 헤더에 필요).

export type ExecuteEnvironmentDecision =
  | { readonly ok: true; readonly chainSecret: string; readonly baseUrl: string; readonly bypassSecret: string }
  | { readonly ok: false; readonly blockedBy: ExecuteEnvironmentBlock }

// PREVIEW_EXEC_BASE_URL은 승인된 Preview 고정 별칭만 허용한다 (SSRF·오배선 방지).
// vercel.app 서브도메인이거나 localhost(개발)만 통과.
export function isAllowedExecBaseUrl(rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    return false
  }
  if (url.hostname === "localhost") {
    return true
  }
  return url.hostname.endsWith(".vercel.app")
}

export function resolveExecuteEnvironment(env: ExecuteEnvironment): ExecuteEnvironmentDecision {
  if (env.VERCEL_ENV === "production") {
    return { ok: false, blockedBy: "production-blocked" }
  }
  if (env.AI_PROVIDER?.trim().toLowerCase() !== "openai") {
    return { ok: false, blockedBy: "provider-not-openai" }
  }
  const chainSecret = env.BATCH_CHAIN_SECRET?.trim() ?? ""
  if (chainSecret.length < CHAIN_SECRET_MIN_LENGTH) {
    return { ok: false, blockedBy: "chain-secret-missing" }
  }
  const baseUrl = env.PREVIEW_EXEC_BASE_URL?.trim() ?? ""
  if (baseUrl.length === 0 || !isAllowedExecBaseUrl(baseUrl)) {
    return { ok: false, blockedBy: "base-url-missing" }
  }
  const bypassSecret = env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() ?? ""
  if (bypassSecret.length === 0) {
    return { ok: false, blockedBy: "bypass-secret-missing" }
  }
  return { ok: true, chainSecret, baseUrl, bypassSecret }
}

// self-chain 무한루프 방어 상한 — 승인 장소 수 기준.
// 한 tick당 item 1건이며 repeat:faq 제어 재시도는 한 tick 내부에서 처리되므로 추가 tick을 만들지 않는다.
// 여유 2를 더해 activate(tick 0→1) + 장소별 tick + finalize 여지를 확보한다.
export function maxTicksFor(placeCount: number): number {
  return placeCount + 2
}

export function isTickWithinLimit(tick: number, placeCount: number): boolean {
  return Number.isInteger(tick) && tick >= 0 && tick <= maxTicksFor(placeCount)
}

// ── 요청 파싱 ────────────────────────────────────────────────────
export type ParsedExecuteRequest =
  | { readonly mode: "activate" }
  | { readonly mode: "tick"; readonly approvalId: string; readonly tick: number }
  | { readonly mode: "invalid" }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseExecuteRequest(body: unknown): ParsedExecuteRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { mode: "invalid" }
  }
  const record = body as Record<string, unknown>
  if (record["mode"] === "activate") {
    return { mode: "activate" }
  }
  if (record["mode"] === "tick") {
    const approvalId = record["approvalId"]
    const tick = record["tick"]
    if (typeof approvalId === "string" && UUID_PATTERN.test(approvalId) && typeof tick === "number" && Number.isInteger(tick) && tick >= 0) {
      return { mode: "tick", approvalId, tick }
    }
  }
  return { mode: "invalid" }
}

// ── 실행 결과 → HTTP 응답 매핑 ────────────────────────────────────
// 응답 본문에는 secret·token 원문·환경변수·stack trace를 절대 넣지 않는다 (안전 코드만).
export type ExecuteOutcome =
  | { readonly kind: "processed"; readonly done: boolean; readonly approvalStatus: string } // 200
  | { readonly kind: "completed"; readonly approvalStatus: "completed" } // 200
  | { readonly kind: "noop"; readonly reason: string } // 200 — 중복·지연 tick 등 무해한 no-op
  | { readonly kind: "unauthorized"; readonly reason: string } // 401
  | { readonly kind: "conflict"; readonly reason: string } // 409 — 상태·CAS·환경 게이트
  | { readonly kind: "expired" } // 410
  | { readonly kind: "failed"; readonly errorCode: string } // 500

export function httpStatusForOutcome(outcome: ExecuteOutcome): number {
  switch (outcome.kind) {
    case "processed":
    case "completed":
    case "noop":
      return 200
    case "unauthorized":
      return 401
    case "conflict":
      return 409
    case "expired":
      return 410
    case "failed":
      return 500
  }
}

// 응답 본문 — 진단 가능한 안전 필드만.
export function safeResponseBody(outcome: ExecuteOutcome): Record<string, string | boolean> {
  switch (outcome.kind) {
    case "processed":
      return { ok: true, done: outcome.done, approvalStatus: outcome.approvalStatus }
    case "completed":
      return { ok: true, done: true, approvalStatus: "completed" }
    case "noop":
      return { ok: true, noop: true, reason: outcome.reason }
    case "unauthorized":
      return { ok: false, reason: outcome.reason }
    case "conflict":
      return { ok: false, reason: outcome.reason }
    case "expired":
      return { ok: false, reason: "approval-expired" }
    case "failed":
      return { ok: false, errorCode: outcome.errorCode }
  }
}
