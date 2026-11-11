import "server-only"

// 읽기 전용: 대시보드 요약 전용 조회. 행 본문은 받지 않고 count(head)와 최신 실행 1건만 읽는다.
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { AdminDashboardSummaryRepository } from "./dashboard"

export function createSupabaseAdminDashboardSummaryRepository(): AdminDashboardSummaryRepository {
  const client = createSupabaseServiceRoleClient()

  return {
    async countPlaces() {
      const { count, error } = await client.from("places").select("id", { count: "exact", head: true })
      return readCount("places", count, error)
    },
    // 장소관리의 "AI 생성 안됨" 필터와 같은 조건(설명·메타 제목·메타 설명이 모두 비어 있음).
    async countPlacesMissingAiContent() {
      const { count, error } = await client
        .from("places")
        .select("id", { count: "exact", head: true })
        .is("description", null)
        .is("meta_title", null)
        .is("meta_description", null)
      return readCount("places(ai-missing)", count, error)
    },
    async countReadyPlaceSeoPages() {
      const { count, error } = await client.from("seo_pages").select("id", { count: "exact", head: true }).eq("page_type", "place").eq("status", "ready")
      return readCount("seo_pages(ready)", count, error)
    },
    async countPublishedPlaceSeoPages() {
      const { count, error } = await client.from("seo_pages").select("id", { count: "exact", head: true }).eq("page_type", "place").eq("status", "published")
      return readCount("seo_pages(published)", count, error)
    },
    async countSitemapEntries() {
      const { count, error } = await client.from("published_place_pages").select("path", { count: "exact", head: true })
      return readCount("published_place_pages", count, error)
    },
    async latestSyncRun() {
      const { data, error } = await client.from("sync_runs").select("id, status, started_at, finished_at").order("started_at", { ascending: false }).limit(1).maybeSingle()
      if (error !== null) {
        throw new SupabaseAdminDashboardReadError("sync_runs", error.message)
      }
      return data
    },
    async countSyncErrors(syncRunId) {
      const { count, error } = await client.from("sync_errors").select("id", { count: "exact", head: true }).eq("sync_run_id", syncRunId)
      return readCount("sync_errors", count, error)
    },
  }
}

function readCount(target: string, count: number | null, error: { readonly message: string } | null): number {
  if (error !== null) {
    throw new SupabaseAdminDashboardReadError(target, error.message)
  }
  return count ?? 0
}

export class SupabaseAdminDashboardReadError extends Error {
  readonly name = "SupabaseAdminDashboardReadError"

  constructor(
    readonly target: string,
    readonly detail: string,
  ) {
    super(`Failed to read admin dashboard summary (${target}): ${detail}`)
  }
}
