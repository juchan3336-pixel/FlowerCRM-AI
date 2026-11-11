// Collect 외부 예약 endpoint 계약 — 인증·환경 가드·응답. 인증을 통과하기 전에는 아무것도 부르지 않는다.
import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

type TickArgs = { readonly slot: string; readonly deadlineAtMs: number }
const runCollectDispatchTick = vi.fn<(args: TickArgs) => Promise<unknown>>()
const createLiveCollectDispatchDependencies = vi.fn<(token: string) => unknown>()
vi.mock("@/lib/collect-dispatch/service", () => ({ runCollectDispatchTick: (_deps: unknown, args: TickArgs) => runCollectDispatchTick(args) }))
vi.mock("@/lib/collect-dispatch/dependencies", () => ({
  createLiveCollectDispatchDependencies: (token: string) => createLiveCollectDispatchDependencies(token),
}))

import { signDispatchRequest, slotForTime } from "@/lib/collect-dispatch/policy"

const SECRET = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
const TOKEN = "github-token-value"
const URL_ = "https://flowercrm-seo.vercel.app/api/collect/dispatch"
const ENV_KEYS = ["VERCEL_ENV", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "COLLECT_DISPATCH_SIGNING_SECRET", "COLLECT_GITHUB_TOKEN"]
const saved = new Map<string, string | undefined>()

const nowTimestamp = () => String(Math.floor(Date.now() / 1000))

function signedRequest({ body = "{}", timestamp = nowTimestamp(), secret = SECRET }: { body?: string; timestamp?: string; secret?: string } = {}): Request {
  return new Request(URL_, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-collect-dispatch-timestamp": timestamp,
      "x-collect-dispatch-signature": signDispatchRequest(secret, timestamp, body),
    },
    body,
  })
}

async function post(request: Request): Promise<Response> {
  const { POST } = await import("@/app/api/collect/dispatch/route")
  return POST(request)
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key])
  process.env["VERCEL_ENV"] = "production"
  process.env["NEXT_PUBLIC_SUPABASE_URL"] = "https://project.supabase.co"
  process.env["SUPABASE_SERVICE_ROLE_KEY"] = "service-role"
  process.env["COLLECT_DISPATCH_SIGNING_SECRET"] = SECRET
  process.env["COLLECT_GITHUB_TOKEN"] = TOKEN
  runCollectDispatchTick.mockReset()
  createLiveCollectDispatchDependencies.mockReset()
})

afterEach(() => {
  for (const key of ENV_KEYS) process.env[key] = saved.get(key) ?? ""
})

function expectNothingCalled() {
  expect(createLiveCollectDispatchDependencies).not.toHaveBeenCalled()
  expect(runCollectDispatchTick).not.toHaveBeenCalled()
}

