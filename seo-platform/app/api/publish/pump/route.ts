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
import { revalidatePublicPlacePaths } from "@/lib/seo-pages/publish-runner"
import { processRevalidateRequests } from "@/lib/seo-pages/revalidate-requests"
import { reconcileVerifiedAddressCache } from "@/lib/seo-pages/verified-address-cache"
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

  // 공개 캐시 갱신 요청 처리 — 게시 스위치와 무관하게 매 주기 본다 (Preview에서 고친 공개 FAQ를 운영 캐시에 반영).
  // 실패해도 게시 주기는 그대로 진행한다. 처리되지 않은 요청은 남아 다음 주기에 다시 시도된다.
  try {
    await processRevalidateRequests(revalidatePublicPlacePaths)
  } catch (error) {
    console.error("[publish-pump] revalidate requests failed", error instanceof Error ? error.message : "unknown")
  }

  // 검수 주소 등록 장소의 판정(matched/conflict)이 바뀌었으면 그 장소 페이지와 sitemap 캐시를 맞춘다.
  // 실패는 기록을 올리지 않아 다음 주기에 다시 시도된다 — 게시 주기는 그대로 진행한다.
  try {
    const addressCache = await reconcileVerifiedAddressCache(revalidatePublicPlacePaths)
    if (addressCache.failed > 0) {
      console.error("[publish-pump] verified address cache refresh failed", { failed: addressCache.failed, refreshed: addressCache.refreshed })
    }
  } catch (error) {
    console.error("[publish-pump] verified address cache reconcile failed", error instanceof Error ? error.message : "unknown")
  }

  const outcome = await runAutoPublishTick({ registerAfter: after })
  return json(outcome)
}
