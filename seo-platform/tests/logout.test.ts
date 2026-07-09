import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { signOut } = vi.hoisted(() => ({
  signOut: vi.fn(() => Promise.resolve({ error: null })),
}))

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      signOut,
    },
  }),
}))

import { GET } from "@/app/logout/route"

describe("admin logout", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it("signs out and redirects back to the login screen", async () => {
    // Given: a logout request on the admin surface.
    const request = new NextRequest("https://seo.example.test/logout")

    // When: the route handles the request.
    const response = await GET(request)

    // Then: Supabase sign-out runs and the browser is redirected to the signed-out login screen.
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(response.headers.get("location")).toBe("https://seo.example.test/login?logged-out=1")
  })
})
