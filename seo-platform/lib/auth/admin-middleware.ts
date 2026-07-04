import { NextResponse, type NextRequest } from "next/server"

export type AdminAuthUser = {
  readonly id: string
  readonly email: string | null
}

export type AdminAuthEnvironment = {
  readonly NEXT_PUBLIC_SUPABASE_URL?: string
  readonly NEXT_PUBLIC_SUPABASE_ANON_KEY?: string
  readonly SUPABASE_SERVICE_ROLE_KEY?: string
  readonly ADMIN_EMAIL_ALLOWLIST?: string
}

export type AdminAuthDependencies = {
  readonly env: AdminAuthEnvironment
  readonly getUser: (request: NextRequest, response: NextResponse) => Promise<AdminAuthUser | null>
}

export function hasAdminAuthEnvironment(env: AdminAuthEnvironment): boolean {
  return env.NEXT_PUBLIC_SUPABASE_URL !== undefined && env.NEXT_PUBLIC_SUPABASE_ANON_KEY !== undefined
}

export function hasAnyAdminSupabaseEnvironment(env: AdminAuthEnvironment): boolean {
  return (
    env.NEXT_PUBLIC_SUPABASE_URL !== undefined ||
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY !== undefined ||
    env.SUPABASE_SERVICE_ROLE_KEY !== undefined ||
    env.ADMIN_EMAIL_ALLOWLIST !== undefined
  )
}

export async function protectAdminRequest(request: NextRequest, dependencies: AdminAuthDependencies): Promise<NextResponse> {
  const response = NextResponse.next({ request: { headers: request.headers } })
  const pathname = request.nextUrl.pathname

  if (!pathname.startsWith("/admin")) {
    return response
  }

  if (!hasAnyAdminSupabaseEnvironment(dependencies.env)) {
    return response
  }

  if (!hasAdminAuthEnvironment(dependencies.env)) {
    const setupUrl = request.nextUrl.clone()
    setupUrl.pathname = "/login"
    setupUrl.search = "?setup=missing"
    return NextResponse.redirect(setupUrl)
  }

  const user = await dependencies.getUser(request, response)
  if (user !== null && isAllowedAdminEmail(user.email, dependencies.env.ADMIN_EMAIL_ALLOWLIST)) {
    return response
  }

  const loginUrl = request.nextUrl.clone()
  loginUrl.pathname = "/login"
  loginUrl.searchParams.set("next", pathname)
  return NextResponse.redirect(loginUrl)
}

export function isAllowedAdminEmail(email: string | null, allowlist: string | undefined): boolean {
  if (email === null || allowlist === undefined) {
    return false
  }

  const normalizedEmail = email.trim().toLowerCase()
  return allowlist
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .some((value) => value.length > 0 && value === normalizedEmail)
}
