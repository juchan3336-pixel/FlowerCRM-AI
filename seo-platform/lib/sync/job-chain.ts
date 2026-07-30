// self-chain 발사 — 다음 1배치를 서버가 스스로 호출한다.
// 브라우저는 여기에 전혀 관여하지 않는다 (화면을 닫아도 계속 진행되는 이유).
//
// 발사한 쪽은 "접수(202) 확인"까지만 기다린다. 배치 완료를 기다리면 안 된다 —
// 배치 1회는 Production 실측 34~41초이고, 완료를 기다리는 구조에서는 정상 진행 중인 job을
// 매번 발사 실패로 오인해 interrupted로 닫아버린다 (2026-07-29 장애).
//
// 그리고 발사는 단발이면 안 된다 — 일시적인 5xx·네트워크 오류 한 번이 107배치짜리 세션 전체를
// 끝내기 때문이다 (2026-07-30 장애: 배치 5개를 정상 처리한 뒤 6번째 발사가 0.48초 만에 실패).
// 그래서 재시도 가능한 실패만 제한 재시도하고, 최종 실패 시 진단 가능한 형태로 기록한다.
import {
  chainDispatchBackoffMs,
  chainDispatchErrorCode,
  chainDispatchErrorMessage,
  classifyChainDispatchError,
  classifyChainDispatchStatus,
  hashTickToken,
  parseRetryAfterMs,
  SYNC_CHAIN_ATTEMPT_TIMEOUT_MS,
  SYNC_CHAIN_MAX_ATTEMPTS,
  SYNC_CHAIN_TOTAL_BUDGET_MS,
  type ChainDispatchErrorCategory,
} from "./job-policy"
import type { NextTick } from "./job-service"

export const DISPATCH_FAILED_CODE = "chain-dispatch-failed"
// 배치 자체가 예기치 못하게 터진 경우 — 발사 실패와 구분해서 남긴다.
export const TICK_CRASHED_CODE = "chain-tick-crashed"

// accepted: 상대가 tick을 접수했다 (202 등 2xx). 이후 진행은 상대 invocation의 책임이다.
// rejected: 상대가 응답으로 거부했고 재시도해도 같은 답이 온다 (4xx 등).
// unconfirmed: 응답을 보지 못했거나 일시적 실패가 끝까지 반복됐다. 접수됐는지 알 수 없다.
export type DispatchOutcome = "accepted" | "rejected" | "unconfirmed"

export type DispatchReport = {
  readonly kind: DispatchOutcome
  readonly attempt: number
  readonly maxAttempts: number
  readonly httpStatus: number | null
  readonly errorCategory: ChainDispatchErrorCategory
  readonly retryable: boolean
  readonly elapsedMs: number
}

