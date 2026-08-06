// 자동 게시 pump endpoint — Production에서만 동작하며 Supabase Cron이 주기적으로 부른다.
//
// 한 번 호출 = 적격 ready 장소 1곳 게시. 게시 코어는 관리자 수동 게시와 동일한
// runPlacePublish(어휘 재검사 → RPC guard → revalidate → 비동기 공개 검증)를 그대로 쓴다.
// settings.auto_publish가 "on"이 아니면 아무 것도 하지 않는다 (기본 꺼짐).
//
// 미들웨어 matcher(/admin/:path*) 밖이라 자체 인증한다 — 스케줄러 전용 시크릿 하나뿐이고
// 관리자 세션·쿠키와 완전히 분리된다 (sync pump와 동일 계약).
import { after } from "next/server"

import { resolvePublishEnvironment } from "@/lib/admin/publish-environment"
import { httpStatusForAutoPublishOutcome, runAutoPublishTick, safeAutoPublishResponseBody, type AutoPublishTickOutcome } from "@/lib/seo-pages/auto-publish"
import { extractBearerToken, verifyPumpSecret } from "@/lib/sync/job-policy"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const PUMP_SECRET_HEADER = "x-publish-pump-secret"

function json(outcome: AutoPublishTickOutcome): Response {
  return Response.json(safeAutoPublishResponseBody(outcome), { status: httpStatusForAutoPublishOutcome(outcome) })
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env["PUBLISH_PUMP_SECRET"]
  if (secret === undefined || secret.length === 0 || process.env["NEXT_PUBLIC_SUPABASE_URL"] === undefined || process.env["SUPABASE_SERVICE_ROLE_KEY"] === undefined) {
    return Response.json({ kind: "conflict", reason: "missing-env" }, { status: 409 })
  }
  // 게시는 Production 배포에서만 — Preview에서 실행되면 운영 캐시가 갱신되지 않는다 (수동 게시와 같은 가드).
  if (!resolvePublishEnvironment(process.env["VERCEL_ENV"]).allowed) {
    return Response.json({ kind: "conflict", reason: "env-blocked" }, { status: 409 })
  }

  const presented = extractBearerToken(request.headers.get("authorization")) ?? request.headers.get(PUMP_SECRET_HEADER)
  if (!verifyPumpSecret(presented, secret)) {
    // 시크릿 원문·해시·헤더는 응답에도 로그에도 남기지 않는다.
    return Response.json({ kind: "unauthorized" }, { status: 401 })
  }

  const outcome = await runAutoPublishTick({ registerAfter: after })
  return json(outcome)
}
