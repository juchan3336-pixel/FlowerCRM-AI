import type { AdminSummaryCard } from "@/components/admin/admin-data"
import type { SyncRunStatus } from "@/lib/domain/constants"
import type { SyncRunTableRow } from "@/types/database"
import type { AdminPlacesRepositories } from "./places"
import { loadAdminPlaces, type AdminPlacesRepository } from "./places"
import { loadAdminSeoPages, type AdminSeoPagesRepository } from "./seo-pages"
import { loadAdminSitemap, type AdminSitemapRepository } from "./sitemap"
import { loadAdminSync, type AdminSyncRepository } from "./sync"
import { formatKstDateTime } from "./time"

// 대시보드 전용 요약 조회 — 화면에 쓰는 숫자만 count로 읽는다.
// 장소·SEO·사이트맵·동기화 화면의 전체 로더(목록 전량, 누락 행 순회)를 대시보드가 대신 돌리지 않게 한다.
export interface AdminDashboardSummaryRepository {
  countPlaces(): Promise<number>
  countPlacesMissingAiContent(): Promise<number>
  countReadyPlaceSeoPages(): Promise<number>
  countPublishedPlaceSeoPages(): Promise<number>
  // 사이트맵 화면과 같은 공개 뷰(published_place_pages) 기준.
  countSitemapEntries(): Promise<number>
  latestSyncRun(): Promise<Pick<SyncRunTableRow, "id" | "status" | "started_at" | "finished_at"> | null>
  countSyncErrors(syncRunId: string): Promise<number>
}

export type AdminDashboardRepositories = {
  readonly places?: AdminPlacesRepository
  readonly seoPages?: AdminSeoPagesRepository
  readonly sitemap?: AdminSitemapRepository
  readonly sync?: AdminSyncRepository
  // 지정하면 위 네 저장소 대신 이 요약 조회만 사용한다.
  readonly summary?: AdminDashboardSummaryRepository
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
  if (repositories.summary !== undefined) {
    return loadAdminDashboardFromSummary(repositories.summary)
  }

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

  return buildAdminDashboardSummary({
    source,
    totalPlaces,
    aiMissing,
    readySeo,
    publishedSeo,
    sitemapEntryCount: sitemap.entries.length,
    syncErrorCount,
    syncCard: {
      label: "동기화 상태",
      value: SYNC_STATUS_LABELS[syncStatus.status],
      detail: `최근 실행 ${syncStatus.finishedAt}`,
      tone: syncStatus.status === "completed" ? "accent" : "warning",
    },
  })
}

async function loadAdminDashboardFromSummary(repository: AdminDashboardSummaryRepository): Promise<AdminDashboardSummary> {
  const [totalPlaces, aiMissing, readySeo, publishedSeo, sitemapEntryCount, sync] = await Promise.all([
    repository.countPlaces(),
    repository.countPlacesMissingAiContent(),
    repository.countReadyPlaceSeoPages(),
    repository.countPublishedPlaceSeoPages(),
    repository.countSitemapEntries(),
    repository.latestSyncRun().then(async (run) => ({ run, errorCount: run === null ? 0 : await repository.countSyncErrors(run.id) })),
  ])

  return buildAdminDashboardSummary({
    source: "supabase",
    totalPlaces,
    aiMissing,
    readySeo,
    publishedSeo,
    sitemapEntryCount,
    syncErrorCount: sync.errorCount,
    syncCard:
      sync.run === null
        ? { label: "동기화 상태", value: "실행 없음", detail: "아직 기록된 동기화 실행이 없습니다", tone: "neutral" }
        : {
            label: "동기화 상태",
            value: SYNC_STATUS_LABELS[sync.run.status],
            detail: `최근 실행 ${formatKstDateTime(sync.run.finished_at ?? sync.run.started_at)}`,
            tone: sync.run.status === "completed" ? "accent" : "warning",
          },
  })
}

type AdminDashboardSummaryInput = {
  readonly source: AdminDashboardSummary["source"]
  readonly totalPlaces: number
  readonly aiMissing: number
  readonly readySeo: number
  readonly publishedSeo: number
  readonly sitemapEntryCount: number
  readonly syncErrorCount: number
  readonly syncCard: AdminSummaryCard
}

function buildAdminDashboardSummary(input: AdminDashboardSummaryInput): AdminDashboardSummary {
  const { source, totalPlaces, aiMissing, readySeo, publishedSeo, syncErrorCount } = input

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
      { label: "사이트맵 URL", value: formatCount(input.sitemapEntryCount), detail: "사이트맵에 포함된 공개 URL", tone: "accent" },
      input.syncCard,
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
