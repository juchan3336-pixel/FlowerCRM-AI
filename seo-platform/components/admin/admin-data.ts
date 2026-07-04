export type AdminNavItem = {
  readonly label: string
  readonly href: string
}

export type AdminSummaryCard = {
  readonly label: string
  readonly value: string
  readonly detail: string
  readonly tone: "accent" | "neutral" | "warning"
}

export const ADMIN_NAV_ITEMS = [
  { label: "Dashboard", href: "/admin" },
  { label: "Places", href: "/admin/places" },
  { label: "SEO Pages", href: "/admin/seo-pages" },
  { label: "Generate AI", href: "/admin/generate-ai" },
  { label: "Sync", href: "/admin/sync" },
  { label: "Sitemap", href: "/admin/sitemap" },
  { label: "Settings", href: "/admin/settings" },
] as const satisfies readonly AdminNavItem[]

export const ADMIN_DASHBOARD_SUMMARY = [
  { label: "Total pages", value: "128", detail: "Public route records in fixture scope", tone: "neutral" },
  { label: "Published pages", value: "84", detail: "Eligible for canonical sitemap output", tone: "accent" },
  { label: "Funeral", value: "37", detail: "Funeral hall SEO pages", tone: "neutral" },
  { label: "Hospital", value: "19", detail: "Hospital-related SEO pages", tone: "neutral" },
  { label: "Area", value: "22", detail: "Regional landing pages", tone: "neutral" },
  { label: "Product", value: "50", detail: "Order CTA product pages", tone: "neutral" },
  { label: "Sync status", value: "healthy", detail: "Last fixture import completed without live credentials", tone: "accent" },
  { label: "AI status", value: "preview-only", detail: "Generated content remains unpublished until Apply", tone: "warning" },
] as const satisfies readonly AdminSummaryCard[]
