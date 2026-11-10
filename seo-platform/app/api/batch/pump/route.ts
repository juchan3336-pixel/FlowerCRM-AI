// 승인 Batch 자동 실행 pump endpoint — 외부 스케줄러(Supabase Cron)가 주기적으로 부른다.
//
// 한 번 호출 = 실행 중 승인 1개 claim + item 1건 처리. 끝나면 함수는 그냥 종료한다.
// 다음 item은 다음 Cron 호출이 처리한다 — 이 endpoint는 자기 자신을(또는 다른 어떤 배포도) 부르지 않는다.
// 이전 self-chain 구조는 item 1건당 self-fetch 1회여서, 승인 상한인 5곳을 승인하면 5번째 발사가
// Vercel의 508 INFINITE_LOOP_DETECTED에 걸렸다. 그 재귀를 구조적으로 없앤 것이 이 endpoint다.
//
// 환경 게이트는 실행 endpoint와 동일하다: Production 배포 하드 거부 · OpenAI provider 전용 ·
// 고정 Preview 별칭 pin · Vercel bypass. 여기에 스케줄러 전용 시크릿 하나를 더 요구한다.
import {
  extractBearerToken,
  httpStatusForOutcome,
  resolveBatchPumpEnvironment,
  safeResponseBody,
  verifyBypassHeader,
  verifyPumpSecret,
  type ExecuteOutcome,
} from "@/lib/batch/approval-execution-policy"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const BYPASS_HEADER = "x-vercel-protection-bypass"
// 스케줄러가 Authorization 헤더를 싣기 어려운 경우를 위한 전용 헤더 (둘 중 하나면 된다).
const PUMP_SECRET_HEADER = "x-batch-pump-secret"

function json(outcome: ExecuteOutcome): Response {
  return Response.json(safeResponseBody(outcome), { status: httpStatusForOutcome(outcome) })
}

function previewSha(): string | null {
  return process.env["VERCEL_GIT_COMMIT_SHA"]?.trim() ?? null
}

export async function POST(request: Request): Promise<Response> {
  // 1) 환경 게이트 — Production 배포·fake provider·secret 미설정은 409로 거부한다.
  const env = resolveBatchPumpEnvironment({
    VERCEL_ENV: process.env["VERCEL_ENV"],
    AI_PROVIDER: process.env["AI_PROVIDER"],
    OPENAI_API_KEY: process.env["OPENAI_API_KEY"],
    OPENAI_MODEL: process.env["OPENAI_MODEL"],
    BATCH_CHAIN_SECRET: process.env["BATCH_CHAIN_SECRET"],
    PREVIEW_EXEC_BASE_URL: process.env["PREVIEW_EXEC_BASE_URL"],
    VERCEL_AUTOMATION_BYPASS_SECRET: process.env["VERCEL_AUTOMATION_BYPASS_SECRET"],
    BATCH_PUMP_SECRET: process.env["BATCH_PUMP_SECRET"],
  })
  if (!env.ok) {
    return json({ kind: "conflict", reason: env.blockedBy })
  }

  // 2) bypass 헤더 (엣지 검증에 더한 방어선) + 스케줄러 전용 시크릿.
  if (!verifyBypassHeader(request.headers.get(BYPASS_HEADER), env.bypassSecret)) {
    return json({ kind: "unauthorized", reason: "bypass" })
  }
  const presented = extractBearerToken(request.headers.get("authorization")) ?? request.headers.get(PUMP_SECRET_HEADER)
  if (!verifyPumpSecret(presented, env.pumpSecret)) {
    // 시크릿 원문·해시·헤더는 응답에도 로그에도 남기지 않는다.
    return json({ kind: "unauthorized", reason: "pump-secret" })
  }

  const { claimBatchPumpLease, runLeasedApprovalStep } = await import("@/lib/batch/approval-execution-service")

  // 3) 실행 소유권만 먼저 확보한다 — DB 왕복 1회라 수백 ms다.
  let claim: Awaited<ReturnType<typeof claimBatchPumpLease>>
  try {
    claim = await claimBatchPumpLease({ nowIso: new Date().toISOString() })
  } catch {
    // 내부 실패 — 원문·stack trace를 응답에 노출하지 않는다.
    return json({ kind: "failed", errorCode: "internal" })
  }
  const { after } = await import("next/server")
  if (claim.kind === "idle") {
    // 실행 중 승인이 없거나 다른 pump가 이미 들고 있다. 다음 주기에 다시 본다.
    // 자동 생성 캠페인이 켜져 있으면 응답 이후에 다음 승인 1건을 준비한다 (스위치가 꺼져 있으면 설정 조회 1회로 끝난다).
    // 여기서 만든 승인의 첫 item은 다음 Cron 호출이 처리한다 — 이 요청은 어떤 배포도 HTTP로 부르지 않는다.
    after(async () => {
      try {
        const { runAutoGenerateStep } = await import("@/lib/batch/auto-generate-service")
        const outcome = await runAutoGenerateStep({ nowIso: new Date().toISOString(), previewDeploymentSha: previewSha() })
        if (outcome.kind !== "skipped") {
          // 장소 ID·토큰은 남기지 않는다 — 승인 ID와 건수만.
          console.info("[auto-generate]", outcome.kind, outcome.approvalId, outcome.kind === "started" ? outcome.placeCount : outcome.reason)
        }
      } catch (error) {
        // 설정·예산 조회 실패 등 — 이번 주기에는 아무것도 승인하지 않았다. 다음 주기에 다시 본다.
        console.error("[auto-generate] step failed", error instanceof Error ? error.message : "unknown")
      }
    })
    return json({ kind: "noop", reason: "idle" })
  }
  const { approval, leaseTokenHash } = claim

  // 자동 생성 캠페인이 만든 승인은 스위치를 매 item 앞에서 다시 본다 — 꺼져 있으면 이 item부터 멈춘다.
  // 승인은 running으로 남으므로 스위치를 다시 켜면 같은 지점에서 이어진다. 관리자 승인에는 영향이 없다.
  const { isAutoGenerateApprover } = await import("@/lib/batch/auto-generate-policy")
  if (isAutoGenerateApprover(approval.approved_by)) {
    const { isAutoGenerateEnabled } = await import("@/lib/batch/auto-generate-service")
    if (!(await isAutoGenerateEnabled())) {
      const { releaseBatchPumpLease } = await import("@/lib/batch/approval-execution-service")
      await releaseBatchPumpLease({ approvalId: approval.id, leaseTokenHash })
      return json({ kind: "noop", reason: "auto-generate-paused" })
    }
  }

  // 4) 실제 생성(실측 8.5~15.2초)은 응답 이후에 돈다. 스케줄러는 접수만 확인하고 연결을 끊는다.
  after(async () => {
    try {
      await runLeasedApprovalStep({ approval, leaseTokenHash, nowIso: new Date().toISOString(), previewDeploymentSha: previewSha() })
    } catch {
      // 생성 도중 예기치 못한 실패 — 이 승인은 이번 주기에 끝나지 않았다.
      // 승인 상태는 건드리지 않는다: lease가 만료되면 다음 Cron이 같은 지점에서 이어받고,
      // item 상태는 기존 stale 처리와 claim CAS가 정합을 유지한다.
    }
  })

  // 5) 접수됨(202). 아직 아무 item도 처리되지 않았으므로 진행 수치를 담지 않는다.
  return json({ kind: "accepted", approvalStatus: "running" })
}
