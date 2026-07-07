export type AuthCallbackEnvironment = {
  readonly NEXT_PUBLIC_SUPABASE_URL?: string
  readonly NEXT_PUBLIC_SUPABASE_ANON_KEY?: string
}

export type AuthCodeExchangeClient = {
  readonly exchangeCodeForSession: (code: string) => Promise<Readonly<{ error: { readonly message: string } | null }>>
  readonly verifyOtp?: (params: Readonly<{ token_hash: string; type: "recovery" }>) => Promise<Readonly<{ error: { readonly message: string } | null }>>
}

export type AuthCallbackInput = {
  readonly requestUrl: URL
  readonly env: AuthCallbackEnvironment
  readonly authClient: AuthCodeExchangeClient
}

export type AuthCallbackResult =
  | { readonly kind: "configured_missing"; readonly redirectPath: "/login?setup=missing" }
  | { readonly kind: "missing_code"; readonly redirectPath: "/login?error=missing-code" }
  | { readonly kind: "exchange_failed"; readonly redirectPath: "/login?error=callback"; readonly message: string }
  | { readonly kind: "recovered"; readonly redirectPath: "/reset-password" }
  | { readonly kind: "exchanged"; readonly redirectPath: string }

export async function handleAuthCallback(input: AuthCallbackInput): Promise<AuthCallbackResult> {
  if (!hasAuthCallbackEnvironment(input.env)) {
    return { kind: "configured_missing", redirectPath: "/login?setup=missing" }
  }

  const code = input.requestUrl.searchParams.get("code")
  const type = input.requestUrl.searchParams.get("type")
  const tokenHash = input.requestUrl.searchParams.get("token_hash")

  if (type === "recovery" && tokenHash !== null && tokenHash.length > 0 && input.authClient.verifyOtp !== undefined) {
    const { error } = await input.authClient.verifyOtp({ token_hash: tokenHash, type: "recovery" })
    if (error !== null) {
      return { kind: "exchange_failed", redirectPath: "/login?error=callback", message: error.message }
    }

    return { kind: "recovered", redirectPath: "/reset-password" }
  }

  if (code === null || code.length === 0) {
    return { kind: "missing_code", redirectPath: "/login?error=missing-code" }
  }

  const { error } = await input.authClient.exchangeCodeForSession(code)
  if (error !== null) {
    return { kind: "exchange_failed", redirectPath: "/login?error=callback", message: error.message }
  }

  if (type === "recovery") {
    return { kind: "recovered", redirectPath: "/reset-password" }
  }

  return { kind: "exchanged", redirectPath: normalizeAuthCallbackNextPath(input.requestUrl.searchParams.get("next")) }
}

export function hasAuthCallbackEnvironment(env: AuthCallbackEnvironment): boolean {
  return env.NEXT_PUBLIC_SUPABASE_URL !== undefined && env.NEXT_PUBLIC_SUPABASE_ANON_KEY !== undefined
}

export function normalizeAuthCallbackNextPath(value: string | null): string {
  if (value !== "/admin" && !value?.startsWith("/admin/")) {
    return "/admin"
  }

  return value
}
