// Google Sheets 증분 동기화 자동 연속 처리 — 순수 정책 계층.
// 커서 계산·상한 판정·토큰 파생·응답 매핑만 담는다 (DB·네트워크·Google API 없음 → 단위 테스트 가능).
// 오케스트레이션은 job-service, HTTP 배선·self-chain은 app/api/sync/chain/route.ts.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

import type { SyncJobStatus, SyncSessionStopReason } from "../domain/constants"

export type { SyncJobStatus }
// migration의 session_stop_reason CHECK와 단일 출처를 공유한다.
export type SessionStopReason = SyncSessionStopReason

// 시트 1행은 헤더, 2행이 첫 데이터 행이다. 코드 전체가 이 1-base 행 번호를 쓴다.
export const FIRST_DATA_ROW_NUMBER = 2
// 배치 크기는 기존 동작을 그대로 유지한다 — 이번 변경은 "자동으로 이어서"이지 "한 번에 더 많이"가 아니다.
export const SYNC_JOB_BATCH_SIZE = 50

// ── 무한 실행 방어 상한 ──────────────────────────────────────────
// 세 후보(100 배치 / 5,000행 / 15분) 중 이 구조에 맞는 기준:
//  · 배치 수와 행 수는 batch_size=50에서 서로 같은 제약이라 하나로 합친다 (100 × 50 = 5,000).
//    job 행에 batch_index가 이미 있어 추가 상태 없이 강제할 수 있고, 시트가 계속 늘어나도 결정적이다.
//  · 15분 벽시계는 self-chain 구조에서 신뢰할 수 없다 — tick마다 함수 실행이 새로 뜨고, 콜드스타트·
//    Google API 지연으로 같은 행 수가 3분도 30분도 될 수 있어 "몇 건 처리했나"와 상관이 끊긴다.
//    대신 정체 감지(STALE_TICK_MS)로 쓴다 — 상한이 아니라 재개 판단 기준이다.
export const SYNC_JOB_MAX_BATCHES = 100
export const SYNC_JOB_MAX_ROWS = SYNC_JOB_MAX_BATCHES * SYNC_JOB_BATCH_SIZE
// 마지막 tick 이후 이 시간이 지나면 chain이 끊긴 것으로 보고 재개 대상으로 표시한다.
export const STALE_TICK_MS = 5 * 60 * 1000

// ── 세션 전역 안전 상한 ─────────────────────────────────────────
// job 1개는 5,000행에서 끊기지만, 잔여가 남아 있으면 서버가 후속 job을 자동으로 만든다.
// 사용자는 시작 버튼을 한 번만 누르고, 정상적인 대량 backlog는 끝까지 자동 진행된다.
// 아래 값들은 그 자동 진행을 언제 멈출지 정한다 (운영 규모 기준 산정 근거는 각 항목 주석 참조).

// 최초 사용자 시작 job(chain_index=0) + 자동 후속 9개 = 세션 10 job = 정확히 50,000행.
// 현재 시트는 약 15,000행(places 14,951)이라 백지 상태에서 전량 따라잡아도 3 job이면 끝난다.
// 50,000행은 그 3.3배 여유이며, 상한 두 개(job 수·행 수)가 같은 지점에서 동시에 걸리도록 맞췄다.
export const SYNC_SESSION_MAX_AUTO_JOBS = 9
export const SYNC_SESSION_MAX_ROWS = (SYNC_SESSION_MAX_AUTO_JOBS + 1) * SYNC_JOB_MAX_ROWS
// 동일 오류가 연속 3회면 자동 진행을 멈춘다 — 같은 원인으로 1,000 tick을 태우지 않기 위함.
export const SYNC_SESSION_MAX_CONSECUTIVE_ERRORS = 3
// 세션 누적 경과 상한. 50,000행 = 1,000 batch이고 tick당 넉넉히 10초로 잡아도 약 2.8시간이라,
// 6시간은 2배 이상 여유다. 이를 넘기면 어딘가 정체된 것으로 보고 interrupted로 닫는다.
export const SYNC_SESSION_MAX_ELAPSED_MS = 6 * 60 * 60 * 1000
// 잔여 0을 연속 2회 확인해야 완료로 닫는다 — 마지막 tick과 시트 추가 사이의 경합을 흡수한다.
export const SYNC_ZERO_REMAINING_CONFIRMATIONS = 2
// 시트 마지막 행 재확인 주기(batch 수). 매 tick 확인하면 첫 열 조회가 batch 수만큼 늘어나므로,
// 창이 소진됐을 때는 즉시 확인하고 그 외에는 이 주기로만 확인한다.
export const SHEET_LAST_ROW_RECHECK_EVERY_BATCHES = 5

