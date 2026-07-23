import "server-only"

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { VerificationRecord, VerificationRepository } from "./publish-verification"

// seo_pages.verification_* 컬럼 갱신 — migration 202607220001 적용 전에는 호출부가 오류를 로그로만 처리한다.
export function createSupabaseVerificationRepository(): VerificationRepository {
  const client = createSupabaseServiceRoleClient()

  return {
    async markPending(path: string): Promise<void> {
      const { error } = await client
        .from("seo_pages")
        .update({ verification_status: "pending", verification_checked_at: new Date().toISOString(), verification_attempts: 0, last_http_status: null })
        .eq("path", path)
      if (error !== null) {
        throw new SupabaseVerificationError("mark pending", error.message)
      }
      await recordVerificationEventSafely(path, "pending", null)
    },
    async recordResult(path: string, record: VerificationRecord): Promise<void> {
      const { error } = await client
        .from("seo_pages")
        .update({
          verification_status: record.status,
          verification_checked_at: new Date().toISOString(),
          verification_attempts: record.attempts,
          last_http_status: record.lastHttpStatus,
        })
        .eq("path", path)
      if (error !== null) {
        throw new SupabaseVerificationError("record result", error.message)
      }
      await recordVerificationEventSafely(path, record.status, record.lastHttpStatus)
    },
  }
}

// 실제 검증 상태 변경 지점에서만 batch 이벤트를 남긴다 (PR-S4) — 게시 액션의 예상 상태 선기록 금지.
// path→place→최근 publish batch item을 역추적하고, 배치 게시가 아닌 단건 게시면 기록하지 않는다.
// fire-and-forget: 어떤 실패도 검증 결과 저장에 영향을 주지 않는다.
async function recordVerificationEventSafely(path: string, status: "pending" | "verified" | "delayed" | "failed", httpStatus: number | null): Promise<void> {
  try {
    const client = createSupabaseServiceRoleClient()
    const { data: page } = await client.from("seo_pages").select("place_id").eq("path", path).maybeSingle()
    if (page?.place_id == null) {
      return
    }
    const { data: items } = await client
      .from("batch_run_items")
      .select("id, batch_id")
      .eq("place_id", page.place_id)
      .not("verification_status", "is", null)
      .order("updated_at", { ascending: false })
      .limit(1)
    const item = items?.[0]
    if (item === undefined) {
      return
    }
    const { createSupabaseBatchRepository } = await import("@/lib/batch/supabase-batch-repository")
    await createSupabaseBatchRepository().recordEvent({
      batchId: item.batch_id,
      itemId: item.id,
      eventType: "verification_updated",
      toStatus: status,
      detail: { verification_status: status, http_status: httpStatus },
    })
  } catch (error) {
    console.error("[batch-events] verification event failed", { path, error: error instanceof Error ? error.message : String(error) })
  }
}

export class SupabaseVerificationError extends Error {
  readonly name = "SupabaseVerificationError"

  constructor(step: string, readonly detail: string) {
    super(`Failed to ${step}: ${detail}`)
  }
}
