// 자동 연속 동기화 pump endpoint — 외부 스케줄러(Supabase Cron)가 주기적으로 부른다.
//
// 한 번 호출 = job 1개 claim + 배치 1개 처리. 끝나면 함수는 그냥 종료한다.
// 다음 배치는 다음 Cron 호출이 처리한다 — 이 endpoint는 자기 자신을(또는 다른 어떤 배포도) 부르지 않는다.
// 이전 self-chain 구조는 Vercel이 같은 함수의 재귀 호출을 4회 초과에서 508 INFINITE_LOOP_DETECTED로
// 차단해 재개마다 배치 4개에서 멈췄다 (2026-07-30 실측). 그 재귀를 구조적으로 없앤 것이 이 endpoint다.
//
// 미들웨어 matcher(/admin/:path*) 밖이라 자체 인증한다 — 스케줄러 전용 시크릿 하나뿐이고,
// 관리자 세션·쿠키와 완전히 분리된다. 할 수 있는 일도 "이미 존재하는 job의 다음 1배치"로 최소화했다.
import {
  extractBearerToken,
  httpStatusForSyncOutcome,
  resolveSyncPumpEnvironment,
  safeSyncResponseBody,
  verifyPumpSecret,
  type SyncTickOutcome,
} from "@/lib/sync/job-policy"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// 스케줄러가 Authorization 헤더를 싣기 어려운 경우를 위한 전용 헤더 (둘 중 하나면 된다).
const PUMP_SECRET_HEADER = "x-sync-pump-secret"

function json(outcome: SyncTickOutcome): Response {
  return Response.json(safeSyncResponseBody(outcome), { status: httpStatusForSyncOutcome(outcome) })
}

export async function POST(request: Request): Promise<Response> {
  const env = resolveSyncPumpEnvironment({
    NEXT_PUBLIC_SUPABASE_URL: process.env["NEXT_PUBLIC_SUPABASE_URL"],
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"],
    SUPABASE_SERVICE_ROLE_KEY: process.env["SUPABASE_SERVICE_ROLE_KEY"],
    GOOGLE_SERVICE_ACCOUNT_JSON: process.env["GOOGLE_SERVICE_ACCOUNT_JSON"],
    GOOGLE_SPREADSHEET_ID: process.env["GOOGLE_SPREADSHEET_ID"],
    SYNC_PUMP_SECRET: process.env["SYNC_PUMP_SECRET"],
  })
  if (!env.ok) {
    return json({ kind: "conflict", reason: env.blockedBy })
  }

  const presented = extractBearerToken(request.headers.get("authorization")) ?? request.headers.get(PUMP_SECRET_HEADER)
  if (!verifyPumpSecret(presented, env.pumpSecret)) {
    // 시크릿 원문·해시·헤더는 응답에도 로그에도 남기지 않는다.
    return json({ kind: "unauthorized", reason: "pump-secret" })
  }

  const { claimPumpLease, runLeasedBatch } = await import("@/lib/sync/job-service")
  const { createLiveSyncJobDependencies } = await import("@/lib/sync/job-dependencies")
  const dependencies = createLiveSyncJobDependencies()

  // 1) 실행 소유권만 먼저 확보한다 — DB 왕복 1회라 수백 ms다.
  let claim: Awaited<ReturnType<typeof claimPumpLease>>
  try {
    claim = await claimPumpLease(dependencies, { nowIso: new Date().toISOString() })
  } catch {
    // 내부 실패 — 원문·stack trace를 응답에 노출하지 않는다.
    return json({ kind: "failed", errorCode: "internal" })
  }
  if (claim.kind === "idle") {
    // 처리할 job이 없거나 다른 pump가 이미 들고 있다. 다음 주기에 다시 본다.
    return json({ kind: "noop", reason: "idle" })
  }
  const { job, leaseTokenHash } = claim

  // 2) 실제 배치(실측 34~41초)는 응답 이후에 돈다. 스케줄러는 접수만 확인하고 연결을 끊는다.
  const { after } = await import("next/server")
  after(async () => {
    try {
      await runLeasedBatch(dependencies, { job, leaseTokenHash, nowIso: new Date().toISOString() })
    } catch {
      // 배치 도중 예기치 못한 실패 — 이 job은 이번 주기에 끝나지 않았다.
      // lease 보유자일 때만 표식을 남긴다 (이미 넘어갔다면 남의 진행을 덮지 않는다).
      try {
        const { markPumpBatchCrashed } = await import("@/lib/sync/pump-recovery")
        await markPumpBatchCrashed({ jobId: job.id, leaseTokenHash })
      } catch {
        // 표식마저 실패하면 조용히 넘긴다 — lease가 만료되면 다음 Cron이 같은 커서에서 이어받는다.
      }
    }
  })

  // 3) 접수됨(202). 아직 아무 배치도 돌지 않았으므로 진행 수치를 담지 않는다.
  return json({ kind: "accepted", jobId: job.id })
}
