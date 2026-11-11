// Collect 외부 예약 dispatch — 실제 의존성(Supabase service role + GitHub).
import "server-only"

import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"

import { countActiveCollectRuns, dispatchCollectWorkflow } from "@/lib/collect-dispatch/github-client"
import type { DispatchPreparation, CollectDispatchDependencies, LedgerFinish, SlotClaim } from "@/lib/collect-dispatch/service"
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"

const CLAIMS: readonly SlotClaim[] = ["claimed", "duplicate", "blocked", "disabled"]
const PREPARATIONS: readonly DispatchPreparation[] = ["dry_run", "live", "disabled", "lost"]

export function createLiveCollectDispatchDependencies(githubToken: string): CollectDispatchDependencies {
  // 이 RPC들은 생성된 Database 타입에 아직 없다. 타입 없는 클라이언트로 좁혀 쓰고,
  // 돌려받은 값은 아래에서 직접 검증한다 — 모르는 값은 실패로 처리한다.
  const supabase = createSupabaseServiceRoleClient() as unknown as SupabaseClient

  return {
    async claimSlot(slot, dispatchId, signal): Promise<SlotClaim> {
      const result = await supabase.rpc("claim_collect_dispatch_slot", { p_slot: slot, p_dispatch_id: dispatchId }).abortSignal(signal)
      if (result.error !== null) throw new Error("collect dispatch slot claim failed")
      const returned: unknown = result.data
      const claim = CLAIMS.find((value) => value === returned)
      if (claim === undefined) throw new Error("collect dispatch slot claim returned an unknown value")
      return claim
    },

    async prepareDispatch(slot, dispatchId, signal): Promise<DispatchPreparation> {
      const result = await supabase.rpc("prepare_collect_dispatch", { p_slot: slot, p_dispatch_id: dispatchId }).abortSignal(signal)
      // 준비가 됐는지 알 수 없으면 보내지 않는다(행이 dispatching으로 넘어갔다면 결과 불명으로 남는다).
      if (result.error !== null) throw new Error("collect dispatch preparation failed")
      const returned: unknown = result.data
      const preparation = PREPARATIONS.find((value) => value === returned)
      if (preparation === undefined) throw new Error("collect dispatch preparation returned an unknown value")
      return preparation
    },

    async finishSlot(slot, dispatchId, finish: LedgerFinish, signal): Promise<boolean> {
      const result = await supabase
        .rpc("finish_collect_dispatch", {
          p_slot: slot,
          p_dispatch_id: dispatchId,
          p_from_status: finish.from,
          p_status: finish.status,
          p_http_status: "httpStatus" in finish ? finish.httpStatus : null,
          p_run_id: "runId" in finish ? finish.runId : null,
        })
        .abortSignal(signal)
      if (result.error !== null) throw new Error("collect dispatch ledger update failed")
      return result.data === true
    },

    countActiveRuns: (signal) => countActiveCollectRuns(githubToken, signal),
    dispatchWorkflow: (inputs, signal) => dispatchCollectWorkflow(githubToken, inputs, signal),
    newDispatchId: () => randomUUID(),
  }
}
