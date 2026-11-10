// Enrich 외부 예약 endpoint 계약 — 인증·환경 가드·응답. 인증을 통과하기 전에는 아무것도 부르지 않는다.
import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

type TickArgs = { readonly slot: string; readonly deadlineAtMs: number }
const runEnrichDispatchTick = vi.fn<(args: TickArgs) => Promise<unknown>>()
const createLiveEnrichDispatchDependencies = vi.fn<(token: string) => unknown>()
vi.mock("@/lib/enrich-dispatch/service", () => ({ runEnrichDispatchTick: (_deps: unknown, args: TickArgs) => runEnrichDispatchTick(args) }))
vi.mock("@/lib/enrich-dispatch/dependencies", () => ({
  createLiveEnrichDispatchDependencies: (token: string) => createLiveEnrichDispatchDependencies(token),
}))

import { signDispatchRequest, slotForTime } from "@/lib/enrich-dispatch/policy"

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
    expect(Object.keys(runEnrichDispatchTick.mock.calls[0]?.[0] ?? {}).sort()).toEqual(["deadlineAtMs", "slot"])
  })

  it("slot은 도착 시각이 아니라 서명된 시각에서 나온다 — 구간 경계를 넘겨 다시 보내도 같은 slot이다", async () => {
    runEnrichDispatchTick.mockResolvedValue({ kind: "noop", reason: "duplicate-slot" })
    vi.useFakeTimers()
    try {
      // 서명 시각은 구간이 끝나기 1초 전이다.
      const signedAtMs = Date.parse("2026-11-10T02:59:59Z")
      const timestamp = String(signedAtMs / 1000)
      vi.setSystemTime(signedAtMs)
      await post(signedRequest({ timestamp }))
      // 같은 요청이 2초 뒤(다음 구간)에 다시 도착한다. 서명은 아직 유효하다.
      vi.setSystemTime(signedAtMs + 2000)
      const replay = await post(signedRequest({ timestamp }))
      expect(replay.status).toBe(200)

      const slots = runEnrichDispatchTick.mock.calls.map(([args]) => args.slot)
      expect(slots).toEqual(["2026-11-10T01:30:00.000Z", "2026-11-10T01:30:00.000Z"])
      expect(slots[1]).not.toBe(slotForTime(signedAtMs + 2000))
    } finally {
      vi.useRealTimers()
    }
  })

  it("호출 전체의 기한은 호출자(pg_net 30초)보다 짧다", async () => {
    runEnrichDispatchTick.mockResolvedValue({ kind: "noop", reason: "disabled" })
    const before = Date.now()
    await post(signedRequest())
    const deadline = runEnrichDispatchTick.mock.calls[0]?.[0].deadlineAtMs ?? 0
    expect(deadline - before).toBeGreaterThanOrEqual(25_000)
    expect(deadline - before).toBeLessThan(30_000)
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
  const between = (text: string, from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)))

  it("SQL이 서명하는 문자열·헤더·주소가 서버와 같다", () => {
    expect(sql).toContain("convert_to(v_timestamp || '.POST./api/enrich/dispatch.' || v_body, 'utf8')")
    expect(sql).toContain("v_body text := '{}'")
    expect(sql).toContain("'x-enrich-dispatch-timestamp', v_timestamp")
    expect(sql).toContain("'x-enrich-dispatch-signature', v_signature")
    expect(sql).toContain("url := 'https://flowercrm-seo.vercel.app/api/enrich/dispatch'")
    expect(sql).toContain("'sha256'")
    // 호출자의 대기 시간은 서버의 전체 기한(25초)보다 길다.
    expect(sql).toContain("timeout_milliseconds := 30000")
  })

  it("요청에는 서명키도 GitHub 토큰도 실리지 않는다", () => {
    const headers = between(sql, "headers := jsonb_build_object(", "body := v_body::jsonb")
    expect(headers).not.toContain("v_secret")
    expect(headers).not.toContain("decrypted_secret")
    expect(sql).not.toMatch(/authorization/i)
    expect(sql).not.toMatch(/ghp_|github_pat_/)
  })

  it("요청 함수는 신뢰하는 스키마만 이름으로 부르고, 실행 권한은 cron 역할에만 있다", () => {
    const fn = between(sql, "create or replace function public.request_enrich_dispatch()", "commit;")
    expect(fn).toContain("set search_path = ''")
    expect(fn).toContain("extensions.hmac(")
    expect(fn).toContain("net.http_post(")
    expect(fn).toContain("vault.decrypted_secrets")
    expect(fn).toContain("insert into public.enrich_dispatch_requests (net_request_id, signed_at)")
    expect(fn).toContain("revoke all on function public.request_enrich_dispatch() from public, anon, authenticated, service_role;")
    expect(fn).toContain("grant execute on function public.request_enrich_dispatch() to postgres;")
    // 함수 생성과 권한 정리는 같은 트랜잭션이다.
    expect(between(sql, "-- 2단계.", "-- 3단계.")).toMatch(/begin;[\s\S]*create or replace function[\s\S]*revoke all on function[\s\S]*commit;/)
  })

  it("cron은 등록과 같은 트랜잭션에서 꺼진 채로 끝나고, 명령에는 함수 호출만 있다", () => {
    const register = between(sql, "-- 3단계.", "-- 4단계.")
    expect(register).toContain("cron.schedule('enrich-dispatch-a', '0 0,3,6,9,12,15,18,21 * * *'")
    expect(register).toContain("cron.schedule('enrich-dispatch-b', '30 1,4,7,10,13,16,19,22 * * *'")
    expect(register).toMatch(/begin;[\s\S]*cron\.alter_job\(jobid, active := false\)[\s\S]*commit;/)
    expect(register.match(/\$CRON\$ select public\.request_enrich_dispatch\(\); \$CRON\$/g)).toHaveLength(2)
  })

  it("연결 확인은 먼저 끄고 시작하며, 응답은 그 요청의 id로만 본다", () => {
    const probe = between(sql, "-- 4단계.", "-- 5단계.")
    expect(probe.indexOf("set enabled = false, mode = 'dry_run'")).toBeGreaterThan(-1)
    expect(probe.indexOf("set enabled = false, mode = 'dry_run'")).toBeLessThan(probe.indexOf("select public.request_enrich_dispatch()"))
    expect(probe).toContain("where r.id = <REQUEST_ID>")
    // 다른 pump의 응답과 섞이는 "최근 N건" 조회를 Enrich 확인에 쓰지 않는다.
    expect(sql).not.toMatch(/from net\._http_response\s+order by created desc/)
  })

  it("dry-run 단계는 요청 뒤 다시 끄고, live와 cron 활성화는 그 뒤의 별도 단계다", () => {
    const dryRun = between(sql, "-- 5단계.", "-- 6단계.")
    expect(dryRun.indexOf("set enabled = true, mode = 'dry_run'")).toBeLessThan(dryRun.indexOf("select public.request_enrich_dispatch()"))
    expect(dryRun.indexOf("select public.request_enrich_dispatch()")).toBeLessThan(dryRun.indexOf("set enabled = false, updated_at = now()"))
    expect(dryRun).not.toContain("'live'")
    expect(sql.indexOf("-- 6단계.")).toBeLessThan(sql.indexOf("mode = 'live'"))
    expect(sql.indexOf("mode = 'live'")).toBeLessThan(sql.indexOf("cron.alter_job(jobid, active := true)"))
  })

  it("적용 직후는 꺼짐 + dry_run이고, 시크릿·cron·live가 migration에 없다", () => {
    expect(migration).toContain("enabled boolean not null default false")
    expect(migration).toContain("mode text not null default 'dry_run' check (mode in ('dry_run', 'live'))")
    expect(migration).not.toMatch(/cron\.schedule|vault\.create_secret|net\.http_post/)
    expect(migration).not.toMatch(/set enabled = true|mode = 'live'/)
  })

  it("브라우저 역할은 접근할 수 없고, 서버도 테이블을 직접 쓰지 못한다 — RPC로만 바뀐다", () => {
    expect(migration).toContain("revoke all on table public.enrich_dispatch_control from anon, authenticated;")
    expect(migration).toContain("revoke all on table public.enrich_dispatch_ledger from anon, authenticated;")
    expect(migration).toContain("grant select on table public.enrich_dispatch_ledger to service_role;")
    expect(migration).not.toMatch(/grant [a-z, ]*(insert|update|delete)[a-z, ]* on table public\.enrich_dispatch_/)
    for (const signature of [
      "claim_enrich_dispatch_slot(text, uuid)",
      "prepare_enrich_dispatch(text, uuid)",
      "finish_enrich_dispatch(text, uuid, text, text, integer, bigint)",
    ]) {
      expect(migration).toContain(`revoke all on function public.${signature} from public, anon, authenticated;`)
      expect(migration).toContain(`grant execute on function public.${signature} to service_role;`)
    }
    expect(migration.match(/set search_path = ''/g)).toHaveLength(3)
  })

  it("claim은 제어 행을 잠근 채로 꺼짐·미완료 시도·중복을 판정한다", () => {
    const claim = between(migration, "create or replace function public.claim_enrich_dispatch_slot", "-- 4) prepare")
    expect(claim).toContain("from public.enrich_dispatch_control where id = 1 for update")
    expect(claim.indexOf("return 'disabled'")).toBeLessThan(claim.indexOf("insert into public.enrich_dispatch_ledger"))
    // claimed도 다른 slot을 막는다 — dispatching/unknown만 보던 것이 인접 slot 이중 발송의 원인이었다.
    expect(claim).toContain("where status in ('claimed', 'dispatching', 'unknown')")
    expect(claim).toContain("on conflict (slot) do nothing")
    // 자동으로 정리되는 것은 아무것도 보내지 않은 claimed뿐이다.
    expect(claim).toContain("set status = 'abandoned'")
    expect(claim).toContain("where status = 'claimed' and updated_at < now() - interval '2 minutes'")
    expect(migration).toContain("slot text not null unique")
  })

  it("prepare는 보내기 직전에 다시 잠그고, 소유권·상태가 맞을 때만 그 순간의 mode를 돌려준다", () => {
    const prepare = between(migration, "create or replace function public.prepare_enrich_dispatch", "-- 5) finish")
    expect(prepare).toContain("select enabled, mode into v_enabled, v_mode from public.enrich_dispatch_control where id = 1 for update")
    expect(prepare).toContain("set status = 'dispatching', mode = v_mode")
    expect(prepare.match(/where slot = p_slot and dispatch_id = p_dispatch_id and status = 'claimed'/g)).toHaveLength(2)
    expect(prepare).toContain("return 'lost'")
    expect(prepare).toContain("return 'disabled'")
    expect(prepare).toContain("return v_mode")
  })

  it("finish는 slot·dispatch id·기대 상태가 모두 맞는 행 하나만 바꾸고, 허용된 전이만 받는다", () => {
    const finish = between(migration, "create or replace function public.finish_enrich_dispatch", "-- 6) 접근")
    expect(finish).toContain("where slot = p_slot and dispatch_id = p_dispatch_id and status = p_from_status")
    expect(finish).toContain("return v_updated = 1")
    expect(finish).toContain("(p_from_status = 'claimed' and p_status in ('busy', 'check_failed', 'out_of_time'))")
    expect(finish).toContain("(p_from_status = 'dispatching' and p_status in ('sent', 'rejected', 'unknown'))")
  })
})
