import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { NextResponse, type NextRequest } from "next/server"

import { handleAuthCallback, type AuthCodeExchangeClient } from "@/lib/auth/callback"
import type { Database } from "@/types/database"

export async function GET(request: NextRequest): Promise<NextResponse> {
  const result = await handleAuthCallback({
    requestUrl: request.nextUrl,
    env: getAuthCallbackEnvironment(),
    authClient: await createAuthCodeExchangeClient(),
  })

  return NextResponse.redirect(new URL(result.redirectPath, request.nextUrl.origin))
}

function getAuthCallbackEnvironment() {
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"]
  const anonKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"]

  if (supabaseUrl === undefined || anonKey === undefined) {
    return {}
  }

  return { NEXT_PUBLIC_SUPABASE_URL: supabaseUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey }
}

async function createAuthCodeExchangeClient(): Promise<AuthCodeExchangeClient> {
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"]
  const anonKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
  const cookieStore = await cookies()

  if (supabaseUrl === undefined || anonKey === undefined) {
    return { exchangeCodeForSession: () => Promise.resolve({ error: { message: "Supabase auth environment is not configured" } }) }
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
    exchangeCodeForSession(code) {
      return supabase.auth.exchangeCodeForSession(code)
    },
    verifyOtp(params) {
      return supabase.auth.verifyOtp(params)
    },
  }
}
