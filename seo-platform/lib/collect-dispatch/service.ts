// Collect 외부 예약 dispatch — 한 번의 호출이 하는 일.
//
// 판단은 전부 DB가 한다. 이 코드는 DB가 허락한 순간에만 다음 단계로 간다:
//   1) claim   — 제어 행을 잠근 채로: 꺼져 있으면 끝, 아직 끝나지 않은 다른 시도(claimed·
//                dispatching·unknown)가 하나라도 있으면 끝, 이 slot이 이미 있으면 끝.
//                통과하면 이 호출만의 dispatch id로 slot을 소유한다.
//   2) 확인    — 워크플로에 진행·대기 중인 run이 있거나 확인 자체가 실패하면 보내지 않는다.
//   3) prepare — 보내기 직전에 다시 제어 행을 잠그고: 여전히 켜져 있는가, 이 slot이 여전히 이
//                dispatch id의 것이고 claimed 상태인가. 통과하면 dispatching으로 바꾸고 그 순간의
//                mode를 돌려준다. 쓰기 여부는 처음 읽은 값이 아니라 이 값으로 정한다.
//                "멈춤"의 경계는 이 prepare의 커밋이다 — 그 전에 끄면 보내지 않는다.
//   4) dispatch 후 결과를 같은 dispatch id·기대 상태 조건으로 기록한다. 응답을 못 받았거나
//      기록에 실패하면 행은 결과 불명으로 남아 이후 모든 시도를 막는다. 다시 보내는 일은 없다.
//
// 시간: 호출 전체에 절대 기한 하나가 있고, 그 끝의 일부(RECORD_RESERVE_MS)는 결과 기록 몫으로
// 떼어 둔다. 새 요청은 "작업 기한" 안에서만 시작한다 — 모든 await 뒤에 남은 시간을 다시 보고,
// 기한이 지났으면 dispatch 자체를 호출하지 않는다. 기록은 전체 기한까지만 기다린다.
//
// GitHub의 concurrency 그룹은 실행 1개 + 대기 1개만 유지하고 새 대기가 기존 대기를 대체하므로
// 중복 방지 수단으로 쓰지 않는다. 수동 실행과의 마지막 경쟁까지 막아 주지는 않는다.
import { workflowInputs, type CollectDispatchMode, type CollectDispatchOutcome } from "@/lib/collect-dispatch/policy"

export type SlotClaim = "claimed" | "duplicate" | "blocked" | "disabled"

export type DispatchPreparation = CollectDispatchMode | "disabled" | "lost"

/**
 * claimed 상태에서 끝나는 기록(아무것도 보내지 않음)과 dispatching 상태에서 끝나는 기록.
 * not_sent는 prepare까지 됐지만 시간이 없어 POST를 시작하지 않은 경우다 — 보내지 않은 것이 확실하다.
 */
export type LedgerFinish =
  | { readonly from: "claimed"; readonly status: "busy" | "check_failed" | "out_of_time" }
  | { readonly from: "dispatching"; readonly status: "not_sent" }
  | { readonly from: "dispatching"; readonly status: "sent"; readonly httpStatus: number; readonly runId: number | null }
  | { readonly from: "dispatching"; readonly status: "rejected"; readonly httpStatus: number }
  | { readonly from: "dispatching"; readonly status: "unknown"; readonly httpStatus: number | null }

/** dispatch 결과. accepted가 아니면서 4xx인 것만 "보내지지 않았다"가 확실하다. */
export type GithubDispatchResult =
  | { readonly kind: "accepted"; readonly httpStatus: number; readonly runId: number | null }
  | { readonly kind: "rejected"; readonly httpStatus: number }
  | { readonly kind: "unknown"; readonly httpStatus: number | null }

export type CollectDispatchDependencies = {
  readonly claimSlot: (slot: string, dispatchId: string, signal: AbortSignal) => Promise<SlotClaim>
  readonly prepareDispatch: (slot: string, dispatchId: string, signal: AbortSignal) => Promise<DispatchPreparation>
  /** 조건(slot·dispatch id·기대 상태)에 맞는 행이 정확히 하나 바뀌었을 때만 true. */
  readonly finishSlot: (slot: string, dispatchId: string, finish: LedgerFinish, signal: AbortSignal) => Promise<boolean>
  /** 진행·대기 중인 run 수. 확인할 수 없으면 throw한다. */
  readonly countActiveRuns: (signal: AbortSignal) => Promise<number>
  readonly dispatchWorkflow: (inputs: Record<string, string>, signal: AbortSignal) => Promise<GithubDispatchResult>
  readonly newDispatchId: () => string
}

/** 전체 기한의 끝에서 결과 기록을 위해 떼어 두는 시간. 이 구간에서는 새 요청을 시작하지 않는다. */
export const RECORD_RESERVE_MS = 5000
/** prepare를 시작하려면 작업 기한까지 최소한 이만큼 남아 있어야 한다. */
export const MIN_DISPATCH_BUDGET_MS = 6000
/** prepare가 끝난 뒤 POST를 시작하려면 작업 기한까지 최소한 이만큼 남아 있어야 한다. */
export const MIN_POST_BUDGET_MS = 3000

