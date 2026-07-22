import { describe, expect, it } from "vitest"

import { reverifyDelayedSeoPage, runAsyncPublicVerification, schedulePostPublishVerification, type VerificationRecord, type VerificationRepository } from "@/lib/seo-pages/publish-verification"

const PATH = "/places/test-slug"
const URL_UNDER_TEST = `https://flowercrm-seo.vercel.app${PATH}`

function makeRepository(): VerificationRepository & { readonly pendingPaths: string[]; readonly records: { path: string; record: VerificationRecord }[] } {
  const pendingPaths: string[] = []
  const records: { path: string; record: VerificationRecord }[] = []
  return {
    pendingPaths,
    records,
    markPending: (path) => {
      pendingPaths.push(path)
      return Promise.resolve()
    },
    recordResult: (path, record) => {
      records.push({ path, record })
      return Promise.resolve()
    },
  }
}

function fetchWith(statuses: readonly (number | "error")[]): typeof fetch {
  let index = 0
  const impl = () => {
    const step = statuses[index]
    index += 1
    if (step === "error") {
      return Promise.reject(new Error("network down"))
    }
    return Promise.resolve(new Response("", { status: step ?? 500 }))
  }
  return impl
}

const instantSleep = (): Promise<void> => Promise.resolve()

describe("게시 성공과 공개 확인 분리", () => {
  it("marks pending and registers the after callback before returning (redirect-safe ordering)", async () => {
    // Given
    const repository = makeRepository()
    const registered: (() => Promise<void>)[] = []

    // When: 게시 성공 직후 예약.
    await schedulePostPublishVerification({
      path: PATH,
      url: URL_UNDER_TEST,
      repository,
      registerAfter: (callback) => registered.push(callback),
      liveCheckDependencies: { fetchImpl: fetchWith([200]), sleep: instantSleep },
    })

    // Then: 반환 시점에 pending 마킹과 after 등록이 모두 끝나 있다 — 이후 redirect(throw)가 안전하다.
    expect(repository.pendingPaths).toEqual([PATH])
    expect(registered).toHaveLength(1)
    // 등록된 콜백은 아직 실행되지 않았다 (응답 이후 실행).
    expect(repository.records).toHaveLength(0)

    // 콜백 실행 시 verified 기록.
    await registered[0]?.()
    expect(repository.records).toEqual([{ path: PATH, record: { status: "verified", attempts: 1, lastHttpStatus: 200 } }])
  })

  it("keeps the publish flow alive even when pending marking fails (pre-migration safety)", async () => {
    const registered: (() => Promise<void>)[] = []
    await schedulePostPublishVerification({
      path: PATH,
      url: URL_UNDER_TEST,
      repository: {
        markPending: () => Promise.reject(new Error("column does not exist")),
        recordResult: () => Promise.resolve(),
      },
      registerAfter: (callback) => registered.push(callback),
      liveCheckDependencies: { fetchImpl: fetchWith([200]), sleep: instantSleep },
    })
    // markPending 실패에도 throw 없이 after 등록까지 완료된다.
    expect(registered).toHaveLength(1)
  })

  it("records verified on late success and delayed on budget exhaustion (never failed here)", async () => {
    // 3회차 성공 → verified
    const okRepo = makeRepository()
    await runAsyncPublicVerification({
      path: PATH,
      url: URL_UNDER_TEST,
      repository: okRepo,
      liveCheckDependencies: { fetchImpl: fetchWith([404, 404, 200]), sleep: instantSleep },
    })
    expect(okRepo.records[0]?.record).toEqual({ status: "verified", attempts: 3, lastHttpStatus: 200 })

    // 4회 소진 → delayed (failed 아님)
    const delayedRepo = makeRepository()
    await runAsyncPublicVerification({
      path: PATH,
      url: URL_UNDER_TEST,
      repository: delayedRepo,
      liveCheckDependencies: { fetchImpl: fetchWith([404, 404, 404, 404]), sleep: instantSleep },
    })
    expect(delayedRepo.records[0]?.record.status).toBe("delayed")

    // 네트워크 오류 연속도 failed로 오판하지 않고 delayed.
    const errorRepo = makeRepository()
    await runAsyncPublicVerification({
      path: PATH,
      url: URL_UNDER_TEST,
      repository: errorRepo,
      liveCheckDependencies: { fetchImpl: fetchWith(["error", "error", "error", "error"]), sleep: instantSleep },
    })
    expect(errorRepo.records[0]?.record).toEqual({ status: "delayed", attempts: 4, lastHttpStatus: null })
  })

  it("swallows repository failures in the async callback (operational log only)", async () => {
    await expect(
      runAsyncPublicVerification({
        path: PATH,
        url: URL_UNDER_TEST,
        repository: { markPending: () => Promise.resolve(), recordResult: () => Promise.reject(new Error("db down")) },
        liveCheckDependencies: { fetchImpl: fetchWith([200]), sleep: instantSleep },
      }),
    ).resolves.toBeUndefined()
  })
})

describe("드로어 진입 시 delayed 재확인", () => {
  it("upgrades delayed to verified when the single recheck returns 200", async () => {
    const repository = makeRepository()
    const status = await reverifyDelayedSeoPage({
      path: PATH,
      url: URL_UNDER_TEST,
      repository,
      liveCheckDependencies: { fetchImpl: fetchWith([200]), sleep: instantSleep },
    })
    expect(status).toBe("verified")
    expect(repository.records[0]?.record).toEqual({ status: "verified", attempts: 1, lastHttpStatus: 200 })
  })

  it("marks failed only when the recheck is still not 200 (운영 확인 필요)", async () => {
    const repository = makeRepository()
    const status = await reverifyDelayedSeoPage({
      path: PATH,
      url: URL_UNDER_TEST,
      repository,
      liveCheckDependencies: { fetchImpl: fetchWith([404]), sleep: instantSleep },
    })
    expect(status).toBe("failed")
    expect(repository.records[0]?.record).toEqual({ status: "failed", attempts: 1, lastHttpStatus: 404 })
  })
})
