// 배포 상태 머신 — 소재 변형 한 건이 검수·승인·게시 확인까지 가는 길.
//
//   사람 게시: draft → needs_review → approved → manual_ready → manual_confirmed
//   API 게시:  draft → needs_review → approved → queued → publishing → published | unknown | failed
//
// 내보내기(manual_ready)는 게시 성공이 아니다. 게시 URL을 사람이 확인해야 manual_confirmed가 된다.
// API가 접수 후 응답 없이 끊기면 unknown으로 멈춘다 — 중복 게시를 막기 위해 자동 재시도 전이는 없고,
// 조회로 확인한 뒤 published/failed로만 정리한다. 실패한 소재를 다시 내보내려면 draft로 되돌려 재승인한다.
import type { DistributionStatus, PublishMode } from "./types"

const TRANSITIONS: Readonly<Record<DistributionStatus, readonly DistributionStatus[]>> = {
  draft: ["needs_review"],
  needs_review: ["approved", "draft"],
  approved: ["manual_ready", "queued", "draft"],
  manual_ready: ["manual_confirmed", "draft"],
  manual_confirmed: [],
  queued: ["publishing", "draft"],
  publishing: ["published", "unknown", "failed"],
  unknown: ["published", "failed"],
  published: [],
  failed: ["draft"],
}

const MANUAL_ONLY: ReadonlySet<DistributionStatus> = new Set(["manual_ready", "manual_confirmed"])
const API_ONLY: ReadonlySet<DistributionStatus> = new Set(["queued", "publishing", "published", "unknown", "failed"])

export function canTransitionDistribution(from: DistributionStatus, to: DistributionStatus, publishMode: PublishMode): boolean {
  if (!TRANSITIONS[from].includes(to)) {
    return false
  }
  // 이미 외부에 접수된 작업의 결과 기록은 채널의 현재 설정과 무관하게 허용한다.
  // 접수 후 운영자가 채널을 중지해도 게시 여부를 확인해 정리할 수 있어야 한다. 중지는 새 진입만 막는다.
  if (from === "publishing" || from === "unknown") {
    return true
  }
  // 수정(draft로 되돌리기)은 게시 방식과 무관하게 허용한다.
  if (to === "draft") {
    return true
  }
  if (MANUAL_ONLY.has(to)) {
    return publishMode === "manual"
  }
  if (API_ONLY.has(to)) {
    return publishMode === "api"
  }
  // 검수·승인 단계 — 배포가 중지된 채널은 승인까지도 가지 않는다.
  return publishMode !== "disabled"
}

export function isTerminalDistributionStatus(status: DistributionStatus): boolean {
  return TRANSITIONS[status].length === 0
}

// 실제로 외부에 게시된 것으로 셀 수 있는 상태
export function isPostedStatus(status: DistributionStatus): boolean {
  return status === "manual_confirmed" || status === "published"
}
