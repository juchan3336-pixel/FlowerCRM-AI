import { z } from "zod"

export type PasswordResetEnvironment = {
  readonly NEXT_PUBLIC_SUPABASE_URL?: string
  readonly NEXT_PUBLIC_SUPABASE_ANON_KEY?: string
}

export type PasswordResetEmailClient = {
  readonly resetPasswordForEmail: (email: string, options: Readonly<{ redirectTo: string }>) => Promise<Readonly<{ error: { readonly message: string } | null }>>
}

export type PasswordResetInput = {
  readonly formData: FormData
  readonly env: PasswordResetEnvironment
  readonly redirectTo: string
  readonly authClient: PasswordResetEmailClient
}

export type PasswordResetResult =
  | { readonly kind: "configured_missing" }
  | { readonly kind: "invalid_email" }
  | { readonly kind: "sent"; readonly email: string }
  | { readonly kind: "provider_error" }

const emailSchema = z.string().trim().pipe(z.email())

export async function requestPasswordReset(input: PasswordResetInput): Promise<PasswordResetResult> {
  if (!hasPasswordResetEnvironment(input.env)) {
    return { kind: "configured_missing" }
  }

  const parsedEmail = emailSchema.safeParse(input.formData.get("email"))
  if (!parsedEmail.success) {
    return { kind: "invalid_email" }
  }

  const { error } = await input.authClient.resetPasswordForEmail(parsedEmail.data, { redirectTo: input.redirectTo })
  if (error !== null) {
    return { kind: "provider_error" }
  }

  return { kind: "sent", email: parsedEmail.data }
}

export function hasPasswordResetEnvironment(env: PasswordResetEnvironment): boolean {
  return env.NEXT_PUBLIC_SUPABASE_URL !== undefined && env.NEXT_PUBLIC_SUPABASE_ANON_KEY !== undefined
}

export function buildPasswordResetRedirectTo(siteUrl: string): string {
  return `${new URL("/auth/callback", siteUrl).toString()}?next=/reset-password`
}
