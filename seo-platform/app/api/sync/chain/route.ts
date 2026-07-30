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
import { chainNextTick } from "@/lib/sync/job-chain"

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

  const { acceptSyncTick, runSyncTickBatch } = await import("@/lib/sync/job-service")
  const { createLiveSyncJobDependencies } = await import("@/lib/sync/job-dependencies")
  const dependencies = createLiveSyncJobDependencies()

  // 1) 접수만 먼저 — 인증·중복 판정·커서 소진(claim)까지. DB 왕복 2회라 수백 ms다.
  let acceptance: Awaited<ReturnType<typeof acceptSyncTick>>
  try {
    acceptance = await acceptSyncTick(dependencies, { jobId: parsed.jobId, token, nowIso: new Date().toISOString() })
  } catch {
    // 내부 실패 — 원문·stack trace를 응답에 노출하지 않는다.
    return json({ kind: "failed", errorCode: "internal" })
  }
  if (acceptance.kind === "rejected") {
    return json(acceptance.outcome)
  }
  const { claimed, minted } = acceptance

  // 2) 실제 배치(34~43초)와 다음 발사는 응답 이후에 돈다.
  // 발사한 쪽이 이 배치의 완료를 기다리지 않는 것이 이 구조의 핵심이다 — 한 invocation이 한 tick만 맡는다.
  const { after } = await import("next/server")
  after(async () => {
    try {
      const result = await runSyncTickBatch(dependencies, { claimed, minted, nowIso: new Date().toISOString() })
      if (result.nextTick !== null) {
        await chainNextTick(result.nextTick, env.baseUrl)
      }
    } catch {
      // 배치 도중 예기치 못한 실패 — 이 tick은 끝나지 않았고 다음 발사도 없다.
      // 소진한 토큰(minted)으로 조건부 표식만 남긴다: 이후 누군가 정상 접수했다면 해시가 달라 덮지 않는다.
      try {
        const { markUnconfirmedDispatch } = await import("@/lib/sync/job-chain")
        await markUnconfirmedDispatch({ jobId: claimed.id, expectedTokenHash: minted.tokenHash })
      } catch {
        // 표식마저 실패하면 조용히 넘긴다 — 정체는 last_tick_at으로 감지되고 재개 경로가 남는다.
      }
    }
  })

  // 3) 접수됨(202). 본문에 진행 수치를 담지 않는다 — 아직 아무 배치도 돌지 않았다.
  return json({ kind: "accepted", jobId: claimed.id })
}
