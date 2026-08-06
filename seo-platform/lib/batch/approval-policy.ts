// 승인 Batch 자동 생성 v1 — 승인 정책 순수 계층 (PR-A).
// 토큰 발급·해시·검증, 상태 전이표, 승인 후보 판정, 승인 스냅샷을 담는다.
// DB 접근·부수효과는 supabase-approval-repository가 담당한다.
//
// 토큰 역할 3분리 (설계 승인 사항):
//  A. Activation token — 승인 Batch 최초 활성화(approved|queued → running) 1회 전용.
//     256-bit 난수이며 DB에는 SHA-256 해시만 저장하고, 활성화 성공 시 즉시 소진된다.
//  B. Vercel Automation Bypass Secret — Preview Deployment Protection 통과 전용.
//     서버 환경변수로만 존재하며 이 코드베이스는 값을 저장·로그하지 않는다 (PR-B에서 헤더로만 사용).
//  C. Chain secret — 활성화 이후 서버→서버 후속 tick 인증 전용 환경변수.
//     Activation token과 다른 값이며, approval_id + execution_tick에 대한 HMAC 파생 토큰으로 검증한다.
//     중복·순서 제어 자체는 execution_tick 조건부 CAS(repository)가 담당한다.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

import { contentModeForCategory } from "@/lib/ai/content-mode"
import { hasVerificationSourceUrl } from "./candidate-policy"
import { BATCH_MAX_ITEMS } from "./types"
import type { BatchApprovalStatus, Json } from "@/types/database"

