// Enrich 외부 예약 dispatch — GitHub API 호출.
//
// 저장소·워크플로·ref는 policy에 고정돼 있고 여기서 바뀌지 않는다. 모든 요청은 유한 시간 안에
// 끝난다. 오류 본문은 읽지도, 밖으로 내보내지도 않는다(상태 코드만 쓴다).
import { BUSY_RUN_STATUSES, ENRICH_REPOSITORY } from "@/lib/enrich-dispatch/policy"
import type { GithubDispatchResult } from "@/lib/enrich-dispatch/service"

const API_ROOT = "https://api.github.com"
// 이 버전에서 dispatch 성공은 본문 없는 204다. 본문이 오는 버전으로 올려도 동작하도록
// 2xx 전체를 접수로 보고, run id는 본문에 있을 때만 읽는다.
const API_VERSION = "2022-11-28"
const REQUEST_TIMEOUT_MS = 8000

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

function headers(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": API_VERSION,
    "user-agent": "flowercrm-enrich-dispatch",
  }
}

function workflowUrl(suffix: string): string {
  const { owner, repo, workflow } = ENRICH_REPOSITORY
  return `${API_ROOT}/repos/${owner}/${repo}/actions/workflows/${workflow}/${suffix}`
}

/** 진행·대기 중인 run 수. 하나라도 확인하지 못하면 throw한다 — 모르는 채로 0을 돌려주지 않는다. */
export async function countActiveEnrichRuns(token: string, fetchImpl: FetchLike = fetch): Promise<number> {
  let total = 0
  for (const status of BUSY_RUN_STATUSES) {
    const response = await fetchImpl(workflowUrl(`runs?status=${status}&per_page=1`), {
      method: "GET",
      headers: headers(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`run status check failed: ${String(response.status)}`)
    const body: unknown = await response.json()
    const count = typeof body === "object" && body !== null ? (body as { total_count?: unknown }).total_count : undefined
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) throw new Error("run status check returned no count")
    total += count
  }
  return total
}

export async function dispatchEnrichWorkflow(
  token: string,
  inputs: Record<string, string>,
  fetchImpl: FetchLike = fetch,
): Promise<GithubDispatchResult> {
  let response: Response
  try {
    response = await fetchImpl(workflowUrl("dispatches"), {
      method: "POST",
      headers: { ...headers(token), "content-type": "application/json" },
      body: JSON.stringify({ ref: ENRICH_REPOSITORY.ref, inputs }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
