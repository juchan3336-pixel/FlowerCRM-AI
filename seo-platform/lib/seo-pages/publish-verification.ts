// 게시 성공과 공개 확인의 분리 — DB 게시·revalidate가 성공하면 사용자에게는 즉시 성공을 알리고,
// 공개 URL 확인은 응답 이후(after)에서 실행해 seo_pages.verification_* 컬럼에만 기록한다.
// 네트워크 오류·예산 소진은 failed가 아니라 delayed로 기록한다 — failed는 드로어 재확인에서도 비정상일 때만.
import { ASYNC_VERIFICATION_PLAN, checkPublicPageLiveWithRetry, RECHECK_PLAN, type LiveCheckDependencies } from "@/lib/admin/publish-live-check"
import type { SeoPageVerificationStatus } from "@/types/database"

export type VerificationRecord = {
  readonly status: SeoPageVerificationStatus
  readonly attempts: number
  readonly lastHttpStatus: number | null
}

export type VerificationRepository = {
  // 게시 직후 pending 마킹 — 실패해도 게시 흐름을 깨지 않도록 호출부에서 안전 처리한다.
  readonly markPending: (path: string) => Promise<void>
  readonly recordResult: (path: string, record: VerificationRecord) => Promise<void>
}

export type SchedulePostPublishVerificationInput = {
  readonly path: string
  readonly url: string
  readonly repository: VerificationRepository
  // next/server의 after — 응답 전송 후 실행할 콜백 등록. redirect(throw) 이전에 반드시 등록되어야 한다.
  readonly registerAfter: (callback: () => Promise<void>) => void
  readonly liveCheckDependencies?: LiveCheckDependencies
}

// 게시 성공 직후 호출: pending 마킹 → after 콜백 등록. 반환 전에 등록이 끝나므로 이후 redirect가 안전하다.
export async function schedulePostPublishVerification(input: SchedulePostPublishVerificationInput): Promise<void> {
  try {
    await input.repository.markPending(input.path)
  } catch (error) {
    console.error("[publish-verification] failed to mark pending", { path: input.path, error: error instanceof Error ? error.message : String(error) })
  }
  input.registerAfter(async () => {
    await runAsyncPublicVerification(input)
  })
}

// after() 콜백 본문 — 첫 200이면 verified, 예산 소진(네트워크 오류 포함)이면 delayed. 여기서 failed는 기록하지 않는다.
export async function runAsyncPublicVerification(input: Omit<SchedulePostPublishVerificationInput, "registerAfter">): Promise<void> {
  try {
    const result = await checkPublicPageLiveWithRetry(input.url, ASYNC_VERIFICATION_PLAN, {
      ...input.liveCheckDependencies,
      onAttemptFailed: (attempt, detail) => {
        console.error("[publish-verification] attempt failed", { path: input.path, attempt, detail })
        input.liveCheckDependencies?.onAttemptFailed?.(attempt, detail)
      },
    })
    await input.repository.recordResult(input.path, {
      status: result.live ? "verified" : "delayed",
      attempts: result.attempts,
      lastHttpStatus: result.lastHttpStatus,
    })
  } catch (error) {
    // 검증 기록 실패는 게시와 무관한 운영 로그로만 남긴다 (다음 드로어 진입 시 재확인 기회가 있다).
    console.error("[publish-verification] async verification failed", { path: input.path, error: error instanceof Error ? error.message : String(error) })
  }
}

export type ReverifyInput = {
  readonly path: string
  readonly url: string
  readonly repository: Pick<VerificationRepository, "recordResult">
  readonly liveCheckDependencies?: LiveCheckDependencies
}

// 드로어 진입 시 delayed 상태만 1회 재확인 — 200이면 verified, 여전히 비정상이면 failed(운영 확인 필요).
export async function reverifyDelayedSeoPage(input: ReverifyInput): Promise<SeoPageVerificationStatus> {
  const result = await checkPublicPageLiveWithRetry(input.url, RECHECK_PLAN, input.liveCheckDependencies ?? {})
  const status: SeoPageVerificationStatus = result.live ? "verified" : "failed"
  await input.repository.recordResult(input.path, { status, attempts: result.attempts, lastHttpStatus: result.lastHttpStatus })
  return status
}