export type ChainDispatchDependencies = {
  readonly fetchImpl?: typeof fetch
  readonly sleepImpl?: (ms: number) => Promise<void>
  readonly nowMs?: () => number
  // 접수되지 않았을 가능성이 있을 때만 호출된다 (rejected·unconfirmed).
  // 실제 표식 여부는 토큰 해시 CAS가 최종 판정한다 — markUnconfirmedDispatch 참조.
  readonly onDispatchUnconfirmed?: (input: Readonly<{ jobId: string; expectedTokenHash: string; report: DispatchReport }>) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

// after() 안에서 실행되는 실제 발사 로직 — 테스트에서 직접 호출해 검증할 수 있게 분리한다.
export async function dispatchTick(nextTick: NextTick, baseUrl: string, dependencies: ChainDispatchDependencies = {}): Promise<DispatchReport> {
  const doFetch = dependencies.fetchImpl ?? fetch
  const sleep = dependencies.sleepImpl ?? defaultSleep
  const now = dependencies.nowMs ?? Date.now
  const startedAt = now()
  const url = `${baseUrl.replace(/\/$/, "")}/api/sync/chain`

  let attempt = 0
  let last: DispatchReport | null = null

  while (attempt < SYNC_CHAIN_MAX_ATTEMPTS) {
    attempt += 1
    let waitMs = chainDispatchBackoffMs(attempt)
    let report: DispatchReport

    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${nextTick.token}` },
        body: JSON.stringify({ mode: "tick", jobId: nextTick.jobId }),
        // redirect를 따라가지 않는다 — 3xx면 fetch가 던지고, authorization 헤더가 재전송되지 않는다.
        redirect: "error",
        signal: AbortSignal.timeout(SYNC_CHAIN_ATTEMPT_TIMEOUT_MS),
      })
      // fetch는 4xx·5xx에 던지지 않는다 — 상태 코드를 직접 봐야 거부를 알아챌 수 있다.
      const classified = classifyChainDispatchStatus(response.status)
      report = {
        kind: classified.errorCategory === "accepted" ? "accepted" : classified.retryable ? "unconfirmed" : "rejected",
        attempt,
        maxAttempts: SYNC_CHAIN_MAX_ATTEMPTS,
        httpStatus: response.status,
        errorCategory: classified.errorCategory,
        retryable: classified.retryable,
        elapsedMs: now() - startedAt,
      }
      if (classified.retryable) {
        waitMs = parseRetryAfterMs(response.headers.get("retry-after")) ?? waitMs
      }
    } catch (error) {
      const classified = classifyChainDispatchError(error)
      report = {
        kind: "unconfirmed",
        attempt,
        maxAttempts: SYNC_CHAIN_MAX_ATTEMPTS,
        httpStatus: null,
        errorCategory: classified.errorCategory,
        retryable: classified.retryable,
        elapsedMs: now() - startedAt,
      }
    }

    last = report
    if (report.kind === "accepted") {
      // 한 번이라도 접수되면 즉시 끝낸다 — 추가 시도는 중복 발사가 된다.
      return report
    }
    if (!report.retryable || attempt >= SYNC_CHAIN_MAX_ATTEMPTS) {
      break
    }
    // 예산 안에 다음 시도가 온전히 들어가지 않으면 여기서 멈춘다 (배치 뒤 남은 maxDuration 보호).
    if (report.elapsedMs + waitMs + SYNC_CHAIN_ATTEMPT_TIMEOUT_MS > SYNC_CHAIN_TOTAL_BUDGET_MS) {
      break
    }
    await sleep(waitMs)
  }

  const final = last ?? {
    kind: "unconfirmed" as const,
    attempt,
    maxAttempts: SYNC_CHAIN_MAX_ATTEMPTS,
    httpStatus: null,
    errorCategory: "network" as const,
    retryable: true,
    elapsedMs: now() - startedAt,
  }

  try {
    await dependencies.onDispatchUnconfirmed?.({
      jobId: nextTick.jobId,
      expectedTokenHash: hashTickToken(nextTick.token),
      report: final,
    })
  } catch {
    // 표식 기록마저 실패하면 조용히 넘긴다 — 응답은 이미 반환됐고 수동 재개 경로가 남는다.
  }
  return final
}

// 발사가 접수를 확인하지 못했을 때의 표식 — 조건부 UPDATE 하나로 끝낸다.
//
// 상대가 이미 접수(claim)했다면 토큰이 회전돼 해시가 다르므로 이 UPDATE는 0행을 건드린다.
// 즉 "실제로 접수된 tick은 절대 interrupted로 덮이지 않는다"가 DB 조건으로 보장된다.
// 첫 요청이 접수됐는데 응답만 유실돼 재시도가 나간 경우도 같은 조건에 걸려 안전하다.
export async function markUnconfirmedDispatch(input: Readonly<{ jobId: string; expectedTokenHash: string; report: DispatchReport }>): Promise<void> {
  const { createSupabaseSyncJobRepository } = await import("./supabase-job-repository")
  await createSupabaseSyncJobRepository().markInterrupted({
    jobId: input.jobId,
    errorCode: chainDispatchErrorCode(input.report),
    errorMessage: chainDispatchErrorMessage(input.report),
    nowIso: new Date().toISOString(),
    expectedTokenHash: input.expectedTokenHash,
  })
}

// 배치가 예기치 못하게 터진 경우의 표식 — 소진한 토큰으로 조건부 기록한다.
export async function markTickCrashed(input: Readonly<{ jobId: string; expectedTokenHash: string }>): Promise<void> {
  const { createSupabaseSyncJobRepository } = await import("./supabase-job-repository")
  await createSupabaseSyncJobRepository().markInterrupted({
    jobId: input.jobId,
    errorCode: TICK_CRASHED_CODE,
    errorMessage: "동기화 배치 처리가 예기치 않게 중단됐습니다. 처리된 분량은 그대로 유지됩니다.",
    nowIso: new Date().toISOString(),
    expectedTokenHash: input.expectedTokenHash,
  })
}

// 접수 확인까지만 기다리는 발사 (after() 중첩 없음).
// 이미 after() 안에서 도는 경로(chain route)는 이 함수를 직접 await 한다.
export async function chainNextTick(nextTick: NextTick, baseUrl: string): Promise<DispatchReport> {
  return dispatchTick(nextTick, baseUrl, { onDispatchUnconfirmed: markUnconfirmedDispatch })
}

// 응답을 먼저 돌려주고 발사는 그 뒤에 — 서버 액션(시작·재개) 경로용.
export async function scheduleNextTick(nextTick: NextTick, baseUrl: string): Promise<void> {
  const { after } = await import("next/server")
  after(async () => {
    await chainNextTick(nextTick, baseUrl)
  })
}
