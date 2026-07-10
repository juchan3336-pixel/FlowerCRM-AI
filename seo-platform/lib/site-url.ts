export const PRODUCTION_SITE_URL = "https://flowercrm-seo.vercel.app" as const

export type SiteUrlEnvironment = {
  readonly NEXT_PUBLIC_APP_URL?: string
  readonly SEO_PLATFORM_SITE_URL?: string
}

export function getSiteUrl(env?: SiteUrlEnvironment): string {
  const appUrl = env === undefined ? process.env["NEXT_PUBLIC_APP_URL"] : env.NEXT_PUBLIC_APP_URL
  const seoPlatformUrl = env === undefined ? process.env["SEO_PLATFORM_SITE_URL"] : env.SEO_PLATFORM_SITE_URL
  return new URL(appUrl ?? seoPlatformUrl ?? PRODUCTION_SITE_URL).origin
}
