import { z } from "zod"

import { isAllowedAdminAccess, type AdminAuthUser } from "@/lib/auth/admin-middleware"

export type LoginAuthEnvironment = {
  readonly NEXT_PUBLIC_SUPABASE_URL?: string
  readonly NEXT_PUBLIC_SUPABASE_ANON_KEY?: string
  readonly ADMIN_EMAIL_ALLOWLIST?: string
}

export type MagicLinkAuthClient = {
  readonly signInWithOtp: (input: Readonly<{ email: string; options: Readonly<{ emailRedirectTo: string }> }>) => Promise<Readonly<{ error: { readonly message: string } | null }>>
}

export type PasswordLoginAuthClient = {
  readonly signInWithPassword: (input: Readonly<{ email: string; password: string }>) => Promise<Readonly<{ data: Readonly<{ session: Readonly<{ access_token: string; refresh_token: string }> | null }>; error: { readonly message: string } | null }>>
  readonly getSession: () => Promise<Readonly<{ data: Readonly<{ session: Readonly<{ access_token: string; refresh_token: string }> | null }>; error: { readonly message: string } | null }>>
  readonly getUser: () => Promise<Readonly<{ data: Readonly<{ user: AdminAuthUser | null }>; error: { readonly message: string } | null }>>
  readonly setSession: (session: Readonly<{ access_token: string; refresh_token: string }>) => Promise<Readonly<{ error: { readonly message: string } | null }>>
  readonly signOut: () => Promise<Readonly<{ error: { readonly message: string } | null }>>
}

export type MagicLinkInput = {
  readonly formData: FormData
  readonly origin: string
  readonly nextPath: string | null
  readonly env: LoginAuthEnvironment
  readonly authClient: MagicLinkAuthClient
}

export type PasswordLoginInput = {
  readonly formData: FormData
  readonly nextPath: string | null
  readonly env: LoginAuthEnvironment
  readonly authClient: PasswordLoginAuthClient
}

export type MagicLinkResult =
  | { readonly kind: "configured_missing" }
  | { readonly kind: "invalid_email" }
  | { readonly kind: "unauthorized_email" }
  | { readonly kind: "sent"; readonly email: string; readonly nextPath: string }
  | { readonly kind: "provider_error"; readonly message: string }

export type PasswordLoginResult =
  | { readonly kind: "configured_missing" }
  | { readonly kind: "invalid_email" }
  | { readonly kind: "invalid_password" }
  | { readonly kind: "unauthorized_email" }
  | { readonly kind: "signed_in"; readonly email: string; readonly nextPath: "/admin/dashboard"; readonly remember: boolean }
  // 자격증명 오류(사용자 실수)와 서버·설정 오류(provider_error)를 구분해 사용자 문구를 다르게 안내한다.
  | { readonly kind: "invalid_credentials" }
  | { readonly kind: "provider_error" }

const emailSchema = z.string().trim().pipe(z.email())
const passwordSchema = z.string().min(1)
const PASSWORD_LOGIN_SUCCESS_PATH = "/admin/dashboard" as const
export const ADMIN_REMEMBER_COOKIE_NAME = "seo-admin-remember" as const

export function shouldUseSecureCookies(origin: string | null): boolean {
  if (origin === null) {
    return process.env.NODE_ENV === "production"
  }

  return origin.startsWith("https://")
}

export async function requestMagicLink(input: MagicLinkInput): Promise<MagicLinkResult> {
  if (!hasLoginAuthEnvironment(input.env)) {
    return { kind: "configured_missing" }
  }

  const parsedEmail = emailSchema.safeParse(input.formData.get("email"))
  if (!parsedEmail.success) {
    return { kind: "invalid_email" }
  }

  if (!isAllowedLoginEmail(parsedEmail.data, input.env.ADMIN_EMAIL_ALLOWLIST)) {
    return { kind: "unauthorized_email" }
  }

  const nextPath = normalizeNextPath(input.nextPath)
  const emailRedirectTo = buildAuthCallbackUrl(input.origin, nextPath)
  const { error } = await input.authClient.signInWithOtp({ email: parsedEmail.data, options: { emailRedirectTo } })

  if (error !== null) {
    return { kind: "provider_error", message: error.message }
  }

  return { kind: "sent", email: parsedEmail.data, nextPath }
}

