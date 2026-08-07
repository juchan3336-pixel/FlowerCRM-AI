// GSC 검색 성과 동기화 endpoint — Supabase Cron이 하루 1회 부른다 (다른 pump들과 같은 인증 계약).
// 미들웨어 matcher(/admin/:path*) 밖이라 자체 시크릿으로 인증하고, 관리자 세션과 완전히 분리된다.
// Production 전용 게이트는 두지 않는다 — 읽기(GSC)+자체 테이블 upsert뿐이라 공개 캐시와 무관하다.
import { httpStatusForSearchReportOutcome, runSearchReportSync } from "@/lib/search-report/sync-service"
import { extractBearerToken, verifyPumpSecret } from "@/lib/sync/job-policy"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const SYNC_SECRET_HEADER = "x-search-report-secret"

export async function POST(request: Request): Promise<Response> {
  const secret = process.env["SEARCH_REPORT_SYNC_SECRET"]
  if (secret === undefined || secret.length === 0 || process.env["NEXT_PUBLIC_SUPABASE_URL"] === undefined || process.env["SUPABASE_SERVICE_ROLE_KEY"] === undefined) {
    return Response.json({ kind: "conflict", reason: "missing-env" }, { status: 409 })
  }
  const presented = extractBearerToken(request.headers.get("authorization")) ?? request.headers.get(SYNC_SECRET_HEADER)
  if (!verifyPumpSecret(presented, secret)) {
    return Response.json({ kind: "unauthorized" }, { status: 401 })
  }

  const outcome = await runSearchReportSync()
  return Response.json(outcome, { status: httpStatusForSearchReportOutcome(outcome) })
}
