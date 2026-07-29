// self-chain 발사 — 응답을 먼저 돌려주고, 다음 1배치를 서버가 스스로 호출한다.
// 브라우저는 여기에 전혀 관여하지 않는다 (화면을 닫아도 계속 진행되는 이유).
//
// dispatchTick(순수 fetch)과 scheduleNextTick(after 예약)을 나눠 둔다 — 발사 규약(헤더·redirect 금지·
// 타임아웃)을 next/server 없이 단위 테스트할 수 있어야 하기 때문이다.
import type { NextTick } from "./job-service"

export const SELF_CHAIN_TIMEOUT_MS = 30_000

export type ChainDispatchDependencies = {
  readonly fetchImpl?: typeof fetch
  readonly onDispatchFailed?: (jobId: string) => Promise<void>
}

// after() 안에서 실행되는 실제 발사 로직 — 테스트에서 직접 호출해 검증할 수 있게 분리한다.
export async function dispatchTick(nextTick: NextTick, baseUrl: string, dependencies: ChainDispatchDependencies = {}): Promise<void> {
  const doFetch = dependencies.fetchImpl ?? fetch
  try {
    await doFetch(`${baseUrl.replace(/\/$/, "")}/api/sync/chain`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${nextTick.token}` },
      body: JSON.stringify({ mode: "tick", jobId: nextTick.jobId }),
      // redirect를 따라가지 않는다 — 3xx면 fetch가 던지고, authorization 헤더가 재전송되지 않는다.
      redirect: "error",
      signal: AbortSignal.timeout(SELF_CHAIN_TIMEOUT_MS),
    })
  } catch {
    // 발사 실패 — job은 interrupted로 남고 사용자가 관리자에서 1회 재개한다 (자동 전체 재실행 금지).
    try {
      await dependencies.onDispatchFailed?.(nextTick.jobId)
    } catch {
      // 표식 기록마저 실패하면 조용히 넘긴다 — 응답은 이미 반환됐고 수동 재개 경로가 남는다.
    }
  }
}

export async function scheduleNextTick(nextTick: NextTick, baseUrl: string): Promise<void> {
  const { after } = await import("next/server")
  after(async () => {
    await dispatchTick(nextTick, baseUrl, {
      onDispatchFailed: async (jobId) => {
        const { createSupabaseSyncJobRepository } = await import("./supabase-job-repository")
        await createSupabaseSyncJobRepository().markInterrupted({ jobId, errorCode: "chain-dispatch-failed", nowIso: new Date().toISOString() })
      },
    })
  })
}