export const ACTIVE_SYNC_JOB_STATUSES: readonly SyncJobStatus[] = ["queued", "running"]
// 잔여가 남은 채 멈춘 상태 — 사용자가 "이어서 진행" 1회로 재개할 수 있다.
export const RESUMABLE_SYNC_JOB_STATUSES: readonly SyncJobStatus[] = ["partial_completed", "interrupted", "failed"]

export function isTerminalSyncJobStatus(status: SyncJobStatus): boolean {
  return status !== "queued" && status !== "running"
}

// ── 커서 ─────────────────────────────────────────────────────────
// 시트 행 배열 길이 → 마지막 데이터 행 번호. 데이터가 0행이면 헤더 행(1)이 마지막이다.
export function lastSheetRowNumber(rowCount: number): number {
  return Math.max(0, Math.trunc(rowCount)) + FIRST_DATA_ROW_NUMBER - 1
}

// places의 max(source_row_number) → 다음에 처리할 행. 아직 아무것도 없으면 첫 데이터 행부터.
export function firstUnsyncedRowNumber(latestSourceRowNumber: number | null | undefined): number {
  return latestSourceRowNumber === null || latestSourceRowNumber === undefined
    ? FIRST_DATA_ROW_NUMBER
    : Math.max(FIRST_DATA_ROW_NUMBER, latestSourceRowNumber + 1)
}

export function remainingRowCount(currentRow: number, latestSheetRow: number): number {
  return Math.max(0, latestSheetRow - currentRow + 1)
}

export type BatchWindow = {
  readonly startRow: number
  // slice에 넘길 0-base 인덱스 (startRow - FIRST_DATA_ROW_NUMBER)
  readonly startIndex: number
  readonly count: number
}

// 이번 tick이 읽을 창. 잔여보다 크게 잡지 않고, 남은 상한도 넘지 않는다.
export function computeBatchWindow(
  input: Readonly<{ currentRow: number; latestSheetRow: number; batchSize: number; processedCount: number }>,
): BatchWindow {
  const remaining = remainingRowCount(input.currentRow, input.latestSheetRow)
  const budget = Math.max(0, SYNC_JOB_MAX_ROWS - input.processedCount)
  return {
    startRow: input.currentRow,
    startIndex: input.currentRow - FIRST_DATA_ROW_NUMBER,
    count: Math.min(input.batchSize, remaining, budget),
  }
}

// ── 다음 단계 판정 ───────────────────────────────────────────────
export type NextStep =
  // 이번 tick에서 window만큼 처리한다.
  | { readonly kind: "process"; readonly window: BatchWindow }
  // 잔여 0 — 정상 완료.
  | { readonly kind: "completed" }
  // 상한 도달 — 잔여가 남았지만 여기서 끊고 재개 가능 상태로 남긴다.
  | { readonly kind: "limit-reached"; readonly remaining: number }

export function decideNextStep(
  input: Readonly<{ currentRow: number; latestSheetRow: number; batchSize: number; batchIndex: number; processedCount: number }>,
): NextStep {
  const remaining = remainingRowCount(input.currentRow, input.latestSheetRow)
  if (remaining === 0) {
    return { kind: "completed" }
  }
  if (input.batchIndex >= SYNC_JOB_MAX_BATCHES || input.processedCount >= SYNC_JOB_MAX_ROWS) {
    return { kind: "limit-reached", remaining }
  }
  return { kind: "process", window: computeBatchWindow(input) }
}

// 창이 소진됐으면 시트를 즉시 다시 확인해야 잔여 판정이 맞는다.
// 그 외에는 주기적으로만 확인한다 — 첫 열 조회가 batch 수만큼 늘어나는 것을 막는다.
export function shouldRecheckSheetLastRow(input: Readonly<{ currentRow: number; latestSheetRow: number; batchIndex: number }>): boolean {
  if (remainingRowCount(input.currentRow, input.latestSheetRow) === 0) {
    return true
  }
  return input.batchIndex % SHEET_LAST_ROW_RECHECK_EVERY_BATCHES === 0
}

