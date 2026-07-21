import { describe, expect, it } from "vitest"

import {
  checkPublicPageLiveWithRetry,
  LIVE_CHECK_ATTEMPTS,
  LIVE_CHECK_DELAYS_MS,
  LIVE_CHECK_REQUEST_TIMEOUT_MS,
  LIVE_CHECK_WORST_CASE_MS,
} from "@/lib/admin/publish-live-check"

const URL_UNDER_TEST = "https://flowercrm-seo.vercel.app/places/test-slug"

function makeFetchSequence(statuses: readonly (number | "timeout")[]): { fetchImpl: typeof fetch; calls: () => number } {
  let index = 0
  const fetchImpl = (() => {
    const step = statuses[index]
    index += 1
    if (step === "timeout") {
      const error = new Error("The operation was aborted")
      error.name = "AbortError"
      return Promise.reject(error)
    }
    return Promise.resolve(new Response("", { status: step ?? 500 }))
  }) as typeof fetch
  return { fetchImpl, calls: () => index }
}

const instantSleep = (): { sleep: (ms: number) => Promise<void>; slept: number[] } => {
  const slept: number[] = []
  return {
    sleep: (ms: number) => {
      slept.push(ms)
      return Promise.resolve()
    },
    slept,
  }
}

describe("게시 직후 공개 URL 확인 재시도", () => {
  it("succeeds immediately on the first 200 without sleeping", async () => {
    const { fetchImpl, calls } = makeFetchSequence([200])
    const { sleep, slept } = instantSleep()
    const result = await checkPublicPageLiveWithRetry(URL_UNDER_TEST, { fetchImpl, sleep })
    expect(result).toEqual({ live: true, attempts: 1 })
    expect(calls()).toBe(1)
    expect(slept).toEqual([])
  })

  it("retries after a 1s wait and succeeds on the second attempt", async () => {
    const { fetchImpl, calls } = makeFetchSequence([404, 200])
    const { sleep, slept } = instantSleep()
    const result = await checkPublicPageLiveWithRetry(URL_UNDER_TEST, { fetchImpl, sleep })
    expect(result).toEqual({ live: true, attempts: 2 })
    expect(calls()).toBe(2)
    expect(slept).toEqual([1000])
  })

  it("retries twice (1s then 2s) and succeeds on the third attempt", async () => {
    const { fetchImpl, calls } = makeFetchSequence([404, 404, 200])
    const { sleep, slept } = instantSleep()
    const result = await checkPublicPageLiveWithRetry(URL_UNDER_TEST, { fetchImpl, sleep })
    expect(result).toEqual({ live: true, attempts: 3 })
    expect(calls()).toBe(3)
    expect(slept).toEqual([1000, 2000])
  })

  it("reports not-live only after all three attempts fail", async () => {
    const { fetchImpl, calls } = makeFetchSequence([404, 500, 404])
    const { sleep, slept } = instantSleep()
    const failures: number[] = []
    const result = await checkPublicPageLiveWithRetry(URL_UNDER_TEST, { fetchImpl, sleep, onAttemptFailed: (attempt) => failures.push(attempt) })
    expect(result).toEqual({ live: false, attempts: 3 })
    expect(calls()).toBe(3)
    expect(failures).toEqual([1, 2, 3])
    // 마지막 시도 후에는 추가 대기가 없다.
    expect(slept).toEqual([1000, 2000])
  })

  it("treats a timed-out request as a failed attempt and keeps retrying", async () => {
    const { fetchImpl } = makeFetchSequence(["timeout", 200])
    const { sleep } = instantSleep()
    const details: string[] = []
    const result = await checkPublicPageLiveWithRetry(URL_UNDER_TEST, { fetchImpl, sleep, onAttemptFailed: (_attempt, detail) => details.push(detail) })
    expect(result).toEqual({ live: true, attempts: 2 })
    expect(details).toHaveLength(1)
  })

  it("keeps the worst-case budget inside maxDuration=30s with room for the rest of the action", () => {
    // 요청당 타임아웃은 기존 단일 시도 3.5초보다 짧다.
    expect(LIVE_CHECK_REQUEST_TIMEOUT_MS).toBeLessThan(3500)
    expect(LIVE_CHECK_ATTEMPTS).toBe(3)
    expect([...LIVE_CHECK_DELAYS_MS]).toEqual([1000, 2000])
    // 최악: 2.5s×3 + 1s + 2s = 10.5s — maxDuration 30s의 절반 이하.
    expect(LIVE_CHECK_WORST_CASE_MS).toBe(10_500)
    expect(LIVE_CHECK_WORST_CASE_MS).toBeLessThan(15_000)
  })
})
