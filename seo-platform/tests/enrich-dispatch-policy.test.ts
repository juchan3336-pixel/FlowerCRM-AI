// Enrich 외부 예약 dispatch — 순수 정책 계약.
import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"

import {
  ENRICH_SLOT_MS,
  httpStatusForOutcome,
  resolveEnrichDispatchEnvironment,
  safeResponseBody,
  signDispatchRequest,
  signaturePayload,
  slotForTime,
  verifyDispatchSignature,
  workflowInputs,
  type EnrichDispatchOutcome,
} from "@/lib/enrich-dispatch/policy"

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
const NOW_MS = 1_794_300_000_000
const TS = String(NOW_MS / 1000)
const sign = (timestamp = TS, body = "{}", secret = SECRET) => signDispatchRequest(secret, timestamp, body)
const check = (overrides: Partial<Parameters<typeof verifyDispatchSignature>[0]> = {}) =>
  verifyDispatchSignature({ secret: SECRET, timestamp: TS, signature: sign(), rawBody: "{}", nowMs: NOW_MS, ...overrides })

describe("서명", () => {
  it("SQL(pgcrypto)이 만드는 값과 같은 고정 벡터를 만든다", () => {
    // operations/enrich_dispatch_cron.sql 의 request_enrich_dispatch() 가 서명하는 문자열 그대로다.
    expect(signaturePayload("1794300000", "{}")).toBe("1794300000.POST./api/enrich/dispatch.{}")
    const expected = createHmac("sha256", Buffer.from(SECRET, "utf8")).update(Buffer.from("1794300000.POST./api/enrich/dispatch.{}", "utf8")).digest("hex")
    expect(signDispatchRequest(SECRET, "1794300000", "{}")).toBe(expected)
    expect(expected).toMatch(/^[0-9a-f]{64}$/)
  })

  it("올바른 서명만 통과한다", () => {
    expect(check()).toBe(true)
  })

  it("없는 헤더, 다른 키, 다른 본문, 다른 시각의 서명은 모두 거절한다", () => {
    expect(check({ timestamp: null })).toBe(false)
    expect(check({ signature: null })).toBe(false)
    expect(check({ signature: sign(TS, "{}", SECRET.replace("0", "1")) })).toBe(false)
    expect(check({ rawBody: '{"mode":"live"}' })).toBe(false)
    expect(check({ rawBody: "{ }" })).toBe(false)
    expect(check({ timestamp: String(NOW_MS / 1000 - 1) })).toBe(false)
  })

  it("5분이 지난 서명과 1분 넘게 미래인 서명은 거절한다", () => {
    const at = (offsetSeconds: number) => {
      const timestamp = String(NOW_MS / 1000 + offsetSeconds)
      return check({ timestamp, signature: sign(timestamp) })
    }
    expect(at(-299)).toBe(true)
    expect(at(-301)).toBe(false)
    expect(at(59)).toBe(true)
    expect(at(61)).toBe(false)
  })

  it("형식이 다른 timestamp·서명은 계산하기 전에 거절한다", () => {
    expect(check({ timestamp: `${TS}000` })).toBe(false)
    expect(check({ timestamp: "1.7943e9" })).toBe(false)
    expect(check({ timestamp: ` ${TS}` })).toBe(false)
    expect(check({ signature: sign().toUpperCase() })).toBe(false)
    expect(check({ signature: sign().slice(0, 63) })).toBe(false)
    expect(check({ signature: `${sign()}00` })).toBe(false)
    expect(check({ signature: "" })).toBe(false)
  })

  it("짧은 서명키로는 아무것도 통과하지 않는다", () => {
    const weak = "short-secret"
    expect(verifyDispatchSignature({ secret: weak, timestamp: TS, signature: sign(TS, "{}", weak), rawBody: "{}", nowMs: NOW_MS })).toBe(false)
    expect(verifyDispatchSignature({ secret: "", timestamp: TS, signature: sign(TS, "{}", ""), rawBody: "{}", nowMs: NOW_MS })).toBe(false)
  })
})