describe("POST /api/collect/dispatch", () => {
  it("서명이 맞으면 tick을 한 번 돌리고 결과를 그대로 매핑한다", async () => {
    runCollectDispatchTick.mockResolvedValue({ kind: "sent", slot: "2026-11-10T03:45:00.000Z", mode: "dry_run", runId: null })
    const response = await post(signedRequest())
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ result: "sent", slot: "2026-11-10T03:45:00.000Z", mode: "dry_run", runId: null })
    expect(createLiveCollectDispatchDependencies).toHaveBeenCalledExactlyOnceWith(TOKEN)
    expect(runCollectDispatchTick).toHaveBeenCalledTimes(1)
  })

  it("꺼져 있을 때의 noop은 200이다", async () => {
    runCollectDispatchTick.mockResolvedValue({ kind: "noop", reason: "disabled" })
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
        "x-collect-dispatch-timestamp": timestamp,
        "x-collect-dispatch-signature": signDispatchRequest(SECRET, timestamp, "{}"),
      },
      body: JSON.stringify({ mode: "live", ref: "attacker-branch", limit: "5000" }),
    })
    expect((await post(tampered)).status).toBe(401)
    expectNothingCalled()
  })

  it("서명이 맞아도 본문의 내용은 어디에도 전달되지 않는다", async () => {
    runCollectDispatchTick.mockResolvedValue({ kind: "noop", reason: "disabled" })
    const body = JSON.stringify({ mode: "live", ref: "other", limit: "5000" })
    await post(signedRequest({ body }))
    expect(createLiveCollectDispatchDependencies).toHaveBeenCalledExactlyOnceWith(TOKEN)
    expect(Object.keys(runCollectDispatchTick.mock.calls[0]?.[0] ?? {}).sort()).toEqual(["deadlineAtMs", "slot"])
  })

  it("slot은 도착 시각이 아니라 서명된 시각에서 나온다 — 구간 경계를 넘겨 다시 보내도 같은 slot이다", async () => {
    runCollectDispatchTick.mockResolvedValue({ kind: "noop", reason: "duplicate-slot" })
    vi.useFakeTimers()
    try {
      // 서명 시각은 구간이 끝나기 1초 전이다.
      const signedAtMs = Date.parse("2026-11-10T02:14:59Z")
      const timestamp = String(signedAtMs / 1000)
      vi.setSystemTime(signedAtMs)
      await post(signedRequest({ timestamp }))
      // 같은 요청이 2초 뒤(다음 구간)에 다시 도착한다. 서명은 아직 유효하다.
      vi.setSystemTime(signedAtMs + 2000)
      const replay = await post(signedRequest({ timestamp }))
      expect(replay.status).toBe(200)

      const slots = runCollectDispatchTick.mock.calls.map(([args]) => args.slot)
      expect(slots).toEqual(["2026-11-10T00:45:00.000Z", "2026-11-10T00:45:00.000Z"])
      expect(slots[1]).not.toBe(slotForTime(signedAtMs + 2000))
    } finally {
      vi.useRealTimers()
    }
  })

  it("호출 전체의 기한은 호출자(pg_net 30초)보다 짧다", async () => {
    runCollectDispatchTick.mockResolvedValue({ kind: "noop", reason: "disabled" })
    const before = Date.now()
    await post(signedRequest())
    const deadline = runCollectDispatchTick.mock.calls[0]?.[0].deadlineAtMs ?? 0
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
    for (const key of ["COLLECT_GITHUB_TOKEN", "COLLECT_DISPATCH_SIGNING_SECRET", "SUPABASE_SERVICE_ROLE_KEY"]) {
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
    runCollectDispatchTick.mockRejectedValue(new Error(`ledger down ${TOKEN} ${SECRET}`))
    const response = await post(signedRequest())
    expect(response.status).toBe(500)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ result: "failed" })
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain("ledger down")
  })

  it("결과 불명과 거절은 502로 드러난다", async () => {
    runCollectDispatchTick.mockResolvedValue({ kind: "unknown", slot: "2026-11-10T03:45:00.000Z" })
    expect((await post(signedRequest())).status).toBe(502)
    runCollectDispatchTick.mockResolvedValue({ kind: "rejected", slot: "2026-11-10T03:45:00.000Z", httpStatus: 403 })
    const response = await post(signedRequest())
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ result: "rejected", slot: "2026-11-10T03:45:00.000Z", httpStatus: 403 })
  })

  it("POST만 내보낸다 — GET으로는 아무 일도 일어나지 않는다", async () => {
    const route = await import("@/app/api/collect/dispatch/route")
    expect(Object.keys(route).filter((name) => /^(GET|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(name))).toEqual([])
  })
})

