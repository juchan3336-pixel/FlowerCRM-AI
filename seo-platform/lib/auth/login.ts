import { z } from "zod"

export type LoginAuthEnvironment = {
  readonly NEXT_PUBLIC_SUPABASE_URL?: string
  readonly NEXT_PUBLIC_SUPABASE_ANON_KEY?: string
  readonly ADMIN_EMAIL_ALLOWLIST?: string
}

export type MagicLinkAuthClient = {
  readonly signInWithOtp: (input: Readonly<{ email: string; options: Readonly<{ emailRedirectTo: string }> }>) => Promise<Readonly<{ error: { readonly message: string } | null }>>
}

export type MagicLinkInput = {
  readonly formData: FormData
  readonly origin: string
  readonly nextPath: string | null
  readonly env: LoginAuthEnvironment
  readonly authClient: MagicLinkAuthClient
}

export type MagicLinkResult =
  | { readonly kind: "configured_missing" }
  | { readonly kind: "invalid_email" }
  | { readonly kind: "unauthorized_email" }
  | { readonly kind: "sent"; readonly email: string; readonly nextPath: string }
  | { readonly kind: "provider_error"; readonly message: string }

const emailSchema = z.string().trim().pipe(z.email())

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
