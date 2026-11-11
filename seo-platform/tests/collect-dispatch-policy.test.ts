// Collect 외부 예약 dispatch — 순수 정책 계약.
import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"

import { signDispatchRequest as signEnrichRequest, slotForTime as enrichSlotForTime } from "@/lib/enrich-dispatch/policy"
import {
  COLLECT_DISPATCH_PATH,
  COLLECT_SLOT_MS,
  COLLECT_SLOT_OFFSET_MS,
  httpStatusForOutcome,
  resolveCollectDispatchEnvironment,
  safeResponseBody,
  signDispatchRequest,
  signaturePayload,
  slotForSignedTimestamp,
  slotForTime,
  verifyDispatchSignature,
  workflowInputs,
  type CollectDispatchOutcome,
} from "@/lib/collect-dispatch/policy"

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
const NOW_MS = 1_794_300_000_000
const TS = String(NOW_MS / 1000)
const sign = (timestamp = TS, body = "{}", secret = SECRET) => signDispatchRequest(secret, timestamp, body)
const check = (overrides: Partial<Parameters<typeof verifyDispatchSignature>[0]> = {}) =>
  verifyDispatchSignature({ secret: SECRET, timestamp: TS, signature: sign(), rawBody: "{}", nowMs: NOW_MS, ...overrides })

