// 비장례 ContentMode 무저장 실측 endpoint — Preview 전용 QA 경로.
//
// 실제 OpenAI로 생성해 보되 어떤 것도 저장하지 않는다: ai_generations·places·seo_pages·batch_* 어디에도
// 쓰지 않고, publish RPC도 부르지 않는다 (lib/ai/content-dry-run.ts의 in-memory 저장소).
// 후보 자격(candidate-policy)은 그대로 funeral-only다 — 이 경로는 자격을 열지 않고 생성 계층만 빌려 쓴다.
//
// 게이트는 pump endpoint와 같은 계약이다: Production 하드 거부 · OpenAI provider 전용 ·
// 고정 Preview 별칭 exact-pin · Vercel bypass · 여기에 QA 전용 시크릿 하나 더.
// 대상 place_id는 코드 allowlist 2곳으로 고정돼 있어 요청 본문으로 다른 장소를 지정할 수 없다.
import { extractBearerToken, resolveContentDryRunEnvironment, verifyBypassHeader, verifyPumpSecret } from "@/lib/batch/approval-execution-policy"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const BYPASS_HEADER = "x-vercel-protection-bypass"
const DRY_RUN_SECRET_HEADER = "x-content-dry-run-secret"

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status })
}

export async function POST(request: Request): Promise<Response> {
  // 1) 환경 게이트 — Production 배포·fake provider·secret 미설정은 409.
  const env = resolveContentDryRunEnvironment({
    VERCEL_ENV: process.env["VERCEL_ENV"],
    AI_PROVIDER: process.env["AI_PROVIDER"],
    OPENAI_API_KEY: process.env["OPENAI_API_KEY"],
    OPENAI_MODEL: process.env["OPENAI_MODEL"],
    BATCH_CHAIN_SECRET: process.env["BATCH_CHAIN_SECRET"],
    PREVIEW_EXEC_BASE_URL: process.env["PREVIEW_EXEC_BASE_URL"],
    VERCEL_AUTOMATION_BYPASS_SECRET: process.env["VERCEL_AUTOMATION_BYPASS_SECRET"],
    CONTENT_DRY_RUN_SECRET: process.env["CONTENT_DRY_RUN_SECRET"],
  })
  if (!env.ok) {
    return json(409, { ok: false, reason: env.blockedBy })
  }

  // 2) bypass 헤더 + QA 전용 시크릿.
  if (!verifyBypassHeader(request.headers.get(BYPASS_HEADER), env.bypassSecret)) {
    return json(401, { ok: false, reason: "bypass" })
  }
  const presented = extractBearerToken(request.headers.get("authorization")) ?? request.headers.get(DRY_RUN_SECRET_HEADER)
  if (!verifyPumpSecret(presented, env.dryRunSecret)) {
    return json(401, { ok: false, reason: "dry-run-secret" })
  }

  // 3) 본문 — place_id 하나만 받는다.
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json(409, { ok: false, reason: "invalid-body" })
  }
  const placeId = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>)["place_id"] : null
  if (typeof placeId !== "string" || placeId.length === 0) {
    return json(409, { ok: false, reason: "invalid-body" })
  }

  const [{ runContentModeDryRun }, { createDryRunDependencies }] = await Promise.all([
    import("@/lib/ai/content-dry-run"),
    import("@/lib/ai/content-dry-run-dependencies"),
  ])

  let result: Awaited<ReturnType<typeof runContentModeDryRun>>
  try {
    result = await runContentModeDryRun(placeId, await createDryRunDependencies())
  } catch {
    // 내부 실패 — 원문·stack trace·프롬프트를 응답에 노출하지 않는다.
    return json(500, { ok: false, reason: "internal" })
  }

  if (result.kind === "blocked") {
    return json(409, { ok: false, reason: result.reason, place_id: result.placeId, stored: false, applied: false, published: false })
  }

  // 응답에는 생성 결과와 판정만 담는다. 시스템 프롬프트 원문·시크릿·API 키는 어디에도 넣지 않는다.
  return json(200, {
    ok: true,
    place_id: result.placeId,
    name: result.name,
    category: result.category,
    content_mode: result.contentMode,
    model: result.model,
    retried: result.retried,
    final_status: result.finalStatus,
    stored: false,
    applied: false,
    published: false,
    attempts: result.attempts.map((attempt) => ({
      kind: attempt.kind,
      duration_ms: attempt.durationMs,
      meta_title: attempt.content.meta_title,
      meta_description: attempt.content.meta_description,
      description: attempt.content.description,
      faq: attempt.content.faq,
      keywords: attempt.content.keywords,
      quality_status: attempt.quality.status,
      quality_issues: attempt.quality.issues,
      forbidden_vocabulary: attempt.forbidden.map((finding) => ({ field: finding.field, term: finding.term, kind: finding.kind })),
      tokens_input: attempt.tokensInput,
      tokens_output: attempt.tokensOutput,
      cost_usd: attempt.costUsd,
    })),
  })
}
