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

// 운영 자동 실행에서 self-chain을 보낼 수 있는 유일한 고정 Preview 별칭.
// endsWith(".vercel.app")·wildcard가 아니라 이 hostname과 정확히 일치할 때만 허용한다
// (환경변수 오설정만으로 bypass secret·chain token이 다른 vercel.app 배포로 전달되는 것을 코드 계층에서 차단).
export const ALLOWED_EXEC_BASE_HOSTNAME = "flowercrm-seo-git-preview-latest-juchans-projects-ecbdf050.vercel.app"
export const ALLOWED_EXEC_BASE_URL = `https://${ALLOWED_EXEC_BASE_HOSTNAME}`

// PREVIEW_EXEC_BASE_URL은 고정 Preview 별칭 하나로 정확히 pin한다.
// userinfo·port·query·hash·추가 path를 전부 거부하고, https + hostname exact만 통과한다.
// localhost는 배포 환경(VERCEL_ENV=preview|production)에서는 절대 허용하지 않으며,
// 로컬/테스트에서만 allowLocalhost 옵션으로 예외 허용한다.
export function isAllowedExecBaseUrl(rawUrl: string, options?: Readonly<{ allowLocalhost?: boolean }>): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  // 공통 하드닝 — 자격정보(userinfo)·쿼리·해시 금지, path는 빈 문자열 또는 "/"만.
  if (url.username !== "" || url.password !== "") {
    return false
  }
  if (url.search !== "" || url.hash !== "") {
    return false
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    return false
  }
  // 로컬/테스트 전용 예외 — 배포 환경에서는 호출부가 allowLocalhost=false로 차단한다.
  if (options?.allowLocalhost === true && url.protocol === "http:" && url.hostname === "localhost") {
    return true
  }
  // 운영: https + 고정 별칭 hostname exact, 포트 없음.
  if (url.protocol !== "https:" || url.port !== "") {
    return false
  }
  return url.hostname === ALLOWED_EXEC_BASE_HOSTNAME
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
  // 배포 환경(Vercel preview/production)에서는 localhost를 절대 허용하지 않는다 — 로컬/테스트에서만 예외.
  const allowLocalhost = env.VERCEL_ENV !== "preview" && env.VERCEL_ENV !== "production"
  if (baseUrl.length === 0 || !isAllowedExecBaseUrl(baseUrl, { allowLocalhost })) {
    return { ok: false, blockedBy: "base-url-missing" }
  }
  const bypassSecret = env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() ?? ""
  if (bypassSecret.length === 0) {
    return { ok: false, blockedBy: "bypass-secret-missing" }
  }
  return { ok: true, chainSecret, baseUrl, bypassSecret }
}

// 폭주 방어 상한 — 승인 장소 수 기준. 한 pump 호출당 item 1건이며 repeat:faq 제어 재시도는
// 그 호출 안에서 처리되므로 추가 호출을 만들지 않는다. 여유 2를 더해 finalize 여지를 확보한다.
// self-chain이 없어진 뒤에도 유지한다 — Cron이 같은 승인을 무한히 집어가는 것을 막는 안전핀이다.
export function maxTicksFor(placeCount: number): number {
  return placeCount + 2
}

export function isTickWithinLimit(tick: number, placeCount: number): boolean {
  return Number.isInteger(tick) && tick >= 0 && tick <= maxTicksFor(placeCount)
}

// ── pump 실행 정책 ───────────────────────────────────────────────
// 다음 item은 이 함수가 자기를 호출해서가 아니라, 외부 스케줄러(Supabase Cron)가 다시 불러서 진행된다.
// 그래서 이 파일에는 발사(fetch) 관련 정책이 없다 — Batch 자동 실행 경로의 self-fetch를 완전히 제거했다.

// lease 유효시간. generation 1건 실측은 8.5~15.2초지만, tick 내부 repeat:faq 재생성이 붙으면 2회가 되고
// 콜드스타트까지 겹칠 수 있다. 최악 추정(15초 × 2 + 콜드스타트 5초 = 35초)의 3배 이상으로 잡는다.
export const BATCH_PUMP_LEASE_SECONDS = 120
// Cron 호출 주기. 화면의 "다음 자동 생성 대기" 안내 기준으로도 쓴다.
export const BATCH_PUMP_INTERVAL_SECONDS = 60
// 정상 대기(생성 15초 + Cron 대기 60초)를 지연으로 오인하지 않기 위한 기준.
export const BATCH_PUMP_DELAY_WARN_MS = (BATCH_PUMP_LEASE_SECONDS + BATCH_PUMP_INTERVAL_SECONDS) * 1000

export type BatchPumpEnvironment = ExecuteEnvironment & { readonly BATCH_PUMP_SECRET?: string | undefined }

export type BatchPumpEnvironmentBlock = ExecuteEnvironmentBlock | "pump-secret-missing"

export type BatchPumpEnvironmentDecision =
  | { readonly ok: true; readonly bypassSecret: string; readonly pumpSecret: string }
  | { readonly ok: false; readonly blockedBy: BatchPumpEnvironmentBlock }

// pump는 실행 endpoint와 완전히 같은 자격 요건을 요구하고, 스케줄러 전용 시크릿 하나만 더 받는다.
// Production 하드 거부·OpenAI 전용·고정 Preview 별칭 pin이 그대로 유지된다.
export function resolveBatchPumpEnvironment(env: BatchPumpEnvironment): BatchPumpEnvironmentDecision {
  const base = resolveExecuteEnvironment(env)
  if (!base.ok) {
    return { ok: false, blockedBy: base.blockedBy }
  }
  const pumpSecret = env.BATCH_PUMP_SECRET?.trim() ?? ""
  if (pumpSecret.length === 0) {
    return { ok: false, blockedBy: "pump-secret-missing" }
  }
  return { ok: true, bypassSecret: base.bypassSecret, pumpSecret }
}

// 스케줄러 시크릿 비교 — bypass 헤더와 같은 상수시간 비교를 쓴다.
export function verifyPumpSecret(candidate: string | null, expected: string): boolean {
  return candidate !== null && candidate.length > 0 && verifyBypassHeader(candidate, expected)
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
  // activate는 batch 생성·연결까지만 하고 즉시 접수를 반환한다. item 처리는 pump가 맡는다.
  // (동기 처리 후 응답하면 생성 시간이 호출자 timeout을 넘겨 "실패"로 오분류된다 — PR-D.)
  | { readonly kind: "accepted"; readonly approvalStatus: "running" } // 202
  | { readonly kind: "processed"; readonly done: boolean; readonly approvalStatus: string } // 200
  | { readonly kind: "completed"; readonly approvalStatus: "completed" } // 200
  | { readonly kind: "noop"; readonly reason: string } // 200 — 중복·지연 tick 등 무해한 no-op
  | { readonly kind: "unauthorized"; readonly reason: string } // 401
  | { readonly kind: "conflict"; readonly reason: string } // 409 — 상태·CAS·환경 게이트
  | { readonly kind: "expired" } // 410
  | { readonly kind: "failed"; readonly errorCode: string } // 500

export function httpStatusForOutcome(outcome: ExecuteOutcome): number {
  switch (outcome.kind) {
    case "accepted":
      return 202
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
    case "accepted":
      return { ok: true, accepted: true, done: false, approvalStatus: "running" }
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