describe("서명", () => {
  it("SQL(pgcrypto)이 만드는 값과 같은 고정 벡터를 만든다", () => {
    // operations/collect_dispatch_cron.sql 의 request_collect_dispatch() 가 서명하는 문자열 그대로다.
    expect(signaturePayload("1794300000", "{}")).toBe("1794300000.POST./api/collect/dispatch.{}")
    const expected = createHmac("sha256", Buffer.from(SECRET, "utf8")).update(Buffer.from("1794300000.POST./api/collect/dispatch.{}", "utf8")).digest("hex")
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
  it("UTC 00:45에서 시작하는 90분 구간의 시작 시각이다", () => {
    expect(slotForTime(Date.parse("2026-11-10T00:45:00Z"))).toBe("2026-11-10T00:45:00.000Z")
    expect(slotForTime(Date.parse("2026-11-10T02:14:59Z"))).toBe("2026-11-10T00:45:00.000Z")
    expect(slotForTime(Date.parse("2026-11-10T02:15:00Z"))).toBe("2026-11-10T02:15:00.000Z")
    expect(slotForTime(Date.parse("2026-11-10T23:15:00Z"))).toBe("2026-11-10T23:15:00.000Z")
    expect(slotForTime(Date.parse("2026-11-10T23:59:59Z"))).toBe("2026-11-10T23:15:00.000Z")
    // 자정은 전날 23:15에 시작한 구간 안이다.
    expect(slotForTime(Date.parse("2026-11-10T00:00:00Z"))).toBe("2026-11-09T23:15:00.000Z")
    expect(slotForTime(Date.parse("2026-11-10T00:44:59Z"))).toBe("2026-11-09T23:15:00.000Z")
  })

  it("Enrich의 구간 경계와 45분 어긋난다", () => {
    expect(COLLECT_SLOT_OFFSET_MS).toBe(45 * 60_000)
    const day = Date.parse("2026-11-10T00:00:00Z")
    for (let index = 0; index < 16; index += 1) {
      const collectStart = Date.parse(slotForTime(day + COLLECT_SLOT_OFFSET_MS + index * COLLECT_SLOT_MS))
      expect(collectStart - Date.parse(enrichSlotForTime(collectStart))).toBe(45 * 60_000)
    }
  })

  it("하루는 정확히 16개 slot이고, 두 cron의 발화 시각은 각각 다른 slot에 떨어진다", () => {
    const day = Date.parse("2026-11-10T00:00:00Z")
    const fires = [
      ...[0, 3, 6, 9, 12, 15, 18, 21].map((hour) => day + hour * 3_600_000 + 45 * 60_000),
      ...[2, 5, 8, 11, 14, 17, 20, 23].map((hour) => day + hour * 3_600_000 + 15 * 60_000),
    ]
    expect(new Set(fires.map(slotForTime)).size).toBe(16)
    // 발화 시각이 곧 구간의 시작이다 — 늦게 도착할 여유가 구간 전체다.
    for (const fire of fires) expect(Date.parse(slotForTime(fire))).toBe(fire)
    expect((24 * 3_600_000) / COLLECT_SLOT_MS).toBe(16)
    // pg_net 지연으로 몇 분 늦게 도착해도 같은 slot이다.
    const first = fires[0] ?? day
    expect(slotForTime(first + 4 * 60_000)).toBe(slotForTime(first))
  })
})

describe("서명된 시각의 slot", () => {
  it("epoch 초 문자열에서 slot을 만든다", () => {
    expect(slotForSignedTimestamp(String(Date.parse("2026-11-10T02:14:59Z") / 1000))).toBe("2026-11-10T00:45:00.000Z")
    expect(slotForSignedTimestamp(String(Date.parse("2026-11-10T02:15:00Z") / 1000))).toBe("2026-11-10T02:15:00.000Z")
  })
})

describe("workflow 입력", () => {
  it("live일 때만 dry_run이 false이고, 그 밖은 전부 true다", () => {
    expect(workflowInputs("live", "id-1")).toEqual({ collect_preset: "custom", limit: "300", max_queue_visits: "40", max_runtime_ms: "1200000", debug: "false", dry_run: "false", dispatch_id: "id-1" })
    expect(workflowInputs("dry_run", "id-2")).toEqual({ collect_preset: "custom", limit: "300", max_queue_visits: "40", max_runtime_ms: "1200000", debug: "false", dry_run: "true", dispatch_id: "id-2" })
    // 타입 밖의 값이 들어와도 쓰기로 열리지 않는다.
    expect(workflowInputs("LIVE" as never, "id-3")["dry_run"]).toBe("true")
    expect(workflowInputs(undefined as never, "id-4")["dry_run"]).toBe("true")
  })

  it("워크플로가 받는 입력만 보낸다 — GitHub은 모르는 입력이 있으면 요청을 거절한다", () => {
    expect(Object.keys(workflowInputs("live", "id")).sort()).toEqual(
      ["collect_preset", "debug", "dispatch_id", "dry_run", "limit", "max_queue_visits", "max_runtime_ms"],
    )
  })
})

describe("Enrich 예약과의 분리", () => {
  it("같은 키로 만든 Enrich용 서명도 Collect에서는 통과하지 못한다 — 경로가 서명에 들어간다", () => {
    expect(COLLECT_DISPATCH_PATH).toBe("/api/collect/dispatch")
    expect(signaturePayload(TS, "{}")).toBe(`${TS}.POST./api/collect/dispatch.{}`)
    const enrichSignature = signEnrichRequest(SECRET, TS, "{}")
    expect(enrichSignature).not.toBe(sign())
    expect(check({ signature: enrichSignature })).toBe(false)
  })

  it("Collect 전용 환경변수만 읽는다", () => {
    const base = { VERCEL_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service" }
    const enrichOnly = { ...base, ENRICH_DISPATCH_SIGNING_SECRET: SECRET, ENRICH_GITHUB_TOKEN: "enrich-token" }
    expect(resolveCollectDispatchEnvironment(enrichOnly)).toEqual({ ok: false, blockedBy: "missing-env" })
    expect(
      resolveCollectDispatchEnvironment({ ...enrichOnly, COLLECT_DISPATCH_SIGNING_SECRET: "c".repeat(64), COLLECT_GITHUB_TOKEN: "collect-token" }),
    ).toEqual({ ok: true, signingSecret: "c".repeat(64), githubToken: "collect-token" })
  })
})

describe("환경", () => {
  const full = {
    VERCEL_ENV: "production",
    NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    COLLECT_DISPATCH_SIGNING_SECRET: SECRET,
    COLLECT_GITHUB_TOKEN: "github-token",
  }

  it("Production에서 값이 모두 있을 때만 열린다", () => {
    expect(resolveCollectDispatchEnvironment(full)).toEqual({ ok: true, signingSecret: SECRET, githubToken: "github-token" })
  })

  it("Preview·개발 환경에서는 값이 다 있어도 닫힌다", () => {
    for (const vercelEnv of ["preview", "development", "", undefined]) {
      expect(resolveCollectDispatchEnvironment({ ...full, VERCEL_ENV: vercelEnv })).toEqual({ ok: false, blockedBy: "not-production" })
    }
  })

  it("하나라도 없거나 비어 있으면 닫힌다", () => {
    for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "COLLECT_DISPATCH_SIGNING_SECRET", "COLLECT_GITHUB_TOKEN"]) {
      expect(resolveCollectDispatchEnvironment({ ...full, [key]: "" })).toEqual({ ok: false, blockedBy: "missing-env" })
      expect(resolveCollectDispatchEnvironment({ ...full, [key]: undefined })).toEqual({ ok: false, blockedBy: "missing-env" })
    }
  })
})

describe("응답", () => {
  const outcomes: readonly CollectDispatchOutcome[] = [
    { kind: "unauthorized" },
    { kind: "conflict", reason: "missing-env" },
    { kind: "noop", reason: "disabled" },
    { kind: "sent", slot: "2026-11-10T00:45:00.000Z", mode: "live", runId: 123 },
    { kind: "rejected", slot: "2026-11-10T00:45:00.000Z", httpStatus: 403 },
    { kind: "unknown", slot: "2026-11-10T00:45:00.000Z" },
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
