// 자동 업체 확인 pump endpoint — Supabase Cron이 주기적으로 부른다.
//
// 한 호출 = 미확인 후보 여러 곳(기본 5) 확인. AI 호출이 없어 비용이 들지 않고,
// 통과한 곳만 verified로 올라가 2단계 후보가 된다. 나머지는 사유를 남긴 채 큐에 남는다.
//
// settings.auto_verify가 "on"이 아니면 아무 것도 하지 않는다 (기본 꺼짐).
// 인증은 게시 pump와 같은 시크릿 계약이다 — 운영 pump 공용 시크릿을 쓰고,
// 없으면 기존 PUBLISH_PUMP_SECRET로 넘어간다 (Vercel 환경변수를 새로 만들지 않아도 되게).
import { extractBearerToken, verifyPumpSecret } from "@/lib/sync/job-policy"
import { httpStatusForAutoVerifyOutcome, runAutoVerifyTick, safeAutoVerifyResponseBody } from "@/lib/admin/auto-verify-service"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const PUMP_SECRET_HEADER = "x-verify-pump-secret"

export async function POST(request: Request): Promise<Response> {
  const secret = process.env["OPERATIONS_PUMP_SECRET"] ?? process.env["PUBLISH_PUMP_SECRET"]
  if (secret === undefined || secret.length === 0 || process.env["NEXT_PUBLIC_SUPABASE_URL"] === undefined || process.env["SUPABASE_SERVICE_ROLE_KEY"] === undefined) {
    return Response.json({ kind: "conflict", reason: "missing-env" }, { status: 409 })
  }

  const presented =
    extractBearerToken(request.headers.get("authorization")) ?? request.headers.get(PUMP_SECRET_HEADER) ?? request.headers.get("x-publish-pump-secret")
  if (!verifyPumpSecret(presented, secret)) {
    // 시크릿 원문·해시·헤더는 응답에도 로그에도 남기지 않는다.
    return Response.json({ kind: "unauthorized" }, { status: 401 })
  }

  const outcome = await runAutoVerifyTick()
  return Response.json(safeAutoVerifyResponseBody(outcome), { status: httpStatusForAutoVerifyOutcome(outcome) })
}