// ── 상태 전이표 ──────────────────────────────────────────────────
// approved → queued(kick 발사) | running(직접 활성화) | expired | cancelled
// queued   → running | expired | cancelled | failed
// running  → completed | failed | cancelled
// 종료 상태(completed/failed/expired/cancelled)에서는 어떤 전이도 허용하지 않는다.
const APPROVAL_TRANSITIONS: Readonly<Record<BatchApprovalStatus, readonly BatchApprovalStatus[]>> = {
  approved: ["queued", "running", "expired", "cancelled"],
  queued: ["running", "expired", "cancelled", "failed"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  expired: [],
  cancelled: [],
}

export function canTransitionApproval(from: BatchApprovalStatus, to: BatchApprovalStatus): boolean {
  return APPROVAL_TRANSITIONS[from].includes(to)
}

export function isTerminalApprovalStatus(status: BatchApprovalStatus): boolean {
  return APPROVAL_TRANSITIONS[status].length === 0
}

// ── 승인 한도 ────────────────────────────────────────────────────
export const APPROVAL_MIN_PLACES = 1
export const APPROVAL_MAX_PLACES = BATCH_MAX_ITEMS // 20 — 기존 Batch 한도와 동일
// pump는 1분에 item 1건을 진행한다 — 상한 20곳이면 ~20분이고, 개별 item이 길어지는 경우
// (실측 최대 8분)까지 감안해 30 → 60분으로 잡는다. 만료되면 잔여 item이 실행되지 못한다.
export const APPROVAL_DEFAULT_EXPIRY_MINUTES = 60
export const APPROVAL_MIN_EXPIRY_MINUTES = 5
export const APPROVAL_MAX_EXPIRY_MINUTES = 120

// ── Activation token ─────────────────────────────────────────────
// 원문은 발급 응답에서 1회만 노출되고 저장되지 않는다. DB에는 해시만 남는다.
export type MintedActivationToken = {
  readonly token: string
  readonly tokenHash: string
}

export function mintActivationToken(): MintedActivationToken {
  const token = randomBytes(32).toString("base64url") // 256-bit
  return { token, tokenHash: hashActivationToken(token) }
}

export function hashActivationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

export function verifyActivationToken(candidateToken: string, storedTokenHash: string): boolean {
  const candidateHash = Buffer.from(hashActivationToken(candidateToken), "hex")
  const stored = Buffer.from(storedTokenHash, "hex")
  if (candidateHash.length !== stored.length || stored.length === 0) {
    return false
  }
  return timingSafeEqual(candidateHash, stored)
}

// 진단·이벤트 기록용 — 해시 앞 8자리만 노출한다 (원문·전체 해시 로그 금지).
export function tokenHashPrefix(tokenHash: string): string {
  return tokenHash.slice(0, 8)
}

// ── pump 실행 소유권 토큰 (lease) ────────────────────────────────
// pump가 승인을 claim하면 1회용 토큰을 발급하고 행에는 sha256만 남긴다. 원문은 그 invocation의
// 메모리에만 있고 어디에도 저장·전송되지 않는다. 승인 상태를 바꾸는 쓰기는 이 해시 조건부라,
// lease가 만료돼 다음 Cron이 같은 승인을 가져간 뒤 뒤늦게 살아난 워커가 남의 진행을 덮지 못한다.
export type MintedLeaseToken = { readonly token: string; readonly tokenHash: string }

export function mintLeaseToken(): MintedLeaseToken {
  const token = randomBytes(32).toString("base64url")
  return { token, tokenHash: hashActivationToken(token) }
}

// ── Chain tick token (PR-B에서 사용, 원시 함수는 PR-A에서 확정) ───────
// chainSecret(환경변수) + approvalId + tick으로 파생되는 자가 인증 토큰.
// tick이 CAS로 1씩 전진하므로 과거 tick 토큰 재전송은 CAS 실패로 무해하다.
export const CHAIN_SECRET_MIN_LENGTH = 32

export function deriveChainTickToken(chainSecret: string, approvalId: string, tick: number): string {
  if (chainSecret.length < CHAIN_SECRET_MIN_LENGTH) {
    throw new Error("chain secret too short")
  }
  if (!Number.isInteger(tick) || tick < 0) {
    throw new Error("invalid tick")
  }
  return createHmac("sha256", chainSecret).update(`${approvalId}:${String(tick)}`, "utf8").digest("base64url")
}

export function verifyChainTickToken(input: Readonly<{ chainSecret: string; approvalId: string; tick: number; candidateToken: string }>): boolean {
  if (input.chainSecret.length < CHAIN_SECRET_MIN_LENGTH || !Number.isInteger(input.tick) || input.tick < 0) {
    return false
  }
  const expected = Buffer.from(deriveChainTickToken(input.chainSecret, input.approvalId, input.tick), "utf8")
  const candidate = Buffer.from(input.candidateToken, "utf8")
  if (expected.length !== candidate.length || expected.length === 0) {
    return false
  }
  return timingSafeEqual(expected, candidate)
}

// ── 승인 만료 ────────────────────────────────────────────────────
export function isApprovalExpired(approvalExpiresAtIso: string, nowIso: string): boolean {
  const expires = Date.parse(approvalExpiresAtIso)
  const now = Date.parse(nowIso)
  if (Number.isNaN(expires) || Number.isNaN(now)) {
    // 시각을 해석할 수 없으면 안전한 쪽(만료)으로 닫는다.
    return true
  }
  return now >= expires
}

// ── 승인 후보 판정 + 스냅샷 ───────────────────────────────────────
// 액션 계층이 DB에서 읽어온 후보 상태를 입력으로 받아 순수 판정한다.
// 요청 place id가 아니라 이 판정을 통과한 스냅샷만 저장·실행된다 (임의 주입 차단).
export type ApprovalCandidateInput = {
  readonly place: {
    readonly id: string
    readonly name: string
    readonly address: string | null
    readonly phone: string | null
    readonly slug: string | null
    readonly status: string
    // 업종 원문 — 승인 시점에 중앙 resolver로 다시 판정한다 (후보 화면과 어긋난 주입 차단).
    readonly category: string | null
    readonly official_verification_status: string | null
    readonly verification_source_urls: Json | null
  }
  // 승인 시점에 generation·seo_page가 하나라도 있으면 자동 생성 대상이 아니다.
  readonly generationCount: number
  readonly seoPageExists: boolean
  readonly estimatedTokens: number
  readonly estimatedCostUsd: number
}

export type ApprovalPlaceSnapshot = {
  readonly place_id: string
  readonly name: string
  readonly address: string | null
  readonly phone: string | null
  readonly slug: string | null
  readonly official_verification_status: string
  readonly verification_source_urls: Json | null
  readonly had_generation: false
  readonly had_seo_page: false
  readonly estimated_tokens: number
  readonly estimated_cost_usd: number
  // 실행 직전 재대조용 항목별 해시 — 장소 정보가 승인 후 달라지면 해당 item만 차단한다.
  readonly snapshot_hash: string
}

export type ApprovalRequestBlock =
  | "no-places"
  | "too-many-places"
  | "duplicate-place"
  | "not-draft"
  | "not-verified"
  | "verification-source-missing"
  | "excluded"
  | "category-unsupported"
  | "has-generation"
  | "has-seo-page"
  | "missing-slug"
  | "invalid-max-cost"
  | "invalid-expiry"

export type ApprovalRequestDecision =
  | { readonly ok: true; readonly snapshot: readonly ApprovalPlaceSnapshot[] }
  | { readonly ok: false; readonly blockedBy: ApprovalRequestBlock; readonly placeId?: string }

export function decideApprovalRequest(
  input: Readonly<{ candidates: readonly ApprovalCandidateInput[]; maxCostUsd: number; expiresInMinutes: number }>,
): ApprovalRequestDecision {
  if (input.candidates.length < APPROVAL_MIN_PLACES) {
    return { ok: false, blockedBy: "no-places" }
  }
  if (input.candidates.length > APPROVAL_MAX_PLACES) {
    return { ok: false, blockedBy: "too-many-places" }
  }
  if (!(Number.isFinite(input.maxCostUsd) && input.maxCostUsd > 0)) {
    return { ok: false, blockedBy: "invalid-max-cost" }
  }
  if (
    !Number.isInteger(input.expiresInMinutes) ||
    input.expiresInMinutes < APPROVAL_MIN_EXPIRY_MINUTES ||
    input.expiresInMinutes > APPROVAL_MAX_EXPIRY_MINUTES
  ) {
    return { ok: false, blockedBy: "invalid-expiry" }
  }

  const seen = new Set<string>()
  const snapshot: ApprovalPlaceSnapshot[] = []
  for (const candidate of input.candidates) {
    const place = candidate.place
    if (seen.has(place.id)) {
      return { ok: false, blockedBy: "duplicate-place", placeId: place.id }
    }
    seen.add(place.id)
    if (place.official_verification_status === "excluded") {
      return { ok: false, blockedBy: "excluded", placeId: place.id }
    }
    if (place.official_verification_status !== "verified") {
      return { ok: false, blockedBy: "not-verified", placeId: place.id }
    }
    if (!hasVerificationSourceUrl(place.verification_source_urls)) {
      // 공식 검증은 verified인데 출처 URL이 비어 있으면 검증 근거를 재확인할 수 없다 — 승인에서 막는다.
      return { ok: false, blockedBy: "verification-source-missing", placeId: place.id }
    }
    if (place.status !== "draft") {
      // published·archived 등 draft가 아닌 장소는 자동 생성 대상이 아니다.
      return { ok: false, blockedBy: "not-draft", placeId: place.id }
    }
    if (contentModeForCategory(place.category) === null) {
      // 후보 화면과 같은 중앙 resolver 판정 — 모드 없는 업종은 생성 계층(requireContentMode)이
      // 어차피 거부하므로, 승인 단계에서 먼저 명시적으로 막는다.
      return { ok: false, blockedBy: "category-unsupported", placeId: place.id }
    }
    if (candidate.generationCount > 0) {
      return { ok: false, blockedBy: "has-generation", placeId: place.id }
    }
    if (candidate.seoPageExists) {
      return { ok: false, blockedBy: "has-seo-page", placeId: place.id }
    }
    if (place.slug === null || place.slug.trim().length === 0) {
      return { ok: false, blockedBy: "missing-slug", placeId: place.id }
    }
    snapshot.push(buildApprovalPlaceSnapshot(candidate))
  }
  return { ok: true, snapshot }
}

export function buildApprovalPlaceSnapshot(candidate: ApprovalCandidateInput): ApprovalPlaceSnapshot {
  const base = {
    place_id: candidate.place.id,
    name: candidate.place.name,
    address: candidate.place.address,
    phone: candidate.place.phone,
    slug: candidate.place.slug,
    official_verification_status: candidate.place.official_verification_status ?? "",
    verification_source_urls: candidate.place.verification_source_urls,
    had_generation: false,
    had_seo_page: false,
    estimated_tokens: candidate.estimatedTokens,
    estimated_cost_usd: candidate.estimatedCostUsd,
  } as const
  return { ...base, snapshot_hash: computeApprovalSnapshotHash(base) }
}

// 실행 직전 장소 정보 재대조에 쓰는 항목별 해시 — 키 순서를 고정한 결정적 직렬화.
export function computeApprovalSnapshotHash(
  entry: Readonly<{ place_id: string; name: string; address: string | null; phone: string | null; slug: string | null; official_verification_status: string }>,
): string {
  const canonical = JSON.stringify([entry.place_id, entry.name, entry.address ?? null, entry.phone ?? null, entry.slug ?? null, entry.official_verification_status])
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}