describe("SQL과의 계약", () => {
  const sql = readFileSync(new URL("../supabase/operations/collect_dispatch_cron.sql", import.meta.url), "utf8")
  const migration = readFileSync(new URL("../supabase/migrations/202611110001_collect_dispatch_control.sql", import.meta.url), "utf8")
  const between = (text: string, from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)))

  it("SQL이 서명하는 문자열·헤더·주소가 서버와 같다", () => {
    expect(sql).toContain("convert_to(v_timestamp || '.POST./api/collect/dispatch.' || v_body, 'utf8')")
    expect(sql).toContain("v_body text := '{}'")
    expect(sql).toContain("'x-collect-dispatch-timestamp', v_timestamp")
    expect(sql).toContain("'x-collect-dispatch-signature', v_signature")
    expect(sql).toContain("url := 'https://flowercrm-seo.vercel.app/api/collect/dispatch'")
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
    const fn = between(sql, "create or replace function public.request_collect_dispatch()", "commit;")
    expect(fn).toContain("set search_path = ''")
    expect(fn).toContain("extensions.hmac(")
    expect(fn).toContain("net.http_post(")
    expect(fn).toContain("vault.decrypted_secrets")
    expect(fn).toContain("insert into public.collect_dispatch_requests (net_request_id, signed_at)")
    expect(fn).toContain("revoke all on function public.request_collect_dispatch() from public, anon, authenticated, service_role;")
    expect(fn).toContain("grant execute on function public.request_collect_dispatch() to postgres;")
    // 함수 생성과 권한 정리는 같은 트랜잭션이다.
    expect(between(sql, "-- 2단계.", "-- 3단계.")).toMatch(/begin;[\s\S]*create or replace function[\s\S]*revoke all on function[\s\S]*commit;/)
  })

  it("cron은 등록과 같은 트랜잭션에서 꺼진 채로 끝나고, 명령에는 함수 호출만 있다", () => {
    const register = between(sql, "-- 3단계.", "-- 4단계.")
    expect(register).toContain("cron.schedule('collect-dispatch-a', '45 0,3,6,9,12,15,18,21 * * *'")
    expect(register).toContain("cron.schedule('collect-dispatch-b', '15 2,5,8,11,14,17,20,23 * * *'")
    expect(register).toMatch(/begin;[\s\S]*cron\.alter_job\(jobid, active := false\)[\s\S]*commit;/)
    expect(register.match(/\$CRON\$ select public\.request_collect_dispatch\(\); \$CRON\$/g)).toHaveLength(2)
  })

  it("cron이 발화하는 시각은 서버의 slot 시작 시각과 같고, Enrich의 발화 시각과 겹치지 않는다", () => {
    const fireTimes = (text: string, prefix: string) => {
      const day = Date.parse("2026-11-10T00:00:00Z")
      const times: number[] = []
      for (const match of text.matchAll(new RegExp(`cron\\.schedule\\('${prefix}-[ab]', '(\\d+) ([\\d,]+) \\* \\* \\*'`, "g"))) {
        for (const hour of (match[2] ?? "").split(",")) times.push(day + Number(hour) * 3_600_000 + Number(match[1]) * 60_000)
      }
      return times
    }
    const collectFires = fireTimes(sql, "collect-dispatch")
    expect(collectFires).toHaveLength(16)
    for (const fire of collectFires) expect(Date.parse(slotForTime(fire))).toBe(fire)
    expect(new Set(collectFires.map(slotForTime)).size).toBe(16)

    const enrichSql = readFileSync(new URL("../supabase/operations/enrich_dispatch_cron.sql", import.meta.url), "utf8")
    const enrichFires = fireTimes(enrichSql, "enrich-dispatch")
    expect(enrichFires).toHaveLength(16)
    for (const fire of collectFires) {
      expect(Math.min(...enrichFires.map((other) => Math.abs(other - fire)))).toBe(45 * 60_000)
    }
  })

  it("서명키는 앞뒤 공백을 잘라 등록하고, 형식이 맞지 않으면 요청을 만들지 않는다", () => {
    const register = between(sql, "-- 1단계.", "-- 2단계.")
    expect(register).toContain("select vault.create_secret(btrim('<SIGNING_SECRET>', E' \\t\\r\\n'), 'collect_dispatch_signing_secret'")
    expect(register).toContain("'hex64', coalesce(bool_and(decrypted_secret ~ '^[0-9a-f]{64}$'), false)")
    // 확인 쿼리는 값 자체를 돌려주지 않는다.
    expect(register).not.toMatch(/^select\s+decrypted_secret/m)
    const fn = between(sql, "create or replace function public.request_collect_dispatch()", "-- 3단계.")
    expect(fn).toContain("if v_secret is null or v_secret !~ '^[0-9a-f]{64}$' then")
    expect(fn.indexOf("raise exception")).toBeLessThan(fn.indexOf("net.http_post"))
  })

  it("첫 live 요청은 예약을 켜기 전에 한 번만 보내고, 끈 뒤 저장을 확인한다", () => {
    const live = between(sql, "-- 6단계.", "-- 7단계.")
    const order = ["-- 6A.", "mode = 'live'", "select public.request_collect_dispatch()", "-- 6B.", "-- 6C.", "set enabled = false", "-- 6D."].map((mark) =>
      live.indexOf(mark),
    )
    expect(order.every((at) => at > -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(live).not.toContain("cron.alter_job")
    // slot 조회는 서버와 같은 계산이다: (epoch - 45분) / 90분.
    expect(live).toContain("floor((extract(epoch from q.signed_at) - 2700) / 5400) * 5400 + 2700")
    expect(sql.indexOf("active := true")).toBeGreaterThan(sql.indexOf("-- 7단계."))
  })

  it("동시 호출 검증의 시간 제한은 탭 1의 begin 부터 센다", () => {
    const check = between(sql, "-- 5E.", "-- 6단계.")
    expect(check).toContain("extract(epoch from (now() - created_at))::int as age_seconds")
    expect(check.indexOf("age_seconds")).toBeLessThan(check.indexOf("'00000000-0000-4000-8000-00000000000c'"))
  })

  it("이 절차는 Enrich 예약의 테이블·함수·cron을 바꾸지 않는다", () => {
    const statements = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
    // Enrich 쪽 이름은 서명키가 서로 다른지 읽기 전용으로 비교하는 한 곳에만 나온다.
    const mentions = statements.split("\n").filter((line) => /enrich/i.test(line)).map((line) => line.trim())
    expect(mentions).toEqual([
      "'same_as_enrich', coalesce(bool_or(decrypted_secret = (",
      "select e.decrypted_secret from vault.decrypted_secrets e where e.name = 'enrich_dispatch_signing_secret'",
    ])
    expect(migration).not.toMatch(/enrich/i)
  })

  it("연결 확인은 먼저 끄고 시작하며, 응답은 그 요청의 id로만 본다", () => {
    const probe = between(sql, "-- 4단계.", "-- 5단계.")
    expect(probe.indexOf("set enabled = false, mode = 'dry_run'")).toBeGreaterThan(-1)
    expect(probe.indexOf("set enabled = false, mode = 'dry_run'")).toBeLessThan(probe.indexOf("select public.request_collect_dispatch()"))
    expect(probe).toContain("where r.id = <REQUEST_ID>")
    // 다른 pump의 응답과 섞이는 "최근 N건" 조회를 Collect 확인에 쓰지 않는다.
    expect(sql).not.toMatch(/from net\._http_response\s+order by created desc/)
  })

  it("dry-run 단계는 켜고 요청하는 실행과 끄는 실행이 분리돼 있다", () => {
    const dryRun = between(sql, "-- 5단계.", "-- 5E.")
    // pg_net 요청은 커밋 뒤에 출발하므로, 한 번에 실행하면 꺼진 상태를 만난다.
    expect(dryRun).toContain("한꺼번에 실행하지 않는다")
    expect(dryRun).not.toContain("한꺼번에 실행해도 된다")
    const a = dryRun.indexOf("-- 5A.")
    const b = dryRun.indexOf("-- 5B.")
    const c = dryRun.indexOf("-- 5C.")
    const d = dryRun.indexOf("-- 5D.")
    expect(a).toBeGreaterThan(-1)
    expect(a < b && b < c && c < d).toBe(true)
    const stepA = dryRun.slice(a, b)
    expect(stepA).toContain("set enabled = true, mode = 'dry_run'")
    expect(stepA).toContain("select public.request_collect_dispatch()")
    expect(stepA).not.toContain("set enabled = false")
    expect(dryRun.slice(b, c)).toContain("where r.id = <REQUEST_ID>")
    expect(dryRun.slice(c, d)).toContain("set enabled = false")
    expect(dryRun).not.toContain("'live'")
  })

  it("live와 cron 활성화는 dry-run·동시 호출 검증 뒤의 별도 단계다", () => {
    const order = ["-- 5단계.", "-- 5E.", "-- 6단계.", "mode = 'live'", "cron.alter_job(jobid, active := true)"].map((marker) => sql.indexOf(marker))
    expect(order.every((index) => index > -1)).toBe(true)
    expect([...order].sort((x, y) => x - y)).toEqual(order)
  })

  it("동시 호출 검증은 기대값이 적혀 있고, 끝에 시험 행을 지우고 끈다", () => {
    const check = between(sql, "-- 5E.", "-- 6단계.")
    // SQL Editor의 실행마다 연결이 달라질 수 있으므로 잠금을 쥐는 구간은 한 번의 실행 안에 있다.
    const lines = check.split("\n")
    const begin = lines.indexOf("begin;")
    expect(begin).toBeGreaterThan(-1)
    expect(lines[begin + 1]).toContain("select public.claim_collect_dispatch_slot('test-concurrency-a'")
    expect(lines[begin + 2]).toBe("select pg_sleep(60);")
    expect(lines[begin + 3]).toBe("commit;")
    expect(check).toContain("claim 결과는 claimed")
    expect(check).toContain("blocked")
    expect(check).toContain("기대 lost, 그리고 false")
    expect(check).toContain("기대 disabled")
    expect(check.lastIndexOf("delete from public.collect_dispatch_ledger where slot like 'test-concurrency-%';")).toBeGreaterThan(check.indexOf("begin;"))
    expect(check.lastIndexOf("set enabled = false")).toBeGreaterThan(check.indexOf("set enabled = true"))
  })

  it("결과 불명 해제는 'run이 안 보이면 도착하지 않은 것'이라고 단정하지 않는다", () => {
    expect(sql).not.toContain("없으면 dispatch 는 도착하지 않은 것이다")
    expect(sql).toContain("없다고 해서 도착하지 않았다고 단정하지 않는다")
  })

  it("연결 확인은 이전 기록이 있어도 이번 시험 호출이 만든 행만 센다", () => {
    const probe = between(sql, "-- 4단계.", "-- 5단계.")
    expect(probe).toContain("where created_at >= (select max(requested_at) from public.collect_dispatch_requests)")
  })

  it("적용 직후는 꺼짐 + dry_run이고, 시크릿·cron·live가 migration에 없다", () => {
    expect(migration).toContain("enabled boolean not null default false")
    expect(migration).toContain("mode text not null default 'dry_run' check (mode in ('dry_run', 'live'))")
    expect(migration).not.toMatch(/cron\.schedule|vault\.create_secret|net\.http_post/)
    expect(migration).not.toMatch(/set enabled = true|mode = 'live'/)
  })

  it("브라우저 역할은 접근할 수 없고, 서버도 테이블을 직접 쓰지 못한다 — RPC로만 바뀐다", () => {
    // GRANT는 더하기만 한다 — 기본 권한으로 붙었을 쓰기 권한까지 먼저 전부 회수한다.
    for (const table of ["collect_dispatch_control", "collect_dispatch_ledger"]) {
      const revoke = `revoke all on table public.${table} from public, anon, authenticated, service_role;`
      const grant = `grant select on table public.${table} to service_role;`
      expect(migration).toContain(revoke)
      expect(migration.indexOf(revoke)).toBeLessThan(migration.indexOf(grant))
    }
    expect(sql).toContain("has_table_privilege('service_role', 'public.' || t.name, 'UPDATE') as can_update")
    expect(migration).toContain("grant select on table public.collect_dispatch_ledger to service_role;")
    expect(migration).not.toMatch(/grant [a-z, ]*(insert|update|delete)[a-z, ]* on table public\.collect_dispatch_/)
    for (const signature of [
      "claim_collect_dispatch_slot(text, uuid)",
      "prepare_collect_dispatch(text, uuid)",
      "finish_collect_dispatch(text, uuid, text, text, integer, bigint)",
    ]) {
      expect(migration).toContain(`revoke all on function public.${signature} from public, anon, authenticated;`)
      expect(migration).toContain(`grant execute on function public.${signature} to service_role;`)
    }
    expect(migration.match(/set search_path = ''/g)).toHaveLength(3)
  })

  it("claim은 제어 행을 잠근 채로 꺼짐·미완료 시도·중복을 판정한다", () => {
    const claim = between(migration, "create or replace function public.claim_collect_dispatch_slot", "-- 4) prepare")
    expect(claim).toContain("from public.collect_dispatch_control where id = 1 for update")
    expect(claim.indexOf("return 'disabled'")).toBeLessThan(claim.indexOf("insert into public.collect_dispatch_ledger"))
    // claimed도 다른 slot을 막는다 — dispatching/unknown만 보던 것이 인접 slot 이중 발송의 원인이었다.
    expect(claim).toContain("where status in ('claimed', 'dispatching', 'unknown')")
    expect(claim).toContain("on conflict (slot) do nothing")
    // 자동으로 정리되는 것은 아무것도 보내지 않은 claimed뿐이다.
    expect(claim).toContain("set status = 'abandoned'")
    expect(claim).toContain("where status = 'claimed' and updated_at < now() - interval '2 minutes'")
    expect(migration).toContain("slot text not null unique")
  })

  it("prepare는 보내기 직전에 다시 잠그고, 소유권·상태가 맞을 때만 그 순간의 mode를 돌려준다", () => {
    const prepare = between(migration, "create or replace function public.prepare_collect_dispatch", "-- 5) finish")
    expect(prepare).toContain("select enabled, mode into v_enabled, v_mode from public.collect_dispatch_control where id = 1 for update")
    expect(prepare).toContain("set status = 'dispatching', mode = v_mode")
    expect(prepare.match(/where slot = p_slot and dispatch_id = p_dispatch_id and status = 'claimed'/g)).toHaveLength(2)
    expect(prepare).toContain("return 'lost'")
    expect(prepare).toContain("return 'disabled'")
    expect(prepare).toContain("return v_mode")
  })

  it("finish는 slot·dispatch id·기대 상태가 모두 맞는 행 하나만 바꾸고, 허용된 전이만 받는다", () => {
    const finish = between(migration, "create or replace function public.finish_collect_dispatch", "-- 6) 접근")
    expect(finish).toContain("where slot = p_slot and dispatch_id = p_dispatch_id and status = p_from_status")
    expect(finish).toContain("return v_updated = 1")
    expect(finish).toContain("(p_from_status = 'claimed' and p_status in ('busy', 'check_failed', 'out_of_time'))")
    expect(finish).toContain("(p_from_status = 'dispatching' and p_status in ('not_sent', 'sent', 'rejected', 'unknown'))")
  })
})
