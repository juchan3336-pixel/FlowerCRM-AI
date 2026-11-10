// Enrich 외부 예약 endpoint — Supabase Cron이 90분마다 부르고, 여기서 GitHub workflow_dispatch를 보낸다.
//
// GitHub의 schedule 트리거를 쓰지 않는 이유: 이 저장소에서는 예약 실행이 대부분 건너뛰어진다
// (2026-11-10 실측). 수동 workflow_dispatch는 항상 즉시 시작하므로, 정해진 시각에 그것을 대신
// 눌러 주는 것이 이 endpoint의 전부다.
//
// 미들웨어 matcher(/admin/:path*) 밖이라 자체 인증한다. 인증은 공유 시크릿을 보내는 방식이
// 아니라 HMAC 서명이다 — 서명키는 전송되지 않고, 가로챈 요청은 5분 뒤 쓸모가 없다.
// GitHub 토큰은 이 서버의 환경변수에만 있고 DB·SQL·요청 어디에도 실리지 않는다.
// 인증을 통과하기 전에는 DB에도 GitHub에도 접근하지 않는다.
import {
  ENRICH_DISPATCH_SIGNATURE_HEADER,
  ENRICH_DISPATCH_TIMESTAMP_HEADER,
  httpStatusForOutcome,
  resolveEnrichDispatchEnvironment,
  safeResponseBody,
  verifyDispatchSignature,
  type EnrichDispatchOutcome,
} from "@/lib/enrich-dispatch/policy"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
// GitHub 요청은 개별 8초 제한(상태 조회 5회 + dispatch 1회)이라 최악에도 이 안에 끝난다.
export const maxDuration = 60

function json(outcome: EnrichDispatchOutcome): Response {
  return Response.json(safeResponseBody(outcome), { status: httpStatusForOutcome(outcome) })
}

export async function POST(request: Request): Promise<Response> {
  const env = resolveEnrichDispatchEnvironment({
    VERCEL_ENV: process.env["VERCEL_ENV"],
    NEXT_PUBLIC_SUPABASE_URL: process.env["NEXT_PUBLIC_SUPABASE_URL"],
    SUPABASE_SERVICE_ROLE_KEY: process.env["SUPABASE_SERVICE_ROLE_KEY"],
    ENRICH_DISPATCH_SIGNING_SECRET: process.env["ENRICH_DISPATCH_SIGNING_SECRET"],
    ENRICH_GITHUB_TOKEN: process.env["ENRICH_GITHUB_TOKEN"],
  })
  if (!env.ok) return json({ kind: "conflict", reason: env.blockedBy })

  // 서명은 받은 본문 그대로에 대해 검증한다 — 다시 직렬화한 값이 아니다.
  const rawBody = await request.text()
  const authentic = verifyDispatchSignature({
    secret: env.signingSecret,
    timestamp: request.headers.get(ENRICH_DISPATCH_TIMESTAMP_HEADER),
    signature: request.headers.get(ENRICH_DISPATCH_SIGNATURE_HEADER),
    rawBody,
    nowMs: Date.now(),
  })
  if (!authentic) return json({ kind: "unauthorized" })

  try {
    const { runEnrichDispatchTick } = await import("@/lib/enrich-dispatch/service")
    const { createLiveEnrichDispatchDependencies } = await import("@/lib/enrich-dispatch/dependencies")
    return json(await runEnrichDispatchTick(createLiveEnrichDispatchDependencies(env.githubToken), { nowMs: Date.now() }))
  } catch {
    // 내부 실패 — 원문·stack trace를 응답에 노출하지 않는다.
    return json({ kind: "failed" })
  }
}
