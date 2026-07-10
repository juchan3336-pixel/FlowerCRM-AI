import { NextResponse, type NextRequest } from "next/server"

export type AdminAuthUser = {
  readonly id: string
  readonly email: string | null
  readonly role?: string | null
  readonly appMetadataRole?: string | null
  readonly userMetadataRole?: string | null
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
  if (user !== null) {
    logAdminAuthStage("User OK", describeAdminUser(user))
  } else {
    logAdminAuthStage("User FAIL", { pathname })
  }

  if (user !== null && isAllowedAdminAccess(user, dependencies.env.ADMIN_EMAIL_ALLOWLIST)) {
    logAdminAuthStage("Allowlist OK", describeAdminUser(user))
    return response
  }

  logAdminAuthStage("Allowlist FAIL", { pathname, user: user === null ? null : describeAdminUser(user) })
  logAdminAuthStage("Unauthorized", { pathname })

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

export function isAllowedAdminAccess(user: Readonly<Pick<AdminAuthUser, "email" | "role" | "appMetadataRole" | "userMetadataRole">>, allowlist: string | undefined): boolean {
  return isAllowedAdminEmail(user.email, allowlist) || isAdminRole(user)
}

export function isAdminRole(user: Readonly<Pick<AdminAuthUser, "role" | "appMetadataRole" | "userMetadataRole">>): boolean {
  return user.role === "admin" || user.appMetadataRole === "admin" || user.userMetadataRole === "admin"
}

function describeAdminUser(user: Readonly<Pick<AdminAuthUser, "id" | "email" | "role" | "appMetadataRole" | "userMetadataRole">>): Readonly<Record<string, string | null>> {
  return {
    id: user.id,
    email: user.email,
    role: user.role ?? null,
    appMetadataRole: user.appMetadataRole ?? null,
    userMetadataRole: user.userMetadataRole ?? null,
  }
}

function logAdminAuthStage(stage: string, details: Readonly<Record<string, unknown>>): void {
  console.info(`[admin-auth][proxy] ${stage}`, details)
}
