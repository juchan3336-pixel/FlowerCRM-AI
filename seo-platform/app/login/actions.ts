"use server"

import { createServerClient } from "@supabase/ssr"
import { cookies, headers } from "next/headers"
import { redirect } from "next/navigation"

import { requestMagicLink, type MagicLinkAuthClient } from "@/lib/auth/login"
import type { Database } from "@/types/database"

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

  const supabase = createServerClient<Database>(supabaseUrl, anonKey, {
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