// ── 세션 자동 진행 판정 ─────────────────────────────────────────
// job 하나가 상한에 닿았을 때, 세션 차원에서 후속 job을 만들어도 되는지 정한다.
export type SessionState = {
  readonly autoJobCount: number // 지금까지 만들어진 자동 후속 job 수 (root 제외)
  readonly sessionProcessed: number // 세션 누적 처리 행 수
  readonly sessionStartedAt: string
  readonly consecutiveErrors: number
  readonly cancelRequested: boolean
  readonly maxAutoJobs: number
}

export type SessionContinuation =
  | { readonly kind: "continue" }
  | { readonly kind: "stop"; readonly reason: SessionStopReason }

export function decideSessionContinuation(state: SessionState, nowIso: string): SessionContinuation {
  // 사용자 취소가 최우선 — 취소한 세션은 후속 job을 절대 만들지 않는다.
  if (state.cancelRequested) {
    return { kind: "stop", reason: "cancelled" }
  }
  if (state.consecutiveErrors >= SYNC_SESSION_MAX_CONSECUTIVE_ERRORS) {
    return { kind: "stop", reason: "session-error-limit" }
  }
  if (state.autoJobCount >= state.maxAutoJobs) {
    return { kind: "stop", reason: "session-job-limit" }
  }
  if (state.sessionProcessed >= SYNC_SESSION_MAX_ROWS) {
    return { kind: "stop", reason: "session-row-limit" }
  }
  if (sessionElapsedMs(state.sessionStartedAt, nowIso) >= SYNC_SESSION_MAX_ELAPSED_MS) {
    return { kind: "stop", reason: "session-time-limit" }
  }
  return { kind: "continue" }
}

export function sessionElapsedMs(sessionStartedAtIso: string, nowIso: string): number {
  const started = Date.parse(sessionStartedAtIso)
  const now = Date.parse(nowIso)
  return Number.isFinite(started) && Number.isFinite(now) ? Math.max(0, now - started) : 0
}

// 전역 상한으로 멈춘 세션만 사용자 재개가 필요하다 — 그 외 정상 backlog는 자동으로 이어진다.
export const SESSION_STOP_MESSAGES: Readonly<Record<SessionStopReason, string>> = {
  cancelled: "사용자 중단 요청으로 자동 연속 동기화를 멈췄습니다. 처리된 분량은 그대로 유지됩니다.",
  "session-job-limit": `한 번의 시작으로 진행할 수 있는 작업 수(${String(SYNC_SESSION_MAX_AUTO_JOBS + 1)}개) 상한에 도달해 멈췄습니다. 잔여분은 다시 시작해 주세요.`,
  "session-row-limit": `한 번의 시작으로 처리할 수 있는 행 수(${SYNC_SESSION_MAX_ROWS.toLocaleString("ko-KR")}행) 상한에 도달해 멈췄습니다. 잔여분은 다시 시작해 주세요.`,
  "session-error-limit": "같은 오류가 연속으로 반복돼 자동 진행을 멈췄습니다. 원인을 확인한 뒤 다시 시작해 주세요.",
  "session-time-limit": "자동 연속 동기화가 허용 시간을 넘겨 멈췄습니다. 잔여분은 다시 시작해 주세요.",
}

// ── 행번호 축소 감지 (row-number drift) ─────────────────────────
// 증분 동기화의 시작점은 "이미 반영된 마지막 시트 행" 다음이다. 그런데 시트에서 행이 삭제·이동되면
// 그 기록이 현재 시트보다 뒤로 밀려, 커서가 시트 끝을 앞질러 버린다.
// 그 상태로 실행하면 잔여가 0으로 계산돼 "미동기화 없음"으로 조용히 끝나지만, 실제로는 그 뒤에
// 붙는 신규 행이 커서에 닿을 때까지 통째로 건너뛰어진다 (2026-07-29 공백행 6개 삭제 사고).
//
// 그래서 "기록이 시트 끝보다 크다"를 실행 전 차단 조건으로 삼는다. 정상 완료와 절대 섞이면 안 된다.
export type RowNumberDrift = {
  readonly latestSheetRow: number
  readonly maxSourceRowNumber: number
  readonly difference: number
}

export type RowNumberDriftDecision = { readonly kind: "ok" } | { readonly kind: "drift"; readonly drift: RowNumberDrift }

