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
  { label: "수집", href: "/admin" },
  { label: "보강", href: "/admin/seo-pages" },
  { label: "동기화", href: "/admin/sync" },
  { label: "장소", href: "/admin/places" },
  { label: "SEO", href: "/admin/sitemap" },
  { label: "AI", href: "/admin/generate-ai" },
  { label: "설정", href: "/admin/settings" },
] as const satisfies readonly AdminNavItem[]

export const ADMIN_DASHBOARD_SUMMARY = [
  { label: "전체 페이지", value: "128", detail: "피처 범위의 공개 라우트 기록", tone: "neutral" },
  { label: "게시 완료", value: "84", detail: "정식 사이트맵에 포함 가능한 상태", tone: "accent" },
  { label: "장례", value: "37", detail: "장례식장 SEO 페이지", tone: "neutral" },
  { label: "병원", value: "19", detail: "병원 관련 SEO 페이지", tone: "neutral" },
  { label: "지역", value: "22", detail: "지역 랜딩 페이지", tone: "neutral" },
  { label: "상품", value: "50", detail: "주문 CTA용 상품 페이지", tone: "neutral" },
  { label: "동기화 상태", value: "정상", detail: "최근 fixture 가져오기가 완료됨", tone: "accent" },
  { label: "AI 상태", value: "미리보기만", detail: "생성 결과는 Apply 전까지 비공개", tone: "warning" },
] as const satisfies readonly AdminSummaryCard[]
