import { createServerClient } from "@supabase/ssr"
import type { NextRequest, NextResponse } from "next/server"

import { protectAdminRequest, type AdminAuthEnvironment, type AdminAuthUser } from "@/lib/auth/admin-middleware"
import type { Database } from "@/types/database"

export async function proxy(request: NextRequest): Promise<NextResponse> {
  return protectAdminRequest(request, {
    env: getAdminAuthEnvironment(),
    getUser: getSupabaseUser,
  })
}

function getAdminAuthEnvironment(): AdminAuthEnvironment {
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"]
  const anonKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
  const serviceRoleKey = process.env["SUPABASE_SERVICE_ROLE_KEY"]
  const adminEmailAllowlist = process.env["ADMIN_EMAIL_ALLOWLIST"]

  return {
    ...(supabaseUrl === undefined ? {} : { NEXT_PUBLIC_SUPABASE_URL: supabaseUrl }),
    ...(anonKey === undefined ? {} : { NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey }),
    ...(serviceRoleKey === undefined ? {} : { SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey }),
    ...(adminEmailAllowlist === undefined ? {} : { ADMIN_EMAIL_ALLOWLIST: adminEmailAllowlist }),
  }
}

async function getSupabaseUser(request: NextRequest, response: NextResponse): Promise<AdminAuthUser | null> {
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"]
  const anonKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"]

  if (supabaseUrl === undefined || anonKey === undefined) {
    return null
  }

  const supabase = createServerClient<Database>(supabaseUrl, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options)
        }
        for (const [key, value] of Object.entries(headers)) {
          response.headers.set(key, value)
        }
      },
    },
  })

  const { data, error } = await supabase.auth.getUser()
  if (error !== null) {
    return null
  }

  return { id: data.user.id, email: data.user.email ?? null }
}

export const config = {
  matcher: ["/admin/:path*"],
}