export type CollectDispatchTick = {
  /** 인증된 요청의 timestamp에서 나온 slot. 수신 시각이 아니다. */
  readonly slot: string
  /** 이 호출 전체의 절대 기한 (epoch ms). */
  readonly deadlineAtMs: number
  readonly now?: () => number
}

/** 남은 시간만큼만 유효한 신호. 남은 시간이 없으면 이미 중단된 신호다 — 1ms짜리 새 신호가 아니다. */
function signalFor(remainingMs: number): AbortSignal {
  return remainingMs <= 0 ? AbortSignal.abort() : AbortSignal.timeout(remainingMs)
}

export async function runCollectDispatchTick(
  deps: CollectDispatchDependencies,
  { slot, deadlineAtMs, now = Date.now }: CollectDispatchTick,
): Promise<CollectDispatchOutcome> {
  const workRemaining = () => deadlineAtMs - RECORD_RESERVE_MS - now()
  const workSignal = () => signalFor(workRemaining())
  // 기록은 전체 기한까지만 기다린다. 매번 새 시간을 받지 않는다.
  const recordSignal = () => signalFor(deadlineAtMs - now())

  // 시작할 시간조차 없으면 아무것도 건드리지 않는다.
  if (workRemaining() < MIN_DISPATCH_BUDGET_MS) return { kind: "noop", reason: "out-of-time" }

  const dispatchId = deps.newDispatchId()
  const claim = await deps.claimSlot(slot, dispatchId, workSignal())
  if (claim === "disabled") return { kind: "noop", reason: "disabled" }
  if (claim === "duplicate") return { kind: "noop", reason: "duplicate-slot" }
  if (claim === "blocked") return { kind: "noop", reason: "blocked" }

  // 여기부터는 slot을 소유한다. 보내지 않고 끝낼 때는 그 사실을 기록해 slot을 놓는다.
  const release = async (status: "busy" | "check_failed" | "out_of_time", reason: "busy" | "check-failed" | "out-of-time") => {
    await deps.finishSlot(slot, dispatchId, { from: "claimed", status }, recordSignal())
    return { kind: "noop", reason } as const
  }

  if (workRemaining() < MIN_DISPATCH_BUDGET_MS) return release("out_of_time", "out-of-time")

  let activeRuns: number
  try {
    activeRuns = await deps.countActiveRuns(workSignal())
  } catch {
    // 상태를 모르는 채로 보내지 않는다.
    return release("check_failed", "check-failed")
  }
  if (activeRuns > 0) return release("busy", "busy")
  if (workRemaining() < MIN_DISPATCH_BUDGET_MS) return release("out_of_time", "out-of-time")

  const prepared = await deps.prepareDispatch(slot, dispatchId, workSignal())
  // disabled: 그 사이에 꺼졌다(RPC가 행을 정리했다). lost: 이 slot은 더 이상 이 호출의 것이 아니다.
  if (prepared === "disabled") return { kind: "noop", reason: "disabled" }
  if (prepared === "lost") return { kind: "noop", reason: "lost-claim" }

  // 행은 dispatching이다. prepare가 오래 걸려 시간이 없으면 POST를 시작하지 않는다 — 이때는
  // 보내지 않은 것이 확실하므로 not_sent로 닫는다(닫지 못하면 dispatching으로 남아 이후를 막는다).
  if (workRemaining() < MIN_POST_BUDGET_MS) {
    await deps.finishSlot(slot, dispatchId, { from: "dispatching", status: "not_sent" }, recordSignal())
    return { kind: "noop", reason: "out-of-time" }
  }

  // 이 아래에서 무슨 일이 생기든 다시 보내지 않는다.
  const result = await deps.dispatchWorkflow(workflowInputs(prepared, dispatchId), workSignal())
  const record = (finish: LedgerFinish) => deps.finishSlot(slot, dispatchId, finish, recordSignal())

  if (result.kind === "accepted") {
    if (!(await record({ from: "dispatching", status: "sent", httpStatus: result.httpStatus, runId: result.runId }))) {
      throw new Error("collect dispatch was accepted but its ledger row could not be updated")
    }
    return { kind: "sent", slot, mode: prepared, runId: result.runId }
  }
  if (result.kind === "rejected") {
    if (!(await record({ from: "dispatching", status: "rejected", httpStatus: result.httpStatus }))) {
      throw new Error("collect dispatch was rejected but its ledger row could not be updated")
    }
    return { kind: "rejected", slot, httpStatus: result.httpStatus }
  }
  await record({ from: "dispatching", status: "unknown", httpStatus: result.httpStatus })
  return { kind: "unknown", slot }
}
