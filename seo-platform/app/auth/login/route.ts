import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

import { ADMIN_REMEMBER_COOKIE_NAME, requestPasswordLogin, shouldUseSecureCookies, type PasswordLoginAuthClient } from "@/lib/auth/login"
import { normalizeSupabaseProjectUrl } from "@/lib/supabase-url"
import type { Database } from "@/types/database"

const REMEMBER_ME_MAX_AGE_SECONDS = 60 * 60 * 24 * 400

export async function POST(request: NextRequest): Promise<NextResponse> {
  const formData = await request.formData()
  const nextPath = formData.get("next")
  const remember = formData.get("remember") === "on"
  const response = new NextResponse(null, {
    status: 303,
    headers: { Location: "/login" },
  })
  const result = await requestPasswordLogin({
    formData,
    nextPath: typeof nextPath === "string" ? nextPath : null,
    env: getLoginAuthEnvironment(),
    authClient: createPasswordLoginAuthClient(request, response, remember),
  })

  // NextResponse.redirect는 절대 URL만 허용한다 — 상대 경로를 넘기면 throw되어 HTTP 500이 된다.
  const redirectToLogin = (query: string): NextResponse => NextResponse.redirect(new URL(`/login${query}`, request.nextUrl.origin), 303)

  if (result.kind === "configured_missing") {
    return redirectToLogin("?setup=missing")
  }
  if (result.kind === "invalid_email") {
    return redirectToLogin("?error=invalid-email")
  }
  if (result.kind === "invalid_password") {
    return redirectToLogin("?error=invalid-password")
  }
  if (result.kind === "unauthorized_email") {
    return redirectToLogin("?error=unauthorized")
  }
  if (result.kind === "invalid_credentials") {
    return redirectToLogin("?error=invalid-credentials")
  }
  if (result.kind === "provider_error") {
    return redirectToLogin("?error=server-error")
  }

  response.cookies.set(ADMIN_REMEMBER_COOKIE_NAME, result.remember ? "1" : "0", {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: shouldUseSecureCookies(request.nextUrl.origin),
    ...(result.remember ? { maxAge: REMEMBER_ME_MAX_AGE_SECONDS } : {}),
  })

  response.headers.set("Location", result.nextPath)
  return response
}

function getLoginAuthEnvironment() {
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"]
  const anonKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
  const adminEmailAllowlist = process.env["ADMIN_EMAIL_ALLOWLIST"]

  if (supabaseUrl === undefined || anonKey === undefined) {
    return {}
  }

  return {
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
    ...(adminEmailAllowlist === undefined ? {} : { ADMIN_EMAIL_ALLOWLIST: adminEmailAllowlist }),
  }
}

function createPasswordLoginAuthClient(request: NextRequest, response: NextResponse, remember: boolean): PasswordLoginAuthClient {
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"]
  const anonKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"]

  if (supabaseUrl === undefined || anonKey === undefined) {
    return {
      signInWithPassword: () => Promise.resolve({ data: { session: null }, error: { message: "Supabase auth environment is not configured" } }),
      getSession: () => Promise.resolve({ data: { session: null }, error: { message: "Supabase auth environment is not configured" } }),
      setSession: () => Promise.resolve({ error: { message: "Supabase auth environment is not configured" } }),
      getUser: () => Promise.resolve({ data: { user: null }, error: { message: "Supabase auth environment is not configured" } }),
      signOut: () => Promise.resolve({ error: null }),
    }
  }

  const supabase = createServerClient<Database>(normalizeSupabaseProjectUrl(supabaseUrl), anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, remember ? options : withoutCookiePersistence(options))
        }
        for (const [key, value] of Object.entries(headers)) {
          response.headers.set(key, value)
        }
      },
    },
  })

  return {
    signInWithPassword(input) {
      return supabase.auth.signInWithPassword(input)
    },
    getSession() {
      return supabase.auth.getSession().then((result) => ({
        data: {
          session:
            result.data.session === null
              ? null
              : {
                  access_token: result.data.session.access_token,
                  refresh_token: result.data.session.refresh_token,
                },
        },
        error: result.error === null ? null : { message: result.error.message },
      }))
    },
    setSession(session) {
      return supabase.auth.setSession(session)
    },
    getUser() {
      return supabase.auth.getUser().then((result) => ({
        data: {
          user:
            result.data.user === null
              ? null
              : {
                  id: result.data.user.id,
                  email: result.data.user.email ?? null,
                  role: result.data.user.role ?? null,
                  appMetadataRole: readMetadataRole(result.data.user.app_metadata),
                  userMetadataRole: readMetadataRole(result.data.user.user_metadata),
                },
        },
        error: result.error === null ? null : { message: result.error.message },
      }))
    },
    signOut() {
      return supabase.auth.signOut().then((result) => ({ error: result.error === null ? null : { message: result.error.message } }))
    },
  }
}

function withoutCookiePersistence<TCookieOptions extends { maxAge?: unknown; expires?: unknown }>(options: TCookieOptions): Omit<TCookieOptions, "maxAge" | "expires"> {
  const sessionOptions = { ...options }
  delete sessionOptions.maxAge
  delete sessionOptions.expires
  return sessionOptions
}

function readMetadataRole(value: unknown): string | null {
  if (value === null || typeof value !== "object") {
    return null
  }

  const role = (value as Record<string, unknown>)["role"]
  return typeof role === "string" ? role : null
}