export async function requestPasswordLogin(input: PasswordLoginInput): Promise<PasswordLoginResult> {
  if (!hasLoginAuthEnvironment(input.env)) {
    return { kind: "configured_missing" }
  }

  const parsedEmail = emailSchema.safeParse(input.formData.get("email"))
  if (!parsedEmail.success) {
    return { kind: "invalid_email" }
  }

  const parsedPassword = passwordSchema.safeParse(input.formData.get("password"))
  if (!parsedPassword.success) {
    return { kind: "invalid_password" }
  }

  logPasswordAuthStage("Password OK", { email: parsedEmail.data })

  const signInResult = await input.authClient.signInWithPassword({ email: parsedEmail.data, password: parsedPassword.data })
  if (signInResult.error !== null) {
    logPasswordAuthStage("Session FAIL", { email: parsedEmail.data, message: signInResult.error.message })
    return { kind: isCredentialAuthErrorMessage(signInResult.error.message) ? "invalid_credentials" : "provider_error" }
  }

  logPasswordAuthStage("Session OK", { email: parsedEmail.data })

  const sessionResult = await input.authClient.getSession()
  if (sessionResult.error !== null) {
    logPasswordAuthStage("Session FAIL", { email: parsedEmail.data, message: sessionResult.error.message })
    return { kind: "provider_error" }
  }

  if (sessionResult.data.session !== null) {
    const setSessionResult = await input.authClient.setSession(sessionResult.data.session)
    if (setSessionResult.error !== null) {
      logPasswordAuthStage("Session FAIL", { email: parsedEmail.data, message: setSessionResult.error.message })
      return { kind: "provider_error" }
    }
  }

  const userResult = await input.authClient.getUser()
  if (userResult.error !== null || userResult.data.user === null) {
    logPasswordAuthStage("User FAIL", { email: parsedEmail.data, message: userResult.error?.message ?? null })
    await input.authClient.signOut()
    return { kind: "provider_error" }
  }

  logPasswordAuthStage("User OK", describeAdminUser(userResult.data.user))

  if (!isAllowedAdminAccess(userResult.data.user, input.env.ADMIN_EMAIL_ALLOWLIST)) {
    logPasswordAuthStage("Allowlist FAIL", describeAdminUser(userResult.data.user))
    await input.authClient.signOut()
    logPasswordAuthStage("Unauthorized", describeAdminUser(userResult.data.user))
    return { kind: "unauthorized_email" }
  }

  logPasswordAuthStage("Allowlist OK", describeAdminUser(userResult.data.user))

  return { kind: "signed_in", email: parsedEmail.data, nextPath: PASSWORD_LOGIN_SUCCESS_PATH, remember: input.formData.get("remember") === "on" }
}

export function hasLoginAuthEnvironment(env: LoginAuthEnvironment): boolean {
  return env.NEXT_PUBLIC_SUPABASE_URL !== undefined && env.NEXT_PUBLIC_SUPABASE_ANON_KEY !== undefined
}

export function normalizeNextPath(value: string | null): string {
  if (value !== "/admin" && !value?.startsWith("/admin/")) {
    return "/admin"
  }

  return value
}

export function buildAuthCallbackUrl(origin: string, nextPath: string): string {
  const callbackUrl = new URL("/auth/callback", origin)
  callbackUrl.searchParams.set("next", normalizeNextPath(nextPath))
  return callbackUrl.toString()
}

// Supabase 자격증명 실패 응답을 서버 오류와 구분한다 (메시지 원문은 사용자에게 노출하지 않는다).
export function isCredentialAuthErrorMessage(message: string): boolean {
  return /invalid login credentials|invalid credentials|invalid_grant|email not confirmed/i.test(message)
}

function isAllowedLoginEmail(email: string, allowlist: string | undefined): boolean {
  if (allowlist === undefined) {
    return false
  }

  const normalizedEmail = email.trim().toLowerCase()
  return allowlist
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .some((value) => value.length > 0 && value === normalizedEmail)
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

function logPasswordAuthStage(stage: string, details: Readonly<Record<string, unknown>>): void {
  console.info(`[admin-auth][password] ${stage}`, details)
}
