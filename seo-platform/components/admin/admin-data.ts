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
  { label: "대시보드", href: "/admin" },
  { label: "장소관리", href: "/admin/places" },
  { label: "동기화", href: "/admin/sync" },
  { label: "검색분석", href: "/admin/sitemap" },
  { label: "설정", href: "/admin/settings" },
] as const satisfies readonly AdminNavItem[]
