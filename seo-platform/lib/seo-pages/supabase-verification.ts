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
    },
  }
}

export class SupabaseVerificationError extends Error {
  readonly name = "SupabaseVerificationError"

  constructor(step: string, readonly detail: string) {
    super(`Failed to ${step}: ${detail}`)
  }
}