export function detectRowNumberDrift(
  input: Readonly<{ latestSheetRow: number; maxSourceRowNumber: number | null | undefined }>,
): RowNumberDriftDecision {
  const maxSourceRowNumber = input.maxSourceRowNumber
  if (maxSourceRowNumber === null || maxSourceRowNumber === undefined) {
    return { kind: "ok" }
  }
  if (maxSourceRowNumber <= input.latestSheetRow) {
    return { kind: "ok" }
  }
  return {
    kind: "drift",
    drift: { latestSheetRow: input.latestSheetRow, maxSourceRowNumber, difference: maxSourceRowNumber - input.latestSheetRow },
  }
}

export const ROW_NUMBER_DRIFT_CODE = "row-number-drift"

// 사용자 안내 — 원인·수치·다음 행동만. 내부 코드·stack trace·secret은 담지 않는다.
export function rowNumberDriftMessage(drift: RowNumberDrift): string {
  return `Google Sheets 행 수가 기존 동기화 기록보다 적습니다. 시트에서 행이 삭제되거나 이동된 것으로 보입니다. 행번호 정합성을 복구한 뒤 다시 동기화해 주세요. (Sheet 마지막 행 ${String(drift.latestSheetRow)} / 기록된 최대 행 ${String(drift.maxSourceRowNumber)} / 차이 ${String(drift.difference)}행)`
}

export function isStaleTick(lastTickAtIso: string | null, nowIso: string, staleMs: number = STALE_TICK_MS): boolean {
  if (lastTickAtIso === null) {
    return false
  }
  const last = Date.parse(lastTickAtIso)
  const now = Date.parse(nowIso)
  return Number.isFinite(last) && Number.isFinite(now) && now - last >= staleMs
}

// ── self-chain 1회용 토큰 ────────────────────────────────────────
// 정적 chain secret(환경변수)을 쓰지 않는다 — 이 기능은 Production에서 돌아야 하는데
// 새 환경변수를 요구하면 배포 설정 변경 없이는 동작하지 않는다. 대신 tick마다 토큰을 새로 발급하고
// job 행에는 sha256만 남긴다. 원문은 self-chain fetch 헤더로만 전달되고 어디에도 저장되지 않는다.
// 성공한 tick은 즉시 토큰을 회전시키므로 같은 토큰의 재사용(중복·지연 chain)은 hash 불일치 → no-op.
export type MintedTickToken = { readonly token: string; readonly tokenHash: string }

export function mintTickToken(): MintedTickToken {
  const token = randomBytes(32).toString("base64url")
  return { token, tokenHash: hashTickToken(token) }
}

export function hashTickToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

export function verifyTickToken(candidateToken: string, storedTokenHash: string | null): boolean {
  if (storedTokenHash === null || storedTokenHash.length === 0 || candidateToken.length === 0) {
    return false
  }
  const provided = Buffer.from(hashTickToken(candidateToken), "utf8")
  const expected = Buffer.from(storedTokenHash, "utf8")
  if (provided.length !== expected.length) {
    return false
  }
  return timingSafeEqual(provided, expected)
}

// ── self-chain 대상 URL ──────────────────────────────────────────
// 동기화는 운영 DB를 갱신하므로 Production 배포에서 실행된다 (AI 생성용 Preview pin과 반대 방향).
// 대상은 환경변수가 아니라 코드 상수로 고정한다 — 오설정만으로 chain 토큰이 다른 배포로 나가는 경로를 차단한다.
export const SYNC_CHAIN_HOSTNAME = "flowercrm-seo.vercel.app"
export const SYNC_CHAIN_BASE_URL = `https://${SYNC_CHAIN_HOSTNAME}`

export function isAllowedSyncChainBaseUrl(rawUrl: string, options?: Readonly<{ allowLocalhost?: boolean }>): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return false
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    return false
  }
  if (options?.allowLocalhost === true && url.protocol === "http:" && url.hostname === "localhost") {
    return true
  }
  if (url.protocol !== "https:" || url.port !== "") {
    return false
  }
  return url.hostname === SYNC_CHAIN_HOSTNAME
}

export type SyncChainEnvironment = {
  readonly VERCEL_ENV?: string | undefined
  readonly NEXT_PUBLIC_SUPABASE_URL?: string | undefined
  readonly NEXT_PUBLIC_SUPABASE_ANON_KEY?: string | undefined
  readonly SUPABASE_SERVICE_ROLE_KEY?: string | undefined
  readonly GOOGLE_SERVICE_ACCOUNT_JSON?: string | undefined
  readonly GOOGLE_SPREADSHEET_ID?: string | undefined
}

export type SyncChainEnvironmentBlock = "supabase-env-missing" | "google-env-missing"

