// Enrich 외부 예약 endpoint 계약 — 인증·환경 가드·응답. 인증을 통과하기 전에는 아무것도 부르지 않는다.
import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const runEnrichDispatchTick = vi.fn<() => Promise<unknown>>()
const createLiveEnrichDispatchDependencies = vi.fn<(token: string) => unknown>()
vi.mock("@/lib/enrich-dispatch/service", () => ({ runEnrichDispatchTick: () => runEnrichDispatchTick() }))
vi.mock("@/lib/enrich-dispatch/dependencies", () => ({
  createLiveEnrichDispatchDependencies: (token: string) => createLiveEnrichDispatchDependencies(token),
}))

import { signDispatchRequest } from "@/lib/enrich-dispatch/policy"

const SECRET = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
const TOKEN = "github-token-value"
const URL_ = "https://flowercrm-seo.vercel.app/api/enrich/dispatch"
const ENV_KEYS = ["VERCEL_ENV", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ENRICH_DISPATCH_SIGNING_SECRET", "ENRICH_GITHUB_TOKEN"]
const saved = new Map<string, string | undefined>()

const nowTimestamp = () => String(Math.floor(Date.now() / 1000))

function signedRequest({ body = "{}", timestamp = nowTimestamp(), secret = SECRET }: { body?: string; timestamp?: string; secret?: string } = {}): Request {
  return new Request(URL_, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-enrich-dispatch-timestamp": timestamp,
      "x-enrich-dispatch-signature": signDispatchRequest(secret, timestamp, body),
    },
    body,
  })
}

async function post(request: Request): Promise<Response> {
  const { POST } = await import("@/app/api/enrich/dispatch/route")
  return POST(request)
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key])
  process.env["VERCEL_ENV"] = "production"
  process.env["NEXT_PUBLIC_SUPABASE_URL"] = "https://project.supabase.co"
  process.env["SUPABASE_SERVICE_ROLE_KEY"] = "service-role"
  process.env["ENRICH_DISPATCH_SIGNING_SECRET"] = SECRET
  process.env["ENRICH_GITHUB_TOKEN"] = TOKEN
  runEnrichDispatchTick.mockReset()
  createLiveEnrichDispatchDependencies.mockReset()
})

afterEach(() => {
  for (const key of ENV_KEYS) process.env[key] = saved.get(key) ?? ""
})

function expectNothingCalled() {
  expect(createLiveEnrichDispatchDependencies).not.toHaveBeenCalled()
  expect(runEnrichDispatchTick).not.toHaveBeenCalled()
}

describe("POST /api/enrich/dispatch", () => {
  it("서명이 맞으면 tick을 한 번 돌리고 결과를 그대로 매핑한다", async () => {
    runEnrichDispatchTick.mockResolvedValue({ kind: "sent", slot: "2026-11-10T03:00:00.000Z", mode: "dry_run", runId: null })
    const response = await post(signedRequest())
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ result: "sent", slot: "2026-11-10T03:00:00.000Z", mode: "dry_run", runId: null })
    expect(createLiveEnrichDispatchDependencies).toHaveBeenCalledExactlyOnceWith(TOKEN)
    expect(runEnrichDispatchTick).toHaveBeenCalledTimes(1)
  })

  it("꺼져 있을 때의 noop은 200이다", async () => {
    runEnrichDispatchTick.mockResolvedValue({ kind: "noop", reason: "disabled" })
    const response = await post(signedRequest())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ result: "noop", reason: "disabled" })
  })

  it("서명 헤더가 없으면 401이고 아무것도 부르지 않는다", async () => {
    const response = await post(new Request(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ result: "unauthorized" })
    expectNothingCalled()
  })

  it("다른 키의 서명, 만료된 서명, 미래의 서명은 401이고 아무것도 부르지 않는다", async () => {
    const past = String(Math.floor(Date.now() / 1000) - 301)
    const future = String(Math.floor(Date.now() / 1000) + 120)
    for (const request of [signedRequest({ secret: SECRET.replace("f", "e") }), signedRequest({ timestamp: past }), signedRequest({ timestamp: future })]) {
      expect((await post(request)).status).toBe(401)
    }
    expectNothingCalled()
  })

  it("서명한 본문과 다른 본문이 오면 401이다 — 본문으로 쓰기·ref를 바꿀 수 없다", async () => {
    const timestamp = nowTimestamp()
    const tampered = new Request(URL_, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-enrich-dispatch-timestamp": timestamp,
        "x-enrich-dispatch-signature": signDispatchRequest(SECRET, timestamp, "{}"),
      },
      body: JSON.stringify({ mode: "live", ref: "attacker-branch", limit: "5000" }),
    })
    expect((await post(tampered)).status).toBe(401)
    expectNothingCalled()
  })

  it("서명이 맞아도 본문의 내용은 어디에도 전달되지 않는다", async () => {
    runEnrichDispatchTick.mockResolvedValue({ kind: "noop", reason: "disabled" })
    const body = JSON.stringify({ mode: "live", ref: "other", limit: "5000" })
    await post(signedRequest({ body }))
    expect(createLiveEnrichDispatchDependencies).toHaveBeenCalledExactlyOnceWith(TOKEN)
    expect(runEnrichDispatchTick.mock.calls[0]).toEqual([])
  })

  it("Production이 아니면 서명이 맞아도 409이고 아무것도 부르지 않는다", async () => {
    for (const vercelEnv of ["preview", "development", ""]) {
      process.env["VERCEL_ENV"] = vercelEnv
      const response = await post(signedRequest())
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ result: "conflict", reason: "not-production" })
    }
    expectNothingCalled()
  })

  it("환경변수가 비어 있으면 409이고 아무것도 부르지 않는다", async () => {
    for (const key of ["ENRICH_GITHUB_TOKEN", "ENRICH_DISPATCH_SIGNING_SECRET", "SUPABASE_SERVICE_ROLE_KEY"]) {
      const original = process.env[key]
      process.env[key] = ""
      const response = await post(signedRequest())
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ result: "conflict", reason: "missing-env" })
      process.env[key] = original
    }
    expectNothingCalled()
  })

  it("내부 실패는 500이고, 원문·토큰·서명키가 응답에 없다", async () => {
    runEnrichDispatchTick.mockRejectedValue(new Error(`ledger down ${TOKEN} ${SECRET}`))
    const response = await post(signedRequest())
    expect(response.status).toBe(500)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ result: "failed" })
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain("ledger down")
  })

  it("결과 불명과 거절은 502로 드러난다", async () => {
    runEnrichDispatchTick.mockResolvedValue({ kind: "unknown", slot: "2026-11-10T03:00:00.000Z" })
    expect((await post(signedRequest())).status).toBe(502)
    runEnrichDispatchTick.mockResolvedValue({ kind: "rejected", slot: "2026-11-10T03:00:00.000Z", httpStatus: 403 })
    const response = await post(signedRequest())
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ result: "rejected", slot: "2026-11-10T03:00:00.000Z", httpStatus: 403 })
  })

  it("POST만 내보낸다 — GET으로는 아무 일도 일어나지 않는다", async () => {
    const route = await import("@/app/api/enrich/dispatch/route")
    expect(Object.keys(route).filter((name) => /^(GET|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(name))).toEqual([])
  })
})

