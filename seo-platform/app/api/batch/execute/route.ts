import { after } from "next/server"

// 승인 Batch 자동 실행 endpoint (PR-B) — Preview OpenAI 환경 전용.
// 미들웨어 matcher(/admin/:path*) 밖이라 자체 인증한다: Vercel bypass 헤더 + Activation/Chain 토큰.
// Production 배포·fake provider는 하드 거부한다. item 처리·품질·retry·비용·이벤트는 기존 경로 재사용.
import {
  deriveChainTickToken,
  verifyChainTickToken,
} from "@/lib/batch/approval-policy"
import {
  extractBearerToken,
  httpStatusForOutcome,
  parseExecuteRequest,
  resolveExecuteEnvironment,
  safeResponseBody,
  verifyBypassHeader,
  type ExecuteOutcome,
} from "@/lib/batch/approval-execution-policy"
import type { ExecuteResult, NextTick } from "@/lib/batch/approval-execution-service"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const BYPASS_HEADER = "x-vercel-protection-bypass"
const SELF_CHAIN_TIMEOUT_MS = 30_000

function json(outcome: ExecuteOutcome): Response {
  return Response.json(safeResponseBody(outcome), { status: httpStatusForOutcome(outcome) })
}

function previewSha(): string | null {
  return process.env["VERCEL_GIT_COMMIT_SHA"]?.trim() ?? null
}

export async function POST(request: Request): Promise<Response> {
  // 1) 환경 게이트 — production 배포·fake provider·secret 미설정은 409로 거부한다.
  const env = resolveExecuteEnvironment({
    VERCEL_ENV: process.env["VERCEL_ENV"],
    AI_PROVIDER: process.env["AI_PROVIDER"],
    OPENAI_API_KEY: process.env["OPENAI_API_KEY"],
    OPENAI_MODEL: process.env["OPENAI_MODEL"],
    BATCH_CHAIN_SECRET: process.env["BATCH_CHAIN_SECRET"],
    PREVIEW_EXEC_BASE_URL: process.env["PREVIEW_EXEC_BASE_URL"],
    VERCEL_AUTOMATION_BYPASS_SECRET: process.env["VERCEL_AUTOMATION_BYPASS_SECRET"],
  })
  if (!env.ok) {
    return json({ kind: "conflict", reason: env.blockedBy })
  }

  // 2) bypass 헤더 검증 (엣지 검증에 더한 방어선).
  if (!verifyBypassHeader(request.headers.get(BYPASS_HEADER), env.bypassSecret)) {
    return json({ kind: "unauthorized", reason: "bypass" })
  }

  // 3) 본문 파싱.
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ kind: "conflict", reason: "invalid-body" })
  }
  const parsed = parseExecuteRequest(body)
  if (parsed.mode === "invalid") {
    return json({ kind: "conflict", reason: "invalid-body" })
  }

  const token = extractBearerToken(request.headers.get("authorization"))
  if (token === null) {
    return json({ kind: "unauthorized", reason: "missing-token" })
  }

  const nowIso = new Date().toISOString()
  const { executeActivate, executeTick } = await import("@/lib/batch/approval-execution-service")

  let result: ExecuteResult
  try {
    if (parsed.mode === "activate") {
      // Activation token 검증은 서비스의 hash 조회가 담당한다 (조회 = 인증).
      result = await executeActivate({ activationToken: token, nowIso, previewDeploymentSha: previewSha() })
    } else {
      // Chain token은 여기서 검증한다 — approvalId+tick과 결합된 HMAC.
      if (!verifyChainTickToken({ chainSecret: env.chainSecret, approvalId: parsed.approvalId, tick: parsed.tick, candidateToken: token })) {
        return json({ kind: "unauthorized", reason: "chain-token" })
      }
      result = await executeTick({ approvalId: parsed.approvalId, tick: parsed.tick, nowIso, previewDeploymentSha: previewSha() })
    }
  } catch {
    // 내부 실패 — 원문·stack trace를 응답·로그에 노출하지 않는다.
    return json({ kind: "failed", errorCode: "internal" })
  }

  // 잔여 item이 있으면 self-chain 예약 (응답을 먼저 반환하고 다음 tick을 서버가 이어간다).
  if (result.nextTick !== null) {
    scheduleNextTick(result.nextTick, env.chainSecret, env.baseUrl, env.bypassSecret)
  }

  return json(result.outcome)
}

function scheduleNextTick(nextTick: NextTick, chainSecret: string, baseUrl: string, bypassSecret: string): void {
  const chainToken = deriveChainTickToken(chainSecret, nextTick.approvalId, nextTick.tick)
  after(async () => {
    try {
      await fetch(`${baseUrl.replace(/\/$/, "")}/api/batch/execute`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${chainToken}`,
          [BYPASS_HEADER]: bypassSecret,
        },
        body: JSON.stringify({ mode: "tick", approvalId: nextTick.approvalId, tick: nextTick.tick }),
        // redirect를 절대 따라가지 않는다 — 3xx면 fetch가 던져 아래 catch로 떨어지고,
        // authorization·bypass 헤더가 redirect 대상으로 재전송되지 않는다 (secret 유출 차단).
        redirect: "error",
        signal: AbortSignal.timeout(SELF_CHAIN_TIMEOUT_MS),
      })
    } catch {
      // chain fetch 실패는 running 상태로 남는다 — 사용자가 관리자에서 1회 재개한다 (자동 전체 재실행 금지).
      // 정체 사유 표식만 DB에 남긴다 (PR-C 재개 UI가 원인을 표시할 수 있게). 원문·secret은 남기지 않는다.
      try {
        const { createSupabaseApprovalRepository } = await import("@/lib/batch/supabase-approval-repository")
        await createSupabaseApprovalRepository().recordChainDispatchError(nextTick.approvalId, "chain-dispatch-failed")
      } catch {
        // 표식 기록마저 실패하면 조용히 넘긴다 — 응답은 이미 반환됐고 사용자 수동 재개 경로가 남는다.
      }
    }
  })
}
