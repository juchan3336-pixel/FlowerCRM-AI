import type { AdminSummaryCard } from "@/components/admin/admin-data"
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

export type AdminDashboardSummary = {
  readonly source: "fixture" | "supabase"
  readonly cards: readonly AdminSummaryCard[]
}

export async function loadAdminDashboard(repositories: AdminDashboardRepositories = {}): Promise<AdminDashboardSummary> {
  const placesRepositories: AdminPlacesRepositories | undefined =
    repositories.places === undefined ? undefined : { places: repositories.places }

  const [places, seoPages, sitemap, syncStatus] = await Promise.all([
    loadAdminPlaces(placesRepositories),
    loadAdminSeoPages(repositories.seoPages),
    loadAdminSitemap(repositories.sitemap),
    loadAdminSync(repositories.sync),
  ])
  const source = [places.source, seoPages.source, sitemap.source, syncStatus.source].every((value) => value === "supabase") ? "supabase" : "fixture"

  return {
    source,
    cards: [
      { label: "장소", value: String(places.rows.length), detail: "관리자에서 볼 수 있는 읽기 전용 장소 행", tone: "neutral" },
      { label: "SEO 페이지", value: String(seoPages.rows.length), detail: "게시된 공개 안전 SEO 행", tone: "accent" },
      { label: "사이트맵 URL", value: String(sitemap.entries.length), detail: "사이트맵 미리보기에 포함된 canonical URL", tone: "accent" },
      { label: "동기화 상태", value: syncStatus.status, detail: syncStatus.message, tone: syncStatus.status === "completed" ? "accent" : "warning" },
      { label: "동기화 실패", value: String(syncStatus.errors.length), detail: "현재 행 수준 동기화 오류를 payload 없이 표시", tone: syncStatus.errors.length === 0 ? "neutral" : "warning" },
      { label: "AI 상태", value: "미리보기만", detail: "생성된 콘텐츠는 적용 전까지 게시되지 않음", tone: "warning" },
    ],
  }
}