export type SyncChainEnvironmentDecision =
  | { readonly ok: true; readonly baseUrl: string }
  | { readonly ok: false; readonly blockedBy: SyncChainEnvironmentBlock }

// 자동 연속 동기화는 기존 수동 동기화와 정확히 같은 자격 요건만 요구한다 (신규 환경변수 없음).
export function resolveSyncChainEnvironment(env: SyncChainEnvironment): SyncChainEnvironmentDecision {
  if (
    env.NEXT_PUBLIC_SUPABASE_URL === undefined ||
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY === undefined ||
    env.SUPABASE_SERVICE_ROLE_KEY === undefined
  ) {
    return { ok: false, blockedBy: "supabase-env-missing" }
  }
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON === undefined || env.GOOGLE_SPREADSHEET_ID === undefined) {
    return { ok: false, blockedBy: "google-env-missing" }
  }
  // 대상은 항상 코드 상수다 — 환경변수로 바꿀 수 있는 여지를 두지 않는다.
  return { ok: true, baseUrl: SYNC_CHAIN_BASE_URL }
}

// ── 요청 파싱 ────────────────────────────────────────────────────
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ParsedSyncTickRequest = { readonly mode: "tick"; readonly jobId: string } | { readonly mode: "invalid" }

export function parseSyncTickRequest(body: unknown): ParsedSyncTickRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { mode: "invalid" }
  }
  const record = body as Record<string, unknown>
  const jobId = record["jobId"]
  if (record["mode"] === "tick" && typeof jobId === "string" && UUID_PATTERN.test(jobId)) {
    return { mode: "tick", jobId }
  }
  return { mode: "invalid" }
}

export function extractBearerToken(authorizationHeader: string | null): string | null {
  if (authorizationHeader === null) {
    return null
  }
  const match = /^Bearer\s+(.+)$/.exec(authorizationHeader.trim())
  return match?.[1]?.trim() ?? null
}

// ── 결과 → HTTP 매핑 ─────────────────────────────────────────────
// 응답 본문에는 토큰 원문·시트 내용·환경변수·stack trace를 절대 넣지 않는다.
export type SyncTickOutcome =
  | { readonly kind: "processed"; readonly jobStatus: SyncJobStatus; readonly processed: number; readonly remaining: number }
  | { readonly kind: "completed"; readonly processed: number }
  | { readonly kind: "partial"; readonly processed: number; readonly remaining: number }
  | { readonly kind: "noop"; readonly reason: string }
  | { readonly kind: "unauthorized"; readonly reason: string }
  | { readonly kind: "conflict"; readonly reason: string }
  // 시트가 기록보다 짧아졌다 — 실행을 멈추고 사람이 행번호를 복구해야 한다 (정상 완료 아님).
  | { readonly kind: "row-number-drift"; readonly drift: RowNumberDrift }
  | { readonly kind: "failed"; readonly errorCode: string }

export function httpStatusForSyncOutcome(outcome: SyncTickOutcome): number {
  switch (outcome.kind) {
    case "processed":
    case "completed":
    case "partial":
    case "noop":
      return 200
    case "unauthorized":
      return 401
    case "conflict":
    case "row-number-drift":
      return 409
    case "failed":
      return 500
  }
}

export function safeSyncResponseBody(outcome: SyncTickOutcome): Record<string, string | number | boolean> {
  switch (outcome.kind) {
    case "processed":
      return { ok: true, done: false, jobStatus: outcome.jobStatus, processed: outcome.processed, remaining: outcome.remaining }
    case "completed":
      return { ok: true, done: true, jobStatus: "completed", processed: outcome.processed, remaining: 0 }
    case "partial":
      return { ok: true, done: true, jobStatus: "partial_completed", processed: outcome.processed, remaining: outcome.remaining }
    case "noop":
      return { ok: true, noop: true, reason: outcome.reason }
    case "unauthorized":
      return { ok: false, reason: outcome.reason }
    case "conflict":
      return { ok: false, reason: outcome.reason }
    case "row-number-drift":
      // 수치는 관리자 화면 안내용 — 시트 내용이 아니라 행 번호뿐이다.
      return {
        ok: false,
        reason: ROW_NUMBER_DRIFT_CODE,
        latestSheetRow: outcome.drift.latestSheetRow,
        maxSourceRowNumber: outcome.drift.maxSourceRowNumber,
        difference: outcome.drift.difference,
      }
    case "failed":
      return { ok: false, errorCode: outcome.errorCode }
  }
}
