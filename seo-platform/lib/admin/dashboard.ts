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
  // null = 건수 조회 실패 (요약 조회 경로에서만 발생).
  readonly totalPlaces: number | null
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
  // 조회 하나가 실패해도 나머지 카드는 그대로 보여준다 — 실패한 카드만 "조회 실패"로 표시한다.
  const [totalPlaces, aiMissing, readySeo, publishedSeo, sitemapEntryCount, sync] = await Promise.all([
    settle("places", () => repository.countPlaces()),
    settle("ai-missing", () => repository.countPlacesMissingAiContent()),
    settle("seo-ready", () => repository.countReadyPlaceSeoPages()),
    settle("seo-published", () => repository.countPublishedPlaceSeoPages()),
    settle("sitemap", () => repository.countSitemapEntries()),
    settle("sync-run", async () => {
      const run = await repository.latestSyncRun()
      return { run, errorCount: run === null ? 0 : await settle("sync-errors", () => repository.countSyncErrors(run.id)) }
    }),
  ])

  return buildAdminDashboardSummary({
    source: "supabase",
    totalPlaces,
    aiMissing,
    readySeo,
    publishedSeo,
    sitemapEntryCount,
    syncErrorCount: sync === null ? null : sync.errorCount,
    syncCard:
      sync === null
        ? { label: "동기화 상태", value: COUNT_FAILED_LABEL, detail: "동기화 상태를 불러오지 못했습니다", tone: "warning" }
        : sync.run === null
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
  readonly totalPlaces: number | null
  readonly aiMissing: number | null
  readonly readySeo: number | null
  readonly publishedSeo: number | null
  readonly sitemapEntryCount: number | null
  readonly syncErrorCount: number | null
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
        tone: countTone(aiMissing, "accent", "warning"),
        href: "/admin/places?task=ai-missing",
      },
      {
        key: "publish-pending",
        label: "게시 대기",
        value: formatCount(readySeo),
        detail: "검수를 마치고 게시를 기다리는 SEO 페이지",
        tone: countTone(readySeo, "neutral", "warning"),
        href: "/admin/places?task=publish-pending",
      },
      {
        key: "published",
        label: "게시 완료",
        value: formatCount(publishedSeo),
        detail: "공개 사이트에 게시된 SEO 페이지",
        tone: countTone(publishedSeo, "neutral", "accent"),
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
        tone: countTone(syncErrorCount, "accent", "warning"),
        href: "/admin/sync",
      },
    ],
    cards: [
      { label: "전체 장소", value: formatCount(totalPlaces), detail: "현재 관리 중인 전체 장소", tone: countTone(totalPlaces, "neutral", "neutral") },
      { label: "게시된 SEO 페이지", value: formatCount(publishedSeo), detail: "공개 사이트에 게시된 SEO 페이지", tone: countTone(publishedSeo, "accent", "accent") },
      { label: "사이트맵 URL", value: formatCount(input.sitemapEntryCount), detail: "사이트맵에 포함된 공개 URL", tone: countTone(input.sitemapEntryCount, "accent", "accent") },
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

const COUNT_FAILED_LABEL = "조회 실패"

async function settle<T>(target: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch (error) {
    console.error("[admin-dashboard] summary read failed", { target, message: error instanceof Error ? error.message : String(error) })
    return null
  }
}

type CardTone = AdminSummaryCard["tone"]

// 조회에 실패한 카드는 0건처럼 보이지 않게 항상 주의 색으로 표시한다.
function countTone(value: number | null, whenZero: CardTone, whenPositive: CardTone): CardTone {
  if (value === null) return "warning"
  return value === 0 ? whenZero : whenPositive
}

function formatCount(value: number | null): string {
  return value === null ? COUNT_FAILED_LABEL : value.toLocaleString("ko-KR")
}
