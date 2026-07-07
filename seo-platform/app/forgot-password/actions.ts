"use server"

import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { requestPasswordReset, type PasswordResetEmailClient } from "@/lib/auth/password-reset"
import type { Database } from "@/types/database"

export async function requestPasswordResetAction(formData: FormData): Promise<never> {
  const result = await requestPasswordReset({
    formData,
    env: getPasswordResetEnvironment(),
    authClient: await createPasswordResetEmailClient(),
  })

  if (result.kind === "configured_missing") {
    redirect("/forgot-password?setup=missing")
  }
  if (result.kind === "invalid_email") {
    redirect("/forgot-password?error=invalid-email")
  }
  if (result.kind === "provider_error") {
    redirect("/forgot-password?error=provider")
  }

  redirect("/forgot-password?sent=1")
}

function getPasswordResetEnvironment() {
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"]
  const anonKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"]

  if (supabaseUrl === undefined || anonKey === undefined) {
    return {}
  }

  return { NEXT_PUBLIC_SUPABASE_URL: supabaseUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey }
}

async function createPasswordResetEmailClient(): Promise<PasswordResetEmailClient> {
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"]
  const anonKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
  const cookieStore = await cookies()

  if (supabaseUrl === undefined || anonKey === undefined) {
    return { resetPasswordForEmail: () => Promise.resolve({ error: { message: "Supabase auth environment is not configured" } }) }
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
    resetPasswordForEmail(email, options) {
      return supabase.auth.resetPasswordForEmail(email, options)
    },
  }
}
