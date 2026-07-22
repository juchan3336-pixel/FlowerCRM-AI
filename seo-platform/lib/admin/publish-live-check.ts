// 게시 후 공개 URL 확인 유틸 — 게시 응답에서는 실행되지 않고, after() 비동기 검증과
// 드로어 진입 시 delayed 재확인(1회)에서만 사용된다 (fix/publish-verification-decoupling).
// 사용자 응답을 막지 않으므로 예산은 함수 수명(maxDuration=30) 안에서만 제약된다.

export type LiveCheckPlan = {
  readonly attempts: number
  readonly delaysMs: readonly number[]
  readonly requestTimeoutMs: number
}

// 비동기 검증 계획: 최대 4회, 실패 시 2초·4초·6초 대기, 요청당 2.5초 — 최악 2.5×4+12 = 22초 < maxDuration 30초.
export const ASYNC_VERIFICATION_PLAN: LiveCheckPlan = {
  attempts: 4,
  delaysMs: [2000, 4000, 6000],
  requestTimeoutMs: 2500,
}

// 드로어 진입 시 delayed 재확인: 단 1회, 대기 없음.
export const RECHECK_PLAN: LiveCheckPlan = {
  attempts: 1,
  delaysMs: [],
  requestTimeoutMs: 2500,
}

export function worstCaseMs(plan: LiveCheckPlan): number {
  return plan.attempts * plan.requestTimeoutMs + plan.delaysMs.reduce((total, delay) => total + delay, 0)
}

export type LiveCheckResult = {
  readonly live: boolean
  readonly attempts: number
  // 마지막 시도의 HTTP 상태 — 네트워크 오류/타임아웃이면 null.
  readonly lastHttpStatus: number | null
}

export type LiveCheckDependencies = {
  readonly fetchImpl?: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
  readonly onAttemptFailed?: (attempt: number, detail: string) => void
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export async function checkPublicPageLiveWithRetry(url: string, plan: LiveCheckPlan, dependencies: LiveCheckDependencies = {}): Promise<LiveCheckResult> {
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const sleep = dependencies.sleep ?? defaultSleep

  let lastHttpStatus: number | null = null
  for (let attempt = 1; attempt <= plan.attempts; attempt += 1) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
      }, plan.requestTimeoutMs)
      const response = await fetchImpl(url, { cache: "no-store", signal: controller.signal })
      clearTimeout(timer)
      lastHttpStatus = response.status
      if (response.status === 200) {
        return { live: true, attempts: attempt, lastHttpStatus: 200 }
      }
      dependencies.onAttemptFailed?.(attempt, `HTTP ${String(response.status)}`)
    } catch (error) {
      lastHttpStatus = null
      dependencies.onAttemptFailed?.(attempt, error instanceof Error ? error.message : String(error))
    }
    const delay = plan.delaysMs[attempt - 1]
    if (attempt < plan.attempts && delay !== undefined) {
      await sleep(delay)
    }
  }
  return { live: false, attempts: plan.attempts, lastHttpStatus }
}
