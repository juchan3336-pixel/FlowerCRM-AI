// Enrich 외부 예약 dispatch — 실제 의존성(Supabase service role + GitHub).
import "server-only"

import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"

import { countActiveEnrichRuns, dispatchEnrichWorkflow } from "@/lib/enrich-dispatch/github-client"
import type { EnrichDispatchMode } from "@/lib/enrich-dispatch/policy"
import type { DispatchControl, EnrichDispatchDependencies, LedgerUpdate, SlotClaim } from "@/lib/enrich-dispatch/service"
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"

const CLAIMS: readonly SlotClaim[] = ["claimed", "duplicate", "blocked_unknown"]

export function createLiveEnrichDispatchDependencies(githubToken: string): EnrichDispatchDependencies {
  // 이 두 테이블은 생성된 Database 타입에 아직 없다. 타입 없는 클라이언트로 좁혀 쓰고,
  // 읽은 값은 아래에서 직접 검증한다.
  const supabase = createSupabaseServiceRoleClient() as unknown as SupabaseClient

  return {
    async readControl(): Promise<DispatchControl> {
      const result = await supabase.from("enrich_dispatch_control").select("enabled, mode").eq("id", 1).maybeSingle()
      if (result.error !== null) throw new Error("enrich dispatch control read failed")
      const row = result.data as { enabled?: unknown; mode?: unknown } | null
      // 행이 없거나 값이 이상하면 꺼진 것으로 닫는다. mode는 live가 정확히 적혀 있을 때만 live다.
      const mode: EnrichDispatchMode = row?.mode === "live" ? "live" : "dry_run"
      return { enabled: row?.enabled === true, mode }
    },

    async claimSlot(slot: string, dispatchId: string): Promise<SlotClaim> {
      const result = await supabase.rpc("claim_enrich_dispatch_slot", { p_slot: slot, p_dispatch_id: dispatchId })
      if (result.error !== null) throw new Error("enrich dispatch slot claim failed")
      const returned: unknown = result.data
      const claim = CLAIMS.find((value) => value === returned)
      if (claim === undefined) throw new Error("enrich dispatch slot claim returned an unknown value")
      return claim
    },

    async recordSlot(slot: string, update: LedgerUpdate): Promise<void> {
      const patch: Record<string, string | number | null> = { status: update.status, updated_at: new Date().toISOString() }
      if ("httpStatus" in update) patch["http_status"] = update.httpStatus
      if ("runId" in update) patch["run_id"] = update.runId
      const { error } = await supabase.from("enrich_dispatch_ledger").update(patch).eq("slot", slot)
      if (error !== null) throw new Error("enrich dispatch ledger update failed")
    },

    countActiveRuns: () => countActiveEnrichRuns(githubToken),
    dispatchWorkflow: (inputs) => dispatchEnrichWorkflow(githubToken, inputs),
    newDispatchId: () => randomUUID(),
  }
}
