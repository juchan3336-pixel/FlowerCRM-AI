// 루트(/) 표면 판정 — 같은 앱이 두 도메인을 서빙하므로 host로 화면을 가른다.
// - 운영 관리자용 origin(flowercrm-seo.vercel.app)의 루트는 기존 관리자 진입 화면을 보존한다
//   (Supabase 비밀번호 복구 링크가 이 origin 루트로 도착하는 기존 흐름 유지).
// - 그 외(공개 도메인 place.팔도플라워.com·로컬 개발 등)는 고객용 첫 화면.
// 도메인 전체 리다이렉트는 추가하지 않는다 — 화면만 다르고 /admin·/login·/api 계약은 무변경.
import { PRODUCTION_SITE_URL } from "@/lib/site-url"

export type RootSurface = "admin" | "public"

const ADMIN_ROOT_HOST = new URL(PRODUCTION_SITE_URL).host

export function resolveRootSurface(host: string | null | undefined): RootSurface {
  if (host === null || host === undefined) {
    return "public"
  }
  // Host 헤더는 포트가 붙을 수 있다 (예: localhost:3000) — 호스트명만 비교한다.
  const hostname = host.trim().toLowerCase().replace(/:\d+$/, "")
  return hostname === ADMIN_ROOT_HOST ? "admin" : "public"
}