describe("slot", () => {
  it("UTC 90분 구간의 시작 시각이다", () => {
    expect(slotForTime(Date.parse("2026-11-10T00:00:00Z"))).toBe("2026-11-10T00:00:00.000Z")
    expect(slotForTime(Date.parse("2026-11-10T01:29:59Z"))).toBe("2026-11-10T00:00:00.000Z")
    expect(slotForTime(Date.parse("2026-11-10T01:30:00Z"))).toBe("2026-11-10T01:30:00.000Z")
    expect(slotForTime(Date.parse("2026-11-10T22:30:00Z"))).toBe("2026-11-10T22:30:00.000Z")
    expect(slotForTime(Date.parse("2026-11-10T23:59:59Z"))).toBe("2026-11-10T22:30:00.000Z")
  })

  it("하루는 정확히 16개 slot이고, 두 cron의 발화 시각은 각각 다른 slot에 떨어진다", () => {
    const day = Date.parse("2026-11-10T00:00:00Z")
    const fires = [
      ...[0, 3, 6, 9, 12, 15, 18, 21].map((hour) => day + hour * 3_600_000),
      ...[1, 4, 7, 10, 13, 16, 19, 22].map((hour) => day + hour * 3_600_000 + 30 * 60_000),
    ]
    expect(new Set(fires.map(slotForTime)).size).toBe(16)
    expect((24 * 3_600_000) / ENRICH_SLOT_MS).toBe(16)
    // pg_net 지연으로 몇 분 늦게 도착해도 같은 slot이다.
    const first = fires[0] ?? day
    expect(slotForTime(first + 4 * 60_000)).toBe(slotForTime(first))
  })
})

describe("workflow 입력", () => {
  it("live일 때만 dry_run이 false이고, 그 밖은 전부 true다", () => {
    expect(workflowInputs("live", "id-1")).toEqual({ limit: "50", dry_run: "false", from_start: "false", dispatch_id: "id-1" })
    expect(workflowInputs("dry_run", "id-2")).toEqual({ limit: "50", dry_run: "true", from_start: "false", dispatch_id: "id-2" })
    // 타입 밖의 값이 들어와도 쓰기로 열리지 않는다.
    expect(workflowInputs("LIVE" as never, "id-3")["dry_run"]).toBe("true")
    expect(workflowInputs(undefined as never, "id-4")["dry_run"]).toBe("true")
  })

  it("시작 행은 넣지 않는다 — 시트의 커서가 정한다", () => {
    expect(Object.keys(workflowInputs("live", "id"))).not.toContain("start_row")
  })
})

describe("환경", () => {
  const full = {
    VERCEL_ENV: "production",
    NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    ENRICH_DISPATCH_SIGNING_SECRET: SECRET,
    ENRICH_GITHUB_TOKEN: "github-token",
  }

  it("Production에서 값이 모두 있을 때만 열린다", () => {
    expect(resolveEnrichDispatchEnvironment(full)).toEqual({ ok: true, signingSecret: SECRET, githubToken: "github-token" })
  })

  it("Preview·개발 환경에서는 값이 다 있어도 닫힌다", () => {
    for (const vercelEnv of ["preview", "development", "", undefined]) {
      expect(resolveEnrichDispatchEnvironment({ ...full, VERCEL_ENV: vercelEnv })).toEqual({ ok: false, blockedBy: "not-production" })
    }
  })

  it("하나라도 없거나 비어 있으면 닫힌다", () => {
    for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ENRICH_DISPATCH_SIGNING_SECRET", "ENRICH_GITHUB_TOKEN"]) {
      expect(resolveEnrichDispatchEnvironment({ ...full, [key]: "" })).toEqual({ ok: false, blockedBy: "missing-env" })
      expect(resolveEnrichDispatchEnvironment({ ...full, [key]: undefined })).toEqual({ ok: false, blockedBy: "missing-env" })
    }
  })
})

describe("응답", () => {
  const outcomes: readonly EnrichDispatchOutcome[] = [
    { kind: "unauthorized" },
    { kind: "conflict", reason: "missing-env" },
    { kind: "noop", reason: "disabled" },
    { kind: "sent", slot: "2026-11-10T00:00:00.000Z", mode: "live", runId: 123 },
    { kind: "rejected", slot: "2026-11-10T00:00:00.000Z", httpStatus: 403 },
    { kind: "unknown", slot: "2026-11-10T00:00:00.000Z" },
    { kind: "failed" },
  ]

  it("결과마다 상태 코드가 정해져 있다", () => {
    expect(outcomes.map(httpStatusForOutcome)).toEqual([401, 409, 200, 202, 502, 502, 500])
  })

  it("본문에는 허용한 필드만 있다", () => {
    const allowed = new Set(["result", "reason", "slot", "mode", "runId", "httpStatus"])
    for (const outcome of outcomes) {
      for (const key of Object.keys(safeResponseBody(outcome))) expect(allowed.has(key)).toBe(true)
    }
    expect(safeResponseBody({ kind: "unauthorized" })).toEqual({ result: "unauthorized" })
  })
})
