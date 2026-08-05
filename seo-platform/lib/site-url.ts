// 앱(관리자·인증) origin — 비밀번호 재설정 redirect 등 관리자 흐름 전용.
// 공개 SEO 표면은 getPublicSiteUrl을 쓴다. 두 origin을 분리해 두는 이유:
// 공개 도메인이 place.팔도플라워.com으로 이전해도 관리자 접속·Supabase auth 콜백은
// 기존 Vercel origin에 남아야 하기 때문이다 (auth redirect allowlist·운영 admin 안내 문구가 이 origin 기준).
export const PRODUCTION_SITE_URL = "https://flowercrm-seo.vercel.app" as const

// 공개 SEO origin — sitemap·robots·canonical·metadataBase·Open Graph·JSON-LD·공개 링크·게시 후 공개 검증 URL 전용.
// 한글 도메인(place.팔도플라워.com)이 아니라 퓨니코드 단일 표기를 쓴다 — 두 표기가 섞이면 Search Console이 별개 URL로 본다.
export const PUBLIC_SEO_SITE_URL = "https://place.xn--hq1bo4e93ri3lbmc.com" as const

export const LOCAL_SITE_URL = "http://localhost:3000" as const

export type SiteUrlEnvironment = {
  readonly NEXT_PUBLIC_APP_URL?: string
  readonly SEO_PLATFORM_SITE_URL?: string
}

export function getSiteUrl(env?: SiteUrlEnvironment): string {
  const appUrl = env === undefined ? process.env["NEXT_PUBLIC_APP_URL"] : env.NEXT_PUBLIC_APP_URL
  const seoPlatformUrl = env === undefined ? process.env["SEO_PLATFORM_SITE_URL"] : env.SEO_PLATFORM_SITE_URL
  return new URL(appUrl ?? seoPlatformUrl ?? PRODUCTION_SITE_URL).origin
}

export type PublicSiteUrlEnvironment = {
  readonly NEXT_PUBLIC_SITE_URL?: string
  readonly VERCEL_ENV?: string
}

// 공개 SEO origin 해석 규칙:
// 1) NEXT_PUBLIC_SITE_URL이 있으면 그 origin (명시 override — 도메인 교체 리허설·롤백용)
// 2) Vercel 배포(production·preview)는 공개 도메인 고정 — Preview 페이지의 canonical이
//    Production 공개 URL을 가리키는 기존 정책을 유지한다 (Preview 자체 주소를 canonical로 내지 않음)
// 3) 로컬 개발은 localhost — Production 도메인으로 강제하지 않는다
// SEO_PLATFORM_SITE_URL은 의도적으로 읽지 않는다 — 그 변수는 구 도메인이 설정된 채 남아 있어도
// 공개 표면이 구 도메인으로 되돌아가지 않아야 하고, 앞으로는 앱(관리자) origin 용도로만 남는다.
export function getPublicSiteUrl(env?: PublicSiteUrlEnvironment): string {
  const explicit = env === undefined ? process.env["NEXT_PUBLIC_SITE_URL"] : env.NEXT_PUBLIC_SITE_URL
  if (explicit !== undefined && explicit.length > 0) {
    return new URL(explicit).origin
  }
  const vercelEnv = env === undefined ? process.env["VERCEL_ENV"] : env.VERCEL_ENV
  if (vercelEnv === "production" || vercelEnv === "preview") {
    return PUBLIC_SEO_SITE_URL
  }
  return LOCAL_SITE_URL
}