describe("SQL과의 계약", () => {
  const sql = readFileSync(new URL("../supabase/operations/enrich_dispatch_cron.sql", import.meta.url), "utf8")
  const migration = readFileSync(new URL("../supabase/migrations/202611100003_enrich_dispatch_control.sql", import.meta.url), "utf8")

  it("SQL이 서명하는 문자열·헤더·주소가 서버와 같다", () => {
    expect(sql).toContain("v_timestamp || '.POST./api/enrich/dispatch.' || v_body")
    expect(sql).toContain("v_body text := '{}'")
    expect(sql).toContain("'x-enrich-dispatch-timestamp', v_timestamp")
    expect(sql).toContain("'x-enrich-dispatch-signature', v_signature")
    expect(sql).toContain("url := 'https://flowercrm-seo.vercel.app/api/enrich/dispatch'")
    expect(sql).toContain("'sha256'")
  })

  it("요청에는 서명키도 GitHub 토큰도 실리지 않는다", () => {
    const headers = sql.slice(sql.indexOf("headers := jsonb_build_object("), sql.indexOf("body := v_body::jsonb"))
    expect(headers).not.toContain("v_secret")
    expect(headers).not.toContain("decrypted_secret")
    expect(sql).not.toMatch(/authorization/i)
    expect(sql).not.toMatch(/ghp_|github_pat_/)
  })

  it("cron은 등록과 같은 트랜잭션에서 꺼진 채로 끝나고, 명령에는 함수 호출만 있다", () => {
    const register = sql.slice(sql.indexOf("begin;"), sql.indexOf("commit;"))
    expect(register).toContain("cron.schedule('enrich-dispatch-a', '0 0,3,6,9,12,15,18,21 * * *'")
    expect(register).toContain("cron.schedule('enrich-dispatch-b', '30 1,4,7,10,13,16,19,22 * * *'")
    expect(register).toContain("cron.alter_job(jobid, active := false)")
    expect(register.match(/\$CRON\$ select public\.request_enrich_dispatch\(\); \$CRON\$/g)).toHaveLength(2)
  })

  it("적용 직후는 꺼짐 + dry_run이고, 브라우저 역할은 접근할 수 없다", () => {
    expect(migration).toContain("enabled boolean not null default false")
    expect(migration).toContain("mode text not null default 'dry_run' check (mode in ('dry_run', 'live'))")
    expect(migration).toContain("revoke all on table public.enrich_dispatch_control from anon, authenticated;")
    expect(migration).toContain("revoke all on table public.enrich_dispatch_ledger from anon, authenticated;")
    expect(migration).toContain("revoke all on function public.claim_enrich_dispatch_slot(text, uuid) from anon, authenticated;")
    expect(migration).not.toMatch(/cron\.schedule|vault\.create_secret/)
  })

  it("claim은 제어 행을 잠그고, 결과 불명 행이 있으면 막고, slot은 유일하다", () => {
    expect(migration).toContain("from public.enrich_dispatch_control where id = 1 for update")
    expect(migration).toContain("where status in ('dispatching', 'unknown')")
    expect(migration).toContain("slot text not null unique")
    expect(migration).toContain("on conflict (slot) do nothing")
  })
})
