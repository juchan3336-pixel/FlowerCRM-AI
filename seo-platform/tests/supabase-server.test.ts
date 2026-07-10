import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { createSupabaseServiceRoleClient, MissingServerSupabaseEnvError } from "@/lib/supabase/server"
import { normalizeSupabaseProjectUrl } from "@/lib/supabase-url"

describe("Supabase server env", () => {
  it("reports exact missing env keys when the service-role client cannot be created", () => {
    // Given: only the public URL and anon key are present.
    const previousEnv = captureSupabaseEnv()
    process.env["NEXT_PUBLIC_SUPABASE_URL"] = "https://example.supabase.co"
    process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] = "anon-key"
    delete process.env["SUPABASE_SERVICE_ROLE_KEY"]

    try {
      // When: the service-role client is created without a service role key.
      createSupabaseServiceRoleClient()
      throw new Error("Expected createSupabaseServiceRoleClient() to throw")
    } catch (error) {
      // Then: the error reports every env name with its OK/MISSING status.
      expect(error).toBeInstanceOf(MissingServerSupabaseEnvError)
      if (!(error instanceof MissingServerSupabaseEnvError)) {
        throw error
      }

      expect(error.message).toContain("NEXT_PUBLIC_SUPABASE_URL = OK")
      expect(error.message).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY = OK")
      expect(error.message).toContain("SUPABASE_SERVICE_ROLE_KEY = MISSING")
      expect(error.missingKeys).toEqual(["SUPABASE_SERVICE_ROLE_KEY"])
    } finally {
      restoreSupabaseEnv(previousEnv)
    }
  })

  it("normalizes Supabase project URLs that include a REST path suffix", () => {
    expect(normalizeSupabaseProjectUrl("https://project.supabase.co/rest/v1/")).toBe("https://project.supabase.co")
  })
})

type SupabaseEnvSnapshot = Readonly<{
  NEXT_PUBLIC_SUPABASE_URL: string | undefined
  NEXT_PUBLIC_SUPABASE_ANON_KEY: string | undefined
  SUPABASE_SERVICE_ROLE_KEY: string | undefined
}>

function captureSupabaseEnv(): SupabaseEnvSnapshot {
  return {
    NEXT_PUBLIC_SUPABASE_URL: process.env["NEXT_PUBLIC_SUPABASE_URL"],
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"],
    SUPABASE_SERVICE_ROLE_KEY: process.env["SUPABASE_SERVICE_ROLE_KEY"],
  }
}

function restoreSupabaseEnv(snapshot: SupabaseEnvSnapshot): void {
  restoreEnvKey("NEXT_PUBLIC_SUPABASE_URL", snapshot.NEXT_PUBLIC_SUPABASE_URL)
  restoreEnvKey("NEXT_PUBLIC_SUPABASE_ANON_KEY", snapshot.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  restoreEnvKey("SUPABASE_SERVICE_ROLE_KEY", snapshot.SUPABASE_SERVICE_ROLE_KEY)
}

function restoreEnvKey(key: keyof SupabaseEnvSnapshot, value: string | undefined): void {
  switch (key) {
    case "NEXT_PUBLIC_SUPABASE_URL":
      if (value === undefined) {
        delete process.env["NEXT_PUBLIC_SUPABASE_URL"]
        return
      }
      process.env["NEXT_PUBLIC_SUPABASE_URL"] = value
      return
    case "NEXT_PUBLIC_SUPABASE_ANON_KEY":
      if (value === undefined) {
        delete process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
        return
      }
      process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] = value
      return
    case "SUPABASE_SERVICE_ROLE_KEY":
      if (value === undefined) {
        delete process.env["SUPABASE_SERVICE_ROLE_KEY"]
        return
      }
      process.env["SUPABASE_SERVICE_ROLE_KEY"] = value
  }
}
