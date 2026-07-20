"use server"

import { createServerClient } from "@supabase/ssr"
import { cookies, headers } from "next/headers"
import { redirect } from "next/navigation"

import { ADMIN_REMEMBER_COOKIE_NAME, requestMagicLink, requestPasswordLogin, shouldUseSecureCookies, type MagicLinkAuthClient, type PasswordLoginAuthClient } from "@/lib/auth/login"
import { normalizeSupabaseProjectUrl } from "@/lib/supabase-url"
import type { Database } from "@/types/database"

const REMEMBER_ME_MAX_AGE_SECONDS = 60 * 60 * 24 * 400

export async function requestPasswordLoginAction(formData: FormData): Promise<never> {
  const requestHeaders = await headers()
  const requestOrigin = requestHeaders.get("origin")
  const nextPath = formData.get("next")
  const remember = formData.get("remember") === "on"
  const result = await requestPasswordLogin({
    formData,
    nextPath: typeof nextPath === "string" ? nextPath : null,
    env: getLoginAuthEnvironment(),
    authClient: await createPasswordLoginAuthClient(remember),
  })

  if (result.kind === "configured_missing") {
    console.info("[admin-auth][password] Redirect setup missing", { nextPath: typeof nextPath === "string" ? nextPath : null })
    redirect("/login?setup=missing")
  }
  if (result.kind === "invalid_email") {
    console.info("[admin-auth][password] Redirect invalid email")
    redirect("/login?error=invalid-email")
  }
  if (result.kind === "invalid_password") {
    console.info("[admin-auth][password] Redirect invalid password")
    redirect("/login?error=invalid-password")
  }
  if (result.kind === "unauthorized_email") {
    console.info("[admin-auth][password] Redirect unauthorized")
    redirect("/login?error=unauthorized")
  }
  if (result.kind === "invalid_credentials") {
    console.info("[admin-auth][password] Redirect invalid credentials")
    redirect("/login?error=invalid-credentials")
  }
  if (result.kind === "provider_error") {
    console.info("[admin-auth][password] Redirect provider error")
    redirect("/login?error=server-error")
  }

  const cookieStore = await cookies()
  cookieStore.set(ADMIN_REMEMBER_COOKIE_NAME, result.remember ? "1" : "0", {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: shouldUseSecureCookies(requestOrigin),
    ...(result.remember ? { maxAge: REMEMBER_ME_MAX_AGE_SECONDS } : {}),
  })
  redirect(result.nextPath)
}

// useActionState용 폼 상태 — 인증 실패를 500 없이 폼 내부 오류로 되돌린다. auth 원문 메시지는 절대 담지 않는다.
export type PasswordLoginFormState =
  | { readonly status: "idle" }
  | { readonly status: "error"; readonly code: "invalid-credentials" | "unauthorized" | "server-error" | "setup-missing"; readonly email: string }

export async function passwordLoginFormAction(_previous: PasswordLoginFormState, formData: FormData): Promise<PasswordLoginFormState> {
  const requestHeaders = await headers()
  const requestOrigin = requestHeaders.get("origin")
  const nextPath = formData.get("next")
  const remember = formData.get("remember") === "on"
  const emailValue = formData.get("email")
  const email = typeof emailValue === "string" ? emailValue : ""

  let result: Awaited<ReturnType<typeof requestPasswordLogin>>
  try {
    result = await requestPasswordLogin({
      formData,
      nextPath: typeof nextPath === "string" ? nextPath : null,
      env: getLoginAuthEnvironment(),
      authClient: await createPasswordLoginAuthClient(remember),
    })
  } catch (error) {
    // 네트워크·예외는 사용자에게 일반 오류로만 안내하고 서버 로그에 기록한다.
    console.error("[admin-auth][password] Unexpected failure", { message: error instanceof Error ? error.message : String(error) })
    return { status: "error", code: "server-error", email }
  }

  if (result.kind === "configured_missing") {
    return { status: "error", code: "setup-missing", email }
  }
  if (result.kind === "invalid_email" || result.kind === "invalid_password" || result.kind === "invalid_credentials") {
    console.info("[admin-auth][password] Form error invalid credentials")
    return { status: "error", code: "invalid-credentials", email }
  }
  if (result.kind === "unauthorized_email") {
    console.info("[admin-auth][password] Form error unauthorized")
    return { status: "error", code: "unauthorized", email }
  }
  if (result.kind === "provider_error") {
    console.info("[admin-auth][password] Form error provider")
    return { status: "error", code: "server-error", email }
  }

  const cookieStore = await cookies()
  cookieStore.set(ADMIN_REMEMBER_COOKIE_NAME, result.remember ? "1" : "0", {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: shouldUseSecureCookies(requestOrigin),
    ...(result.remember ? { maxAge: REMEMBER_ME_MAX_AGE_SECONDS } : {}),
  })
  redirect(result.nextPath)
}

export async function requestMagicLinkAction(formData: FormData): Promise<never> {
  const headerStore = await headers()
  const origin = headerStore.get("origin") ?? "http://localhost:3000"
  const nextPath = formData.get("next")
  const result = await requestMagicLink({
    formData,
    origin,
    nextPath: typeof nextPath === "string" ? nextPath : null,
    env: getLoginAuthEnvironment(),
    authClient: await createMagicLinkAuthClient(),
  })

  if (result.kind === "configured_missing") {
    redirect("/login?setup=missing")
  }
  if (result.kind === "invalid_email") {
    redirect("/login?error=invalid-email")
  }
  if (result.kind === "unauthorized_email") {
    redirect("/login?error=unauthorized")
  }
  if (result.kind === "provider_error") {
    redirect("/login?error=provider")
  }
  redirect(`/login?sent=1&next=${encodeURIComponent(result.nextPath)}`)
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

async function createMagicLinkAuthClient(): Promise<MagicLinkAuthClient> {
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"]
  const anonKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
  const cookieStore = await cookies()

  if (supabaseUrl === undefined || anonKey === undefined) {
    return { signInWithOtp: () => Promise.resolve({ error: { message: "Supabase auth environment is not configured" } }) }
  }

  const supabase = createServerClient<Database>(normalizeSupabaseProjectUrl(supabaseUrl), anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          cookieStore.set(name, value, options)
        }
      },
    },
  })

  return {
    signInWithOtp(input) {
      return supabase.auth.signInWithOtp(input)
    },
  }
}

async function createPasswordLoginAuthClient(remember: boolean): Promise<PasswordLoginAuthClient> {
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"]
  const anonKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
  const cookieStore = await cookies()

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
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          cookieStore.set(name, value, remember ? options : withoutCookiePersistence(options))
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
