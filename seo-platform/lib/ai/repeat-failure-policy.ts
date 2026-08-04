// 동일 place 반복 생성 실패 잠금 — 같은 오류 코드로 연속 2회 실패하면 잠시 멈추고 진단을 요구한다.
//
// LS파워솔루션 사례(2026-08-04): 결정적 조립 실패가 provider_error로 보고돼 사용자가 그대로 재시도했고,
// 같은 실패가 그대로 반복됐다. 결정적 오류는 몇 번을 눌러도 같은 결과이므로, 두 번째 실패 이후에는
// "반복 오류 — 관리자 진단 필요"로 막는 것이 기존 데이터도 지키고 비용(실호출 오류라면 API 호출)도 지킨다.
//
// 잠금은 영구가 아니다 — 마지막 실패로부터 LOCK_MINUTES가 지나면 1회 재시도가 다시 열린다
// (수정 배포 후 재검증 경로를 남기기 위해). 성공 이력이 하나라도 끼면 연속이 아니므로 잠그지 않는다.

export const REPEATED_FAILURE_LOCK_MINUTES = 30
const CONSECUTIVE_FAILURES_TO_LOCK = 2

// ai_generations 최근 이력(최신순)에서 읽는 최소 필드.
export type RecentGenerationOutcome = {
  readonly status: string
  readonly errorCode: string | null
  readonly createdAt: string
}

export type RepeatedGenerationBlockDecision =
  | { readonly blocked: false }
  | { readonly blocked: true; readonly errorCode: string; readonly consecutiveFailures: number; readonly lockedUntil: string }

export function decideRepeatedGenerationBlock(
  input: Readonly<{
    // 최신순 정렬 계약 — 첫 원소가 가장 최근 generation이다.
    recentOutcomes: readonly RecentGenerationOutcome[]
    now: Date
  }>,
): RepeatedGenerationBlockDecision {
  const [latest] = input.recentOutcomes
  if (latest?.status !== "failed" || latest.errorCode === null) {
    return { blocked: false }
  }

  // 최신부터 같은 코드의 failed가 몇 번 이어졌는지 센다 — 성공/다른 코드가 나오면 연속이 끊긴다.
  let consecutive = 0
  for (const outcome of input.recentOutcomes) {
    if (outcome.status !== "failed" || outcome.errorCode !== latest.errorCode) {
      break
    }
    consecutive += 1
  }
  if (consecutive < CONSECUTIVE_FAILURES_TO_LOCK) {
    return { blocked: false }
  }

  const lastFailureAt = Date.parse(latest.createdAt)
  if (Number.isNaN(lastFailureAt)) {
    // 시각을 읽을 수 없으면 보수적으로 잠근다 — 해제 시각은 지금 기준으로 계산한다.
    return { blocked: true, errorCode: latest.errorCode, consecutiveFailures: consecutive, lockedUntil: new Date(input.now.getTime() + REPEATED_FAILURE_LOCK_MINUTES * 60_000).toISOString() }
  }
  const lockedUntil = lastFailureAt + REPEATED_FAILURE_LOCK_MINUTES * 60_000
  if (input.now.getTime() >= lockedUntil) {
    return { blocked: false }
  }
  return { blocked: true, errorCode: latest.errorCode, consecutiveFailures: consecutive, lockedUntil: new Date(lockedUntil).toISOString() }
}
