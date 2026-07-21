// 게시 직후 공개 URL 확인 — ISR 전파가 확인보다 늦어 발생하는 일시적 오탐(13호점 cache-refresh-failed Toast)을 줄인다.
// 최대 3회 확인, 실패 시 1초 → 2초 대기 후 재확인. 첫 200이면 즉시 성공.
// 예산: 요청당 최대 2.5초 × 3회 + 대기 3초 = 최악 10.5초 — maxDuration=30(app/admin/places/page.tsx) 안에 여유 있게 들어온다.

export const LIVE_CHECK_ATTEMPTS = 3
export const LIVE_CHECK_DELAYS_MS = [1000, 2000] as const
// 기존 단일 시도 3.5초보다 짧게 잡아 재시도 합계가 이전 예산 수준을 크게 넘지 않도록 한다.
export const LIVE_CHECK_REQUEST_TIMEOUT_MS = 2500

export const LIVE_CHECK_WORST_CASE_MS =
  LIVE_CHECK_ATTEMPTS * LIVE_CHECK_REQUEST_TIMEOUT_MS + LIVE_CHECK_DELAYS_MS.reduce((total, delay) => total + delay, 0)

export type LiveCheckResult = {
  readonly live: boolean
  readonly attempts: number
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

export async function checkPublicPageLiveWithRetry(url: string, dependencies: LiveCheckDependencies = {}): Promise<LiveCheckResult> {
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const sleep = dependencies.sleep ?? defaultSleep

  for (let attempt = 1; attempt <= LIVE_CHECK_ATTEMPTS; attempt += 1) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
      }, LIVE_CHECK_REQUEST_TIMEOUT_MS)
      const response = await fetchImpl(url, { cache: "no-store", signal: controller.signal })
      clearTimeout(timer)
      if (response.status === 200) {
        return { live: true, attempts: attempt }
      }
      dependencies.onAttemptFailed?.(attempt, `HTTP ${String(response.status)}`)
    } catch (error) {
      dependencies.onAttemptFailed?.(attempt, error instanceof Error ? error.message : String(error))
    }
    const delay = LIVE_CHECK_DELAYS_MS[attempt - 1]
    if (attempt < LIVE_CHECK_ATTEMPTS && delay !== undefined) {
      await sleep(delay)
    }
  }
  return { live: false, attempts: LIVE_CHECK_ATTEMPTS }
}
