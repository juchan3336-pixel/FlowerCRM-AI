// self-chain 발사 — 다음 1배치를 서버가 스스로 호출한다.
// 브라우저는 여기에 전혀 관여하지 않는다 (화면을 닫아도 계속 진행되는 이유).
//
// 발사한 쪽은 "접수(202) 확인"까지만 기다린다. 배치 완료를 기다리면 안 된다 —
// 배치 1회는 Production 실측 34~43초이고 이 타임아웃은 30초라, 완료를 기다리는 구조에서는
// 정상 진행 중인 job을 매번 발사 실패로 오인해 interrupted로 닫아버린다 (2026-07-29 장애).
//
// dispatchTick(순수 fetch)과 scheduleNextTick(after 예약)을 나눠 둔다 — 발사 규약(헤더·redirect 금지·
// 타임아웃)을 next/server 없이 단위 테스트할 수 있어야 하기 때문이다.
import { hashTickToken } from "./job-policy"
import type { NextTick } from "./job-service"

// 접수 응답은 수백 ms에 돌아온다. 30초는 콜드스타트까지 감싸는 여유값이다.
export const SELF_CHAIN_TIMEOUT_MS = 30_000

export const DISPATCH_FAILED_CODE = "chain-dispatch-failed"

// accepted: 상대가 tick을 접수했다 (202 등 2xx). 이후 진행은 상대 invocation의 책임이다.
// rejected: 상대가 응답으로 거부했다 (4xx·5xx). 그 tick은 앞으로도 실행되지 않는다.
// unconfirmed: 응답을 보지 못했다 (타임아웃·네트워크 오류). 접수됐는지 알 수 없다.
export type DispatchOutcome = "accepted" | "rejected" | "unconfirmed"

export type ChainDispatchDependencies = {
  readonly fetchImpl?: typeof fetch
  // 접수되지 않았을 가능성이 있을 때만 호출된다 (rejected·unconfirmed).
  // 실제 표식 여부는 토큰 해시 CAS가 최종 판정한다 — 아래 markUnconfirmedDispatch 참조.
  readonly onDispatchUnconfirmed?: (input: Readonly<{ jobId: string; expectedTokenHash: string; outcome: DispatchOutcome }>) => Promise<void>
}

// after() 안에서 실행되는 실제 발사 로직 — 테스트에서 직접 호출해 검증할 수 있게 분리한다.
export async function dispatchTick(nextTick: NextTick, baseUrl: string, dependencies: ChainDispatchDependencies = {}): Promise<DispatchOutcome> {
  const doFetch = dependencies.fetchImpl ?? fetch
  let outcome: DispatchOutcome
  try {
    const response = await doFetch(`${baseUrl.replace(/\/$/, "")}/api/sync/chain`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${nextTick.token}` },
      body: JSON.stringify({ mode: "tick", jobId: nextTick.jobId }),
      // redirect를 따라가지 않는다 — 3xx면 fetch가 던지고, authorization 헤더가 재전송되지 않는다.
      redirect: "error",
      signal: AbortSignal.timeout(SELF_CHAIN_TIMEOUT_MS),
    })
    // fetch는 4xx·5xx에 던지지 않는다 — 상태 코드를 직접 봐야 거부를 알아챌 수 있다.
    outcome = response.ok ? "accepted" : "rejected"
  } catch {
    outcome = "unconfirmed"
  }

  if (outcome !== "accepted") {
    try {
      await dependencies.onDispatchUnconfirmed?.({ jobId: nextTick.jobId, expectedTokenHash: hashTickToken(nextTick.token), outcome })
    } catch {
      // 표식 기록마저 실패하면 조용히 넘긴다 — 응답은 이미 반환됐고 수동 재개 경로가 남는다.
    }
  }
  return outcome
}

// 발사가 접수를 확인하지 못했을 때의 표식 — 조건부 UPDATE 하나로 끝낸다.
//
// 상대가 이미 접수(claim)했다면 토큰이 회전돼 해시가 다르므로 이 UPDATE는 0행을 건드린다.
// 즉 "실제로 접수된 tick은 절대 interrupted로 덮이지 않는다"가 DB 조건으로 보장된다.
// 접수되지 않은 경우에만 interrupted가 찍혀 관리자 화면에 "이어서 진행"이 노출된다.
export async function markUnconfirmedDispatch(input: Readonly<{ jobId: string; expectedTokenHash: string }>): Promise<void> {
  const { createSupabaseSyncJobRepository } = await import("./supabase-job-repository")
  await createSupabaseSyncJobRepository().markInterrupted({
    jobId: input.jobId,
    errorCode: DISPATCH_FAILED_CODE,
    nowIso: new Date().toISOString(),
    expectedTokenHash: input.expectedTokenHash,
  })
}

// 접수 확인까지만 기다리는 발사 (after() 중첩 없음).
// 이미 after() 안에서 도는 경로(chain route)는 이 함수를 직접 await 한다.
export async function chainNextTick(nextTick: NextTick, baseUrl: string): Promise<DispatchOutcome> {
  return dispatchTick(nextTick, baseUrl, { onDispatchUnconfirmed: markUnconfirmedDispatch })
}

// 응답을 먼저 돌려주고 발사는 그 뒤에 — 서버 액션(시작·재개) 경로용.
export async function scheduleNextTick(nextTick: NextTick, baseUrl: string): Promise<void> {
  const { after } = await import("next/server")
  after(async () => {
    await chainNextTick(nextTick, baseUrl)
  })
}
