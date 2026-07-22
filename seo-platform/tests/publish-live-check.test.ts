import { describe, expect, it } from "vitest"

import { ASYNC_VERIFICATION_PLAN, checkPublicPageLiveWithRetry, RECHECK_PLAN, worstCaseMs } from "@/lib/admin/publish-live-check"

const URL_UNDER_TEST = "https://flowercrm-seo.vercel.app/places/test-slug"

export function makeFetchSequence(statuses: readonly (number | "timeout")[]): { fetchImpl: typeof fetch; calls: () => number } {
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

export const instantSleep = (): { sleep: (ms: number) => Promise<void>; slept: number[] } => {
  const slept: number[] = []
  return {
    sleep: (ms: number) => {
      slept.push(ms)
      return Promise.resolve()
    },
    slept,
  }
}

describe("공개 URL 확인 재시도 (비동기 검증 계획)", () => {
  it("succeeds immediately on the first 200 without sleeping", async () => {
    const { fetchImpl, calls } = makeFetchSequence([200])
    const { sleep, slept } = instantSleep()
    const result = await checkPublicPageLiveWithRetry(URL_UNDER_TEST, ASYNC_VERIFICATION_PLAN, { fetchImpl, sleep })
    expect(result).toEqual({ live: true, attempts: 1, lastHttpStatus: 200 })
    expect(calls()).toBe(1)
    expect(slept).toEqual([])
  })

  it("retries with 2s/4s/6s waits and succeeds on attempts 2-4", async () => {
    for (const [statuses, expectedAttempts, expectedSleeps] of [
      [[404, 200], 2, [2000]],
      [[404, 404, 200], 3, [2000, 4000]],
      [[404, 404, 404, 200], 4, [2000, 4000, 6000]],
    ] as const) {
      const { fetchImpl } = makeFetchSequence(statuses)
      const { sleep, slept } = instantSleep()
      const result = await checkPublicPageLiveWithRetry(URL_UNDER_TEST, ASYNC_VERIFICATION_PLAN, { fetchImpl, sleep })
      expect(result).toEqual({ live: true, attempts: expectedAttempts, lastHttpStatus: 200 })
      expect(slept).toEqual([...expectedSleeps])
    }
  })

  it("exhausts after four attempts and reports the last http status", async () => {
    const { fetchImpl, calls } = makeFetchSequence([404, 500, 404, 404])
    const { sleep, slept } = instantSleep()
    const failures: number[] = []
    const result = await checkPublicPageLiveWithRetry(URL_UNDER_TEST, ASYNC_VERIFICATION_PLAN, { fetchImpl, sleep, onAttemptFailed: (attempt) => failures.push(attempt) })
    expect(result).toEqual({ live: false, attempts: 4, lastHttpStatus: 404 })
    expect(calls()).toBe(4)
    expect(failures).toEqual([1, 2, 3, 4])
    expect(slept).toEqual([2000, 4000, 6000])
  })

  it("treats timeouts as failed attempts (null http status) and keeps retrying", async () => {
    const { fetchImpl } = makeFetchSequence(["timeout", 200])
    const { sleep } = instantSleep()
    const result = await checkPublicPageLiveWithRetry(URL_UNDER_TEST, ASYNC_VERIFICATION_PLAN, { fetchImpl, sleep })
    expect(result).toEqual({ live: true, attempts: 2, lastHttpStatus: 200 })
    const { fetchImpl: allTimeout } = makeFetchSequence(["timeout", "timeout", "timeout", "timeout"])
    const exhausted = await checkPublicPageLiveWithRetry(URL_UNDER_TEST, ASYNC_VERIFICATION_PLAN, { fetchImpl: allTimeout, sleep })
    expect(exhausted).toEqual({ live: false, attempts: 4, lastHttpStatus: null })
  })

  it("keeps the async budget well inside maxDuration=30s and the recheck to a single fast attempt", () => {
    expect(ASYNC_VERIFICATION_PLAN).toEqual({ attempts: 4, delaysMs: [2000, 4000, 6000], requestTimeoutMs: 2500 })
    // 최악: 2.5×4 + 12 = 22초 < 30초 (응답을 막지 않으므로 사용자 대기와 무관)
    expect(worstCaseMs(ASYNC_VERIFICATION_PLAN)).toBe(22_000)
    expect(worstCaseMs(ASYNC_VERIFICATION_PLAN)).toBeLessThan(30_000)
    expect(RECHECK_PLAN).toEqual({ attempts: 1, delaysMs: [], requestTimeoutMs: 2500 })
  })
})
