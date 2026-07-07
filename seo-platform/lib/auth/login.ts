import { z } from "zod"

export type LoginAuthEnvironment = {
  readonly NEXT_PUBLIC_SUPABASE_URL?: string
  readonly NEXT_PUBLIC_SUPABASE_ANON_KEY?: string
  readonly ADMIN_EMAIL_ALLOWLIST?: string
}

export type MagicLinkAuthClient = {
  readonly signInWithOtp: (input: Readonly<{ email: string; options: Readonly<{ emailRedirectTo: string }> }>) => Promise<Readonly<{ error: { readonly message: string } | null }>>
}

export type PasswordLoginAuthClient = {
  readonly signInWithPassword: (input: Readonly<{ email: string; password: string }>) => Promise<Readonly<{ error: { readonly message: string } | null }>>
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
  | { readonly kind: "provider_error" }

const emailSchema = z.string().trim().pipe(z.email())
const passwordSchema = z.string().min(1)
const PASSWORD_LOGIN_SUCCESS_PATH = "/admin/dashboard" as const
export const ADMIN_REMEMBER_COOKIE_NAME = "seo-admin-remember" as const

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

  if (!isAllowedLoginEmail(parsedEmail.data, input.env.ADMIN_EMAIL_ALLOWLIST)) {
    return { kind: "unauthorized_email" }
  }

  const { error } = await input.authClient.signInWithPassword({ email: parsedEmail.data, password: parsedPassword.data })
  if (error !== null) {
    return { kind: "provider_error" }
  }

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
