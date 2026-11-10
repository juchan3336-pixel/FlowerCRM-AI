// Enrich 외부 예약 dispatch — 한 번의 호출이 하는 일.
//
// 순서가 곧 안전장치다:
//   1) 제어 행이 꺼져 있으면 아무것도 하지 않는다.
//   2) 이번 slot을 DB에서 원자적으로 잡는다. 이미 잡혔거나, 결과를 모르는 과거 dispatch가 남아
//      있으면 여기서 끝난다.
//   3) 워크플로에 진행·대기 중인 run이 있는지 확인한다. 있거나, 확인 자체가 실패하면 보내지 않는다.
//   4) "보내는 중"을 먼저 기록하고 그다음에 보낸다. 응답을 못 받았거나 기록에 실패하면 그 행은
//      결과 불명으로 남아 이후 모든 slot을 막는다 — 다시 보내는 것은 사람이 확인한 뒤의 일이다.
// GitHub의 concurrency 그룹은 실행 1개 + 대기 1개만 유지하고 새 대기가 기존 대기를 대체하므로
// 중복 방지 수단으로 쓰지 않는다. 수동 실행과의 마지막 경쟁까지 막아 주지는 않는다.
import { slotForTime, workflowInputs, type EnrichDispatchMode, type EnrichDispatchOutcome } from "@/lib/enrich-dispatch/policy"

export type DispatchControl = { readonly enabled: boolean; readonly mode: EnrichDispatchMode }

export type SlotClaim = "claimed" | "duplicate" | "blocked_unknown"

export type LedgerUpdate =
  | { readonly status: "busy" | "check_failed" | "dispatching" }
  | { readonly status: "sent"; readonly httpStatus: number; readonly runId: number | null }
  | { readonly status: "rejected"; readonly httpStatus: number }
  | { readonly status: "unknown"; readonly httpStatus: number | null }

/** dispatch 결과. accepted가 아니면서 4xx인 것만 "보내지지 않았다"가 확실하다. */
export type GithubDispatchResult =
  | { readonly kind: "accepted"; readonly httpStatus: number; readonly runId: number | null }
  | { readonly kind: "rejected"; readonly httpStatus: number }
  | { readonly kind: "unknown"; readonly httpStatus: number | null }

export type EnrichDispatchDependencies = {
  readonly readControl: () => Promise<DispatchControl>
  readonly claimSlot: (slot: string, dispatchId: string) => Promise<SlotClaim>
  readonly recordSlot: (slot: string, update: LedgerUpdate) => Promise<void>
  /** 진행·대기 중인 run 수. 확인할 수 없으면 throw한다. */
  readonly countActiveRuns: () => Promise<number>
  readonly dispatchWorkflow: (inputs: Record<string, string>) => Promise<GithubDispatchResult>
  readonly newDispatchId: () => string
}

export async function runEnrichDispatchTick(deps: EnrichDispatchDependencies, { nowMs }: { readonly nowMs: number }): Promise<EnrichDispatchOutcome> {
  const control = await deps.readControl()
  if (!control.enabled) return { kind: "noop", reason: "disabled" }

  const slot = slotForTime(nowMs)
  const dispatchId = deps.newDispatchId()
  const claim = await deps.claimSlot(slot, dispatchId)
  if (claim === "duplicate") return { kind: "noop", reason: "duplicate-slot" }
  if (claim === "blocked_unknown") return { kind: "noop", reason: "blocked-unknown" }

  let activeRuns: number
  try {
    activeRuns = await deps.countActiveRuns()
  } catch {
    // 상태를 모르는 채로 보내지 않는다.
    await deps.recordSlot(slot, { status: "check_failed" })
    return { kind: "noop", reason: "check-failed" }
  }
  if (activeRuns > 0) {
    await deps.recordSlot(slot, { status: "busy" })
    return { kind: "noop", reason: "busy" }
  }

  // 여기서 실패하면 아직 아무것도 보내지 않았다 — 예외는 호출자에게 그대로 올라간다.
  await deps.recordSlot(slot, { status: "dispatching" })

  const result = await deps.dispatchWorkflow(workflowInputs(control.mode, dispatchId))
  // 아래 기록이 실패하면 행은 dispatching으로 남고, claim 규칙이 그것을 결과 불명으로 취급한다.
  if (result.kind === "accepted") {
    await deps.recordSlot(slot, { status: "sent", httpStatus: result.httpStatus, runId: result.runId })
    return { kind: "sent", slot, mode: control.mode, runId: result.runId }
  }
  if (result.kind === "rejected") {
    await deps.recordSlot(slot, { status: "rejected", httpStatus: result.httpStatus })
    return { kind: "rejected", slot, httpStatus: result.httpStatus }
  }
  await deps.recordSlot(slot, { status: "unknown", httpStatus: result.httpStatus })
  return { kind: "unknown", slot }
}
