// 승인 Batch 자동 실행 v1 — Production→Preview kick 계층 (PR-C).
// Production 관리자 서버 액션이 고정 Preview execute endpoint를 1회 깨우는 요청만 담당한다.
// 실제 생성·tick 진행은 Preview 쪽 /api/batch/execute가 수행한다 (PR-B).
//
// 대상 URL은 환경변수가 아니라 코드 상수(ALLOWED_EXEC_BASE_URL)를 쓴다 —
// 오설정으로 secret이 다른 배포로 전달되는 경로를 원천 차단하고, exact-pin과 항상 일치시키기 위함이다.
// 유일하게 필요한 환경값은 Vercel이 전 배포에 자동 주입하는 VERCEL_AUTOMATION_BYPASS_SECRET 뿐이다.
import { ALLOWED_EXEC_BASE_URL } from "./approval-execution-policy"

export const KICK_TIMEOUT_MS = 15_000
export const KICK_BYPASS_HEADER = "x-vercel-protection-bypass"

// ── 환경 계약 ────────────────────────────────────────────────────
export type KickEnvironment = {
  readonly VERCEL_AUTOMATION_BYPASS_SECRET?: string | undefined
}

export type KickEnvironmentDecision =
  | { readonly ok: true; readonly bypassSecret: string; readonly baseUrl: string }
  // Automation Bypass가 꺼져 있거나 시스템 변수 주입이 안 된 상태 — kick 자체가 불가능하다.
  | { readonly ok: false; readonly blockedBy: "bypass-secret-missing" }

export function resolveKickEnvironment(env: KickEnvironment): KickEnvironmentDecision {
  const bypassSecret = env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() ?? ""
  if (bypassSecret.length === 0) {
    return { ok: false, blockedBy: "bypass-secret-missing" }
  }
  return { ok: true, bypassSecret, baseUrl: ALLOWED_EXEC_BASE_URL }
}

// ── 응답 분류 ────────────────────────────────────────────────────
// Preview execute endpoint의 상태코드를 사용자 안내가 가능한 안전한 코드로만 환산한다.
// 응답 본문은 신뢰하지 않고 status만 본다 (본문에 무엇이 오든 secret·stack을 확산시키지 않음).
export type KickOutcome =
  | { readonly kind: "started" }
  | { readonly kind: "failed"; readonly code: KickFailureCode }

export type KickFailureCode =
  | "bypass-secret-missing" // Production에 bypass secret 미주입
  | "unauthorized" // 401 — activation token 불일치·소진
  | "conflict" // 409 — Preview 환경 게이트·상태 충돌
  | "expired" // 410 — 승인 만료
  | "server-error" // 5xx
  | "unexpected-status" // 그 외 상태코드
  | "unreachable" // 네트워크 실패·timeout·redirect 거부

export function classifyKickStatus(status: number): KickOutcome {
  if (status >= 200 && status < 300) {
    return { kind: "started" }
  }
  if (status === 401) {
    return { kind: "failed", code: "unauthorized" }
  }
  if (status === 409) {
    return { kind: "failed", code: "conflict" }
  }
  if (status === 410) {
    return { kind: "failed", code: "expired" }
  }
  if (status >= 500) {
    return { kind: "failed", code: "server-error" }
  }
  return { kind: "failed", code: "unexpected-status" }
}

// 사용자에게 보여줄 한글 안내 — secret·token·원문 오류를 절대 담지 않는다.
export const KICK_FAILURE_MESSAGES: Readonly<Record<KickFailureCode, string>> = {
  "bypass-secret-missing":
    "자동 실행 연결 설정이 준비되지 않아 시작하지 못했습니다. AI 생성은 시작되지 않았습니다 — 운영자에게 Automation Bypass 설정 확인을 요청하세요.",
  unauthorized: "실행 인증에 실패해 시작하지 못했습니다. AI 생성은 시작되지 않았습니다 — 이 승인은 사용할 수 없으니 새로 승인해 주세요.",
  conflict: "실행 환경 조건이 맞지 않아 시작하지 못했습니다. AI 생성은 시작되지 않았습니다 — 잠시 후 새로 승인하거나 운영자에게 문의하세요.",
  expired: "승인 유효시간이 지나 시작하지 못했습니다. AI 생성은 시작되지 않았습니다 — 새로 승인해 주세요.",
  "server-error": "실행 서버 오류로 시작하지 못했습니다. AI 생성은 시작되지 않았습니다 — 잠시 후 새로 승인해 주세요.",
  "unexpected-status": "예상하지 못한 응답으로 시작하지 못했습니다. AI 생성은 시작되지 않았습니다 — 새로 승인해 주세요.",
  unreachable: "실행 서버에 연결하지 못했습니다. AI 생성은 시작되지 않았습니다 — 네트워크 상태를 확인한 뒤 새로 승인해 주세요.",
}

export function kickFailureMessage(code: KickFailureCode): string {
  return KICK_FAILURE_MESSAGES[code]
}

// ── 실제 발사 ────────────────────────────────────────────────────
// activation token은 이 함수 인자로만 전달되고 로그·DB·응답 어디에도 남지 않는다.
// redirect는 따라가지 않는다 — 3xx면 fetch가 던져 unreachable로 처리되고, 헤더가 재전송되지 않는다.
export async function kickApprovalActivation(
  input: Readonly<{ activationToken: string; bypassSecret: string; baseUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number }>,
): Promise<KickOutcome> {
  const doFetch = input.fetchImpl ?? fetch
  try {
    const response = await doFetch(`${input.baseUrl.replace(/\/$/, "")}/api/batch/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.activationToken}`,
        [KICK_BYPASS_HEADER]: input.bypassSecret,
      },
      body: JSON.stringify({ mode: "activate" }),
      redirect: "error",
      signal: AbortSignal.timeout(input.timeoutMs ?? KICK_TIMEOUT_MS),
    })
    return classifyKickStatus(response.status)
  } catch {
    // 네트워크 실패·timeout·redirect 거부 — 원문 오류는 남기지 않는다.
    return { kind: "failed", code: "unreachable" }
  }
}
