export type AdminNavItem = {
  readonly label: string
  readonly href: string
  // 같은 prefix를 공유하는 형제 메뉴(예: /admin/batch 와 /admin/batch/approve)가 동시에 활성화되지
  // 않도록, 이 메뉴가 양보해야 하는 하위 경로를 명시한다.
  readonly excludePrefixes?: readonly string[]
}

export type AdminSummaryCard = {
  readonly label: string
  readonly value: string
  readonly detail: string
  readonly tone: "accent" | "neutral" | "warning"
}

// 작업 순서가 메뉴에서 바로 읽히도록 단계 번호를 붙인다 (2026-08-06 명칭 혼동 피드백).
export const ADMIN_NAV_ITEMS = [
  { label: "대시보드", href: "/admin" },
  { label: "장소관리", href: "/admin/places" },
  { label: "1단계 · 업체 확인", href: "/admin/verify" },
  { label: "2단계 · AI 생성", href: "/admin/batch/approve" },
  { label: "3단계 · 게시", href: "/admin/batch/publish/new" },
  // Batch 이력은 /admin/batch 하위 전체를 담당하되, 단계 메뉴가 가진 경로는 양보한다.
  { label: "진행 이력", href: "/admin/batch", excludePrefixes: ["/admin/batch/approve", "/admin/batch/publish/new"] },
  { label: "동기화", href: "/admin/sync" },
  { label: "검색분석", href: "/admin/sitemap" },
  { label: "설정", href: "/admin/settings" },
] as const satisfies readonly AdminNavItem[]

// 메뉴 활성 판정 — prefix만 보면 형제 메뉴가 함께 켜지므로 제외 경로를 먼저 확인한다.
export function isAdminNavItemActive(item: AdminNavItem, pathname: string | null | undefined): boolean {
  const currentPath = pathname ?? ""
  if (currentPath.length === 0) return false
  for (const excluded of item.excludePrefixes ?? []) {
    if (currentPath === excluded || currentPath.startsWith(`${excluded}/`)) return false
  }
  if (currentPath === item.href) return true
  if (item.href === "/admin") return currentPath === "/admin/dashboard"
  return currentPath.startsWith(`${item.href}/`)
}
