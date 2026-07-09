import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

import { ADMIN_REMEMBER_COOKIE_NAME } from "@/lib/auth/login"
import { normalizeSupabaseProjectUrl } from "@/lib/supabase-url"
import type { Database } from "@/types/database"

export async function GET(request: NextRequest): Promise<NextResponse> {
  const response = new NextResponse(null, { status: 204 })
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"]
  const anonKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"]

  response.cookies.delete(ADMIN_REMEMBER_COOKIE_NAME)

  if (supabaseUrl === undefined || anonKey === undefined) {
    return response
  }

  const supabase = createServerClient<Database>(normalizeSupabaseProjectUrl(supabaseUrl), anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options)
        }
      },
    },
  })

  const { error } = await supabase.auth.signOut()
  if (error !== null) {
    console.info("[admin-auth][logout] signOut failed", { message: error.message })
  }

  return response
}
