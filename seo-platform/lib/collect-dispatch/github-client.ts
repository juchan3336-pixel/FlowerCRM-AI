// Collect 외부 예약 dispatch — GitHub API 호출.
//
// 저장소·워크플로·ref는 policy에 고정돼 있고 여기서 바뀌지 않는다. 모든 요청은 호출자가 준 신호
// (전체 기한의 남은 시간) 안에서만 돈다. 오류 본문은 읽지도, 밖으로 내보내지도 않는다.
import { BUSY_RUN_STATUSES, COLLECT_REPOSITORY } from "@/lib/collect-dispatch/policy"
import type { GithubDispatchResult } from "@/lib/collect-dispatch/service"

const API_ROOT = "https://api.github.com"
// 2022-11-28에서 dispatch 성공은 본문 없는 204다. run id를 본문으로 돌려주는 더 새 버전
// (2026-03-10)으로 올리는 것은 후속 작업이다 — 그때도 동작하도록 2xx 전체를 접수로 보고
// run id는 본문에 있을 때만 읽는다. 그 전까지 run은 run 이름의 dispatch id로 찾는다.
const API_VERSION = "2022-11-28"

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

function headers(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": API_VERSION,
    "user-agent": "flowercrm-collect-dispatch",
  }
}

function workflowUrl(suffix: string): string {
  const { owner, repo, workflow } = COLLECT_REPOSITORY
  return `${API_ROOT}/repos/${owner}/${repo}/actions/workflows/${workflow}/${suffix}`
}

async function countRunsWithStatus(token: string, status: string, signal: AbortSignal, fetchImpl: FetchLike): Promise<number> {
  const response = await fetchImpl(workflowUrl(`runs?status=${status}&per_page=1`), { method: "GET", headers: headers(token), signal })
  if (!response.ok) throw new Error(`run status check failed: ${String(response.status)}`)
  const body: unknown = await response.json()
  const count = typeof body === "object" && body !== null ? (body as { total_count?: unknown }).total_count : undefined
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) throw new Error("run status check returned no count")
  return count
}

/**
 * 진행·대기 중인 run 수. 다섯 상태를 동시에 조회하므로 걸리는 시간은 한 번의 요청과 같다.
 * 하나라도 확인하지 못하면 throw한다 — 모르는 채로 0을 돌려주지 않는다.
 */
export async function countActiveCollectRuns(token: string, signal: AbortSignal, fetchImpl: FetchLike = fetch): Promise<number> {
  const counts = await Promise.all(BUSY_RUN_STATUSES.map((status) => countRunsWithStatus(token, status, signal, fetchImpl)))
  return counts.reduce((total, count) => total + count, 0)
}

export async function dispatchCollectWorkflow(
  token: string,
  inputs: Record<string, string>,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<GithubDispatchResult> {
  // 기한이 이미 지났으면 시작하지 않는다 — 이 경우는 보내지 않은 것이 확실하다.
  if (signal.aborted) return { kind: "rejected", httpStatus: 0 }
  let response: Response
  try {
    response = await fetchImpl(workflowUrl("dispatches"), {
      method: "POST",
      headers: { ...headers(token), "content-type": "application/json" },
      body: JSON.stringify({ ref: COLLECT_REPOSITORY.ref, inputs }),
      signal,
    })
  } catch {
    // 시간 초과·연결 끊김: 요청이 도착했는지 알 수 없다.
    return { kind: "unknown", httpStatus: null }
  }
  if (response.status >= 200 && response.status < 300) {
    return { kind: "accepted", httpStatus: response.status, runId: await readRunId(response) }
  }
  // 4xx는 GitHub이 받지 않았다는 뜻이다(인증·권한·경로·입력·rate limit). 그 밖은 알 수 없다.
  if (response.status >= 400 && response.status < 500) return { kind: "rejected", httpStatus: response.status }
  return { kind: "unknown", httpStatus: response.status }
}

async function readRunId(response: Response): Promise<number | null> {
  try {
    const text = await response.text()
    if (text === "") return null
    const body: unknown = JSON.parse(text)
    const runId = typeof body === "object" && body !== null ? (body as { workflow_run_id?: unknown }).workflow_run_id : undefined
    return typeof runId === "number" && Number.isSafeInteger(runId) ? runId : null
  } catch {
    return null
  }
}
