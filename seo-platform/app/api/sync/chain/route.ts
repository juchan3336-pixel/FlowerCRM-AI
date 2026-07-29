// 자동 연속 동기화 self-chain endpoint.
// 미들웨어 matcher(/admin/:path*) 밖이라 자체 인증한다 — job 행에 해시로 저장된 1회용 tick 토큰.
// 토큰이 없거나 이미 회전됐으면 아무 일도 하지 않는다 (중복·지연 chain은 무해한 no-op).
//
// 이 endpoint는 세션·쿠키·관리자 권한을 요구하지 않는다. 그래서 할 수 있는 일을 최소로 묶는다:
// "이미 존재하는 job의 다음 1배치를 진행"만 가능하고, job 생성·재개는 관리자 서버 액션에서만 한다.
import {
  extractBearerToken,
  httpStatusForSyncOutcome,
  parseSyncTickRequest,
  resolveSyncChainEnvironment,
  safeSyncResponseBody,
  type SyncTickOutcome,
} from "@/lib/sync/job-policy"
import { scheduleNextTick } from "@/lib/sync/job-chain"
import type { SyncTickResult } from "@/lib/sync/job-service"

export const dynamic = "force-dynamic"
export const maxDuration = 60

function json(outcome: SyncTickOutcome): Response {
  return Response.json(safeSyncResponseBody(outcome), { status: httpStatusForSyncOutcome(outcome) })
}

export async function POST(request: Request): Promise<Response> {
  const env = resolveSyncChainEnvironment({
    VERCEL_ENV: process.env["VERCEL_ENV"],
    NEXT_PUBLIC_SUPABASE_URL: process.env["NEXT_PUBLIC_SUPABASE_URL"],
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"],
    SUPABASE_SERVICE_ROLE_KEY: process.env["SUPABASE_SERVICE_ROLE_KEY"],
    GOOGLE_SERVICE_ACCOUNT_JSON: process.env["GOOGLE_SERVICE_ACCOUNT_JSON"],
    GOOGLE_SPREADSHEET_ID: process.env["GOOGLE_SPREADSHEET_ID"],
  })
  if (!env.ok) {
    return json({ kind: "conflict", reason: env.blockedBy })
  }

  const token = extractBearerToken(request.headers.get("authorization"))
  if (token === null) {
    return json({ kind: "unauthorized", reason: "missing-token" })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ kind: "conflict", reason: "invalid-body" })
  }
  const parsed = parseSyncTickRequest(body)
  if (parsed.mode === "invalid") {
    return json({ kind: "conflict", reason: "invalid-body" })
  }

  const { executeSyncTick } = await import("@/lib/sync/job-service")
  const { createLiveSyncJobDependencies } = await import("@/lib/sync/job-dependencies")

  let result: SyncTickResult
  try {
    result = await executeSyncTick(createLiveSyncJobDependencies(), { jobId: parsed.jobId, token, nowIso: new Date().toISOString() })
  } catch {
    // 내부 실패 — 원문·stack trace를 응답에 노출하지 않는다.
    return json({ kind: "failed", errorCode: "internal" })
  }

  // 잔여가 있으면 다음 배치를 서버가 이어간다. 응답은 먼저 반환된다 — 브라우저는 관여하지 않는다.
  if (result.nextTick !== null) {
    await scheduleNextTick(result.nextTick, env.baseUrl)
  }

  return json(result.outcome)
}
