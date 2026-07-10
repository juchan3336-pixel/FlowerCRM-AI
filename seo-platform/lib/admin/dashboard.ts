import type { AdminSummaryCard } from "@/components/admin/admin-data"
import type { SyncRunStatus } from "@/lib/domain/constants"
import type { AdminPlacesRepositories } from "./places"
import { loadAdminPlaces, type AdminPlacesRepository } from "./places"
import { loadAdminSeoPages, type AdminSeoPagesRepository } from "./seo-pages"
import { loadAdminSitemap, type AdminSitemapRepository } from "./sitemap"
import { loadAdminSync, type AdminSyncRepository } from "./sync"

export type AdminDashboardRepositories = {
  readonly places?: AdminPlacesRepository
  readonly seoPages?: AdminSeoPagesRepository
  readonly sitemap?: AdminSitemapRepository
  readonly sync?: AdminSyncRepository
}

export type AdminDashboardTaskKey = "ai-missing" | "publish-pending" | "published" | "google-index" | "sync-errors"

export type AdminDashboardTaskCard = {
  readonly key: AdminDashboardTaskKey
  readonly label: string
  readonly value: string
  readonly detail: string
  readonly tone: AdminSummaryCard["tone"]
  readonly href?: string
}

export type AdminDashboardSummary = {
  readonly source: "fixture" | "supabase"
  readonly totalPlaces: number
  readonly tasks: readonly AdminDashboardTaskCard[]
  readonly cards: readonly AdminSummaryCard[]
}

const SYNC_STATUS_LABELS: Record<SyncRunStatus, string> = {
  running: "진행 중",
  completed: "정상",
  failed: "오류",
  cancelled: "중단",
}

export async function loadAdminDashboard(repositories: AdminDashboardRepositories = {}): Promise<AdminDashboardSummary> {
  const placesRepository = repositories.places
  const placesRepositories: AdminPlacesRepositories | undefined =
    placesRepository === undefined ? undefined : { places: placesRepository }

  const [places, seoPages, sitemap, syncStatus, aiMissingCount, readySeoCount, publishedSeoCount] = await Promise.all([
    loadAdminPlaces(placesRepositories),
    loadAdminSeoPages(repositories.seoPages),
    loadAdminSitemap(repositories.sitemap),
    loadAdminSync(repositories.sync),
    tryCount(() => placesRepository?.countPlacesMissingAiContent?.()),
    tryCount(() => placesRepository?.countReadyPlaceSeoPages?.()),
    tryCount(() => placesRepository?.countPublishedPlaceSeoPages?.()),
  ])
  const source =
    places.source === "live" && [seoPages.source, sitemap.source, syncStatus.source].every((value) => value === "supabase")
      ? "supabase"
      : "fixture"

  const totalPlaces = places.diagnostics.placesQueryCount ?? places.rows.length
  const aiMissing = aiMissingCount ?? places.rows.filter((row) => row.aiState === "미리보기 대기").length
  const readySeo = readySeoCount ?? places.rows.filter((row) => row.seoState === "ready").length
  const publishedSeo = publishedSeoCount ?? places.rows.filter((row) => row.seoState === "published").length
  const syncErrorCount = syncStatus.errors.length

  return {
    source,
    totalPlaces,
    tasks: [
      {
        key: "ai-missing",
        label: "AI 생성 안됨",
        value: formatCount(aiMissing),
        detail: "AI/SEO 콘텐츠가 아직 만들어지지 않은 장소",
        tone: aiMissing === 0 ? "accent" : "warning",
        href: "/admin/places?task=ai-missing",
      },
      {
        key: "publish-pending",
        label: "게시 대기",
        value: formatCount(readySeo),
        detail: "검수를 마치고 게시를 기다리는 SEO 페이지",
        tone: readySeo === 0 ? "neutral" : "warning",
        href: "/admin/places?task=publish-pending",
      },
      {
        key: "published",
        label: "게시 완료",
        value: formatCount(publishedSeo),
        detail: "공개 사이트에 게시된 SEO 페이지",
        tone: publishedSeo === 0 ? "neutral" : "accent",
        href: "/admin/places?task=published",
      },
      {
        key: "google-index",
        label: "Google 색인",
        value: "Search Console 연동 전",
        detail: "연동 후 게시된 페이지 기준으로 색인 상태를 계산합니다",
        tone: "neutral",
      },
      {
        key: "sync-errors",
        label: "동기화 오류",
        value: formatCount(syncErrorCount),
        detail: "최근 동기화에서 처리하지 못한 데이터 행",
        tone: syncErrorCount === 0 ? "accent" : "warning",
        href: "/admin/sync",
      },
    ],
    cards: [
      { label: "전체 장소", value: formatCount(totalPlaces), detail: "현재 관리 중인 전체 장소", tone: "neutral" },
      { label: "게시된 SEO 페이지", value: formatCount(publishedSeo), detail: "공개 사이트에 게시된 SEO 페이지", tone: "accent" },
      { label: "사이트맵 URL", value: formatCount(sitemap.entries.length), detail: "사이트맵에 포함된 공개 URL", tone: "accent" },
      {
        label: "동기화 상태",
        value: SYNC_STATUS_LABELS[syncStatus.status],
        detail: `최근 실행 ${syncStatus.finishedAt}`,
        tone: syncStatus.status === "completed" ? "accent" : "warning",
      },
    ],
  }
}

async function tryCount(count: () => Promise<number> | undefined): Promise<number | null> {
  try {
    return (await count()) ?? null
  } catch {
    return null
  }
}

function formatCount(value: number): string {
  return value.toLocaleString("ko-KR")
}
