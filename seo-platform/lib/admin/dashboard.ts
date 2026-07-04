import type { AdminSummaryCard } from "@/components/admin/admin-data"
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
  const [places, seoPages, sitemap, syncStatus] = await Promise.all([
    loadAdminPlaces(repositories.places),
    loadAdminSeoPages(repositories.seoPages),
    loadAdminSitemap(repositories.sitemap),
    loadAdminSync(repositories.sync),
  ])
  const source = [places.source, seoPages.source, sitemap.source, syncStatus.source].every((value) => value === "supabase") ? "supabase" : "fixture"

  return {
    source,
    cards: [
      { label: "Places", value: String(places.rows.length), detail: "Read-only place rows available to admin", tone: "neutral" },
      { label: "SEO pages", value: String(seoPages.rows.length), detail: "Published public-safe SEO rows", tone: "accent" },
      { label: "Sitemap URLs", value: String(sitemap.entries.length), detail: "Canonical URLs included in sitemap preview", tone: "accent" },
      { label: "Sync status", value: syncStatus.status, detail: syncStatus.message, tone: syncStatus.status === "completed" ? "accent" : "warning" },
      { label: "Sync failures", value: String(syncStatus.errors.length), detail: "Current row-level sync errors listed without payloads", tone: syncStatus.errors.length === 0 ? "neutral" : "warning" },
      { label: "AI status", value: "preview-only", detail: "Generated content remains unpublished until Apply", tone: "warning" },
    ],
  }
}
