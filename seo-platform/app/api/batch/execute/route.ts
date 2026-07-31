// 승인 Batch 자동 실행 activate endpoint — Preview OpenAI 환경 전용.
// 미들웨어 matcher(/admin/:path*) 밖이라 자체 인증한다: Vercel bypass 헤더 + Activation 토큰.
// Production 배포·fake provider는 하드 거부한다.
//
// 이 endpoint는 접수만 한다 — 승인을 running으로 올리고 batch_run을 연결한 뒤 끝난다.
// item 처리는 app/api/batch/pump가 Cron 호출로 1건씩 진행한다. 여기서 아무것도 발사하지 않는다:
// 예전에는 item 1건당 self-fetch 1회였고, 승인 상한인 5곳에서 Vercel의 508 INFINITE_LOOP_DETECTED에
// 걸렸다. 게다가 발사한 쪽이 응답 상태를 보지 않아 508을 성공으로 삼키고 승인이 영구 정지했다.
import {
  extractBearerToken,
  httpStatusForOutcome,
  parseExecuteRequest,
  resolveExecuteEnvironment,
  safeResponseBody,
  verifyBypassHeader,
  type ExecuteOutcome,
} from "@/lib/batch/approval-execution-policy"
import type { ExecuteResult } from "@/lib/batch/approval-execution-service"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const BYPASS_HEADER = "x-vercel-protection-bypass"

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

  // 3) 본문 파싱 — activate만 받는다.
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ kind: "conflict", reason: "invalid-body" })
  }
  const parsed = parseExecuteRequest(body)
  if (parsed.mode !== "activate") {
    // tick 모드는 self-chain과 함께 제거됐다. 지연 도착한 예전 요청은 여기서 무해하게 막힌다.
    return json({ kind: "conflict", reason: "invalid-body" })
  }

  const token = extractBearerToken(request.headers.get("authorization"))
  if (token === null) {
    return json({ kind: "unauthorized", reason: "missing-token" })
  }

  const { executeActivate } = await import("@/lib/batch/approval-execution-service")

  let result: ExecuteResult
  try {
    // Activation token 검증은 서비스의 hash 조회가 담당한다 (조회 = 인증).
    result = await executeActivate({ activationToken: token, nowIso: new Date().toISOString(), previewDeploymentSha: previewSha() })
  } catch {
    // 내부 실패 — 원문·stack trace를 응답·로그에 노출하지 않는다.
    return json({ kind: "failed", errorCode: "internal" })
  }

  // 첫 item은 다음 Cron 호출(pump)이 가져간다 — 여기서 다음 실행을 예약하지 않는다.
  return json(result.outcome)
}
