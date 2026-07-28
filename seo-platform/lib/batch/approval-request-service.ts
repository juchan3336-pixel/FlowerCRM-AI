import "server-only"

// 승인 Batch 자동 실행 v1 — 승인 생성 + Preview kick 오케스트레이션 (PR-C).
// PR-A의 판정·스냅샷·토큰 함수와 PR-B의 execute endpoint를 잇는 한 겹이며, 자체 판정 로직을 복제하지 않는다.
//
// Activation token 원문은 이 함수 안에서만 존재한다 — DB에는 해시만, 클라이언트·로그에는 아무것도 전달하지 않는다.
import { loadApprovalCandidateInputs } from "./approval-candidates"
import { APPROVAL_DEFAULT_EXPIRY_MINUTES, decideApprovalRequest, mintActivationToken, type ApprovalRequestBlock } from "./approval-policy"
import { kickApprovalActivation, resolveKickEnvironment, type KickEnvironment, type KickFailureCode } from "./approval-kick"
import { createSupabaseApprovalRepository } from "./supabase-approval-repository"

export type ApprovalRequestResult =
  // 승인 생성 + Preview 자동 실행 요청까지 성공 (실제 생성은 Preview에서 진행 중).
  | { readonly kind: "started"; readonly approvalId: string }
  // 응답을 받지 못했지만 실행이 이미 접수된 증거가 DB에 있다 — 취소하면 안 되는 상태.
  | { readonly kind: "accepted-unconfirmed"; readonly approvalId: string }
  // 접수 여부를 판정할 수 없다 — 취소도 재시도도 하지 않고 사용자에게 확인을 맡긴다.
  | { readonly kind: "unknown"; readonly approvalId: string }
  // 후보 판정 실패 — 승인 행을 만들지 않는다.
  | { readonly kind: "blocked"; readonly reason: ApprovalRequestBlock }
  // 활성 승인이 이미 존재 (전역 1건 원칙).
  | { readonly kind: "already-active" }
  // 승인은 만들었으나 kick 실패 — 승인을 취소로 닫고 사유를 남겼다 (같은 토큰 재사용 불가).
  | { readonly kind: "kick-failed"; readonly code: KickFailureCode }

export async function createApprovalAndKick(
  input: Readonly<{
    placeIds: readonly string[]
    approvedBy: string
    maxCostUsd: number
    expiresInMinutes?: number
    env: KickEnvironment
    nowIso: string
    fetchImpl?: typeof fetch
  }>,
): Promise<ApprovalRequestResult> {
  const expiresInMinutes = input.expiresInMinutes ?? APPROVAL_DEFAULT_EXPIRY_MINUTES

  // 1) 요청 placeId의 실제 DB 상태로만 판정한다 (폼 값 신뢰 안 함).
  const candidates = await loadApprovalCandidateInputs(input.placeIds)
  const decision = decideApprovalRequest({ candidates, maxCostUsd: input.maxCostUsd, expiresInMinutes })
  if (!decision.ok) {
    return { kind: "blocked", reason: decision.blockedBy }
  }

  // 2) Activation token 발급 — 원문은 아래 kick 요청에만 쓰이고 저장·반환하지 않는다.
  const minted = mintActivationToken()
  const approvals = createSupabaseApprovalRepository()
  const created = await approvals.createApproval({
    approvedBy: input.approvedBy,
    approvalExpiresAt: new Date(Date.parse(input.nowIso) + expiresInMinutes * 60_000).toISOString(),
    approvedPlaceIds: decision.snapshot.map((entry) => entry.place_id),
    approvedMaxCostUsd: input.maxCostUsd,
    approvalSnapshot: decision.snapshot,
    executionTokenHash: minted.tokenHash,
  })
  if (created.kind === "already-active") {
    return { kind: "already-active" }
  }

  // 3) 환경 계약 확인 — bypass secret이 없으면 kick 자체가 불가하므로 승인을 즉시 닫는다.
  const env = resolveKickEnvironment(input.env)
  if (!env.ok) {
    // 요청을 보낸 적이 없으므로 실행 증거가 있을 수 없다 — 안전하게 취소로 닫는다.
    try {
      await approvals.cancelApprovalWithError(created.approval.id, { code: "kick-failed", message: `kick-failed:${env.blockedBy}` })
    } catch {
      // no-op
    }
    return { kind: "kick-failed", code: env.blockedBy }
  }

  // 4) 고정 Preview execute endpoint를 1회 깨운다 (redirect 미추적·timeout 적용).
  const outcome = await kickApprovalActivation({
    activationToken: minted.token,
    bypassSecret: env.bypassSecret,
    baseUrl: env.baseUrl,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  })
  if (outcome.kind !== "started") {
    // PR-D — timeout/네트워크 오류는 "실행되지 않았다"는 뜻이 아니다. Preview가 요청을 받아 이미
    // 실행을 시작했는데 응답만 늦게 온 경우가 있으므로, 취소하기 전에 승인 행을 다시 읽어 판정한다.
    return await resolveAfterKickFailure(approvals, created.approval.id, outcome.code)
  }

  return { kind: "started", approvalId: created.approval.id }
}

// kick 응답을 받지 못했을 때의 판정. 같은 Activation token을 자동 재전송하지 않는다.
async function resolveAfterKickFailure(
  approvals: ReturnType<typeof createSupabaseApprovalRepository>,
  approvalId: string,
  code: KickFailureCode,
): Promise<ApprovalRequestResult> {
  let current: Awaited<ReturnType<typeof approvals.findApprovalById>> = null
  try {
    current = await approvals.findApprovalById(approvalId)
  } catch {
    // 조회 자체가 실패 — 접수 여부를 알 수 없으므로 절대 취소하지 않는다.
    await noteUnknown(approvals, approvalId)
    return { kind: "unknown", approvalId }
  }
  if (current === null) {
    await noteUnknown(approvals, approvalId)
    return { kind: "unknown", approvalId }
  }

  // A. 실행이 접수된 증거가 하나라도 있으면 취소 금지 — 진행 상태 그대로 둔다.
  const acceptedEvidence =
    current.activation_consumed_at !== null ||
    current.batch_run_id !== null ||
    current.status === "running" ||
    current.status === "completed" ||
    current.execution_tick > 0
  if (acceptedEvidence) {
    return { kind: "accepted-unconfirmed", approvalId }
  }

  // B. 실행 시작 증거가 전혀 없고 아직 approved/queued일 때만 안전하게 취소한다.
  if ((current.status === "approved" || current.status === "queued") && current.activation_consumed_at === null && current.batch_run_id === null) {
    try {
      await approvals.cancelApprovalWithError(approvalId, { code: "kick-failed", message: `kick-failed:${code}` })
    } catch {
      // 보상 기록 실패는 사용자 응답을 막지 않는다.
    }
    return { kind: "kick-failed", code }
  }

  // C. 그 밖의 애매한 상태 — 단정하지 않는다.
  await noteUnknown(approvals, approvalId)
  return { kind: "unknown", approvalId }
}

// 상태를 바꾸지 않고 사유 표식만 남긴다 (running이 아니면 no-op).
async function noteUnknown(approvals: ReturnType<typeof createSupabaseApprovalRepository>, approvalId: string): Promise<void> {
  try {
    await approvals.recordChainDispatchError(approvalId, "kick-status-unknown")
  } catch {
    // no-op
  }
}

