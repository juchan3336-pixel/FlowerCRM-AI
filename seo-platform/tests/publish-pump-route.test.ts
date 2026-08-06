// 자동 게시 pump endpoint 계약 — 인증·환경 가드·outcome 매핑.
// 실제 게시 코어(runAutoPublishTick)는 mock — 여기서는 endpoint 껍데기의 계약만 고정한다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("next/server", () => ({ after: (cb: () => unknown) => cb }))

const runAutoPublishTick = vi.fn<() => Promise<unknown>>()
vi.mock("@/lib/seo-pages/auto-publish", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/seo-pages/auto-publish")>()
  return { ...actual, runAutoPublishTick: () => runAutoPublishTick() }
})

const SECRET = "publish-pump-secret-value"
const ENV_KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "PUBLISH_PUMP_SECRET", "VERCEL_ENV"]
const saved = new Map<string, string | undefined>()

function makeRequest(secret: string | null): Request {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (secret !== null) headers["x-publish-pump-secret"] = secret
  return new Request("https://flowercrm-seo.vercel.app/api/publish/pump", { method: "POST", headers })
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key])
  process.env["NEXT_PUBLIC_SUPABASE_URL"] = "https://project.supabase.co"
  process.env["SUPABASE_SERVICE_ROLE_KEY"] = "service-role"
  process.env["PUBLISH_PUMP_SECRET"] = SECRET
  process.env["VERCEL_ENV"] = "production"
  runAutoPublishTick.mockReset()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("publish pump endpoint", () => {
  it("rejects a wrong or missing secret with 401 and never runs the tick", async () => {
    const { POST } = await import("@/app/api/publish/pump/route")
    expect((await POST(makeRequest("wrong"))).status).toBe(401)
    expect((await POST(makeRequest(null))).status).toBe(401)
    expect(runAutoPublishTick).not.toHaveBeenCalled()
  })

  it("returns 409 when the secret env is missing or the deployment is not production", async () => {
    const { POST } = await import("@/app/api/publish/pump/route")
    delete process.env["PUBLISH_PUMP_SECRET"]
    expect((await POST(makeRequest(SECRET))).status).toBe(409)
    process.env["PUBLISH_PUMP_SECRET"] = SECRET
    process.env["VERCEL_ENV"] = "preview"
    expect((await POST(makeRequest(SECRET))).status).toBe(409)
    expect(runAutoPublishTick).not.toHaveBeenCalled()
  })

  it("maps tick outcomes to responses (published 200, disabled 200, failed 500)", async () => {
    const { POST } = await import("@/app/api/publish/pump/route")
    runAutoPublishTick.mockResolvedValueOnce({ kind: "published", placeId: "p1", name: "곽병원 장례식장", path: "/places/x" })
    const ok = await POST(makeRequest(SECRET))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ kind: "published", path: "/places/x" })

    runAutoPublishTick.mockResolvedValueOnce({ kind: "disabled" })
    expect((await POST(makeRequest(SECRET))).status).toBe(200)

    runAutoPublishTick.mockResolvedValueOnce({ kind: "failed", errorCode: "internal" })
    expect((await POST(makeRequest(SECRET))).status).toBe(500)
  })

  it("keeps the auto-publish switch parser strict (only \"on\" enables)", async () => {
    const { parseAutoPublishSetting } = await import("@/lib/seo-pages/auto-publish")
    expect(parseAutoPublishSetting("on")).toBe(true)
    expect(parseAutoPublishSetting(" ON ")).toBe(true)
    for (const value of ["off", "", null, undefined, 1, true, "yes"]) {
      expect(parseAutoPublishSetting(value)).toBe(false)
    }
  })
})
