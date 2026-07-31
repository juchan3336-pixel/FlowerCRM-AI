// 승인 Batch pump endpoint 계약 — 환경 게이트·인증·접수 즉시 202·item 1건·자기 호출 0회.
//
// 이전 self-chain 구조는 item 1건당 self-fetch 1회였고, 승인 상한인 5곳을 승인하면 5번째 발사가
// Vercel의 508 INFINITE_LOOP_DETECTED에 걸렸다. 게다가 발사한 쪽이 응답 상태를 보지 않아
// 508을 성공으로 삼키고 승인이 running으로 영구 정지했다.
// 이 파일의 핵심은 "pump가 다음 pump를 부르지 않는다"와 "Production에서는 절대 돌지 않는다"를 고정하는 것이다.
import { readFileSync, readdirSync } from "node:fs"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ALLOWED_EXEC_BASE_URL } from "@/lib/batch/approval-execution-policy"

vi.mock("server-only", () => ({}))

const claimBatchPumpLease = vi.fn<(input: unknown) => Promise<unknown>>()
const runLeasedApprovalStep = vi.fn<(input: unknown) => Promise<unknown>>()
vi.mock("@/lib/batch/approval-execution-service", () => ({
  claimBatchPumpLease: (input: unknown) => claimBatchPumpLease(input),
  runLeasedApprovalStep: (input: unknown) => runLeasedApprovalStep(input),
}))

// after()가 예약한 콜백을 모아 두고 원하는 시점에 실행한다 (응답 시점과 생성 시점을 분리 검증).
const afterCallbacks: (() => unknown)[] = []
vi.mock("next/server", () => ({ after: (cb: () => unknown) => afterCallbacks.push(cb) }))

const APPROVAL_ID = "95768f94-48d3-4074-9571-37fbf2de0903"
const LEASE_HASH = "b".repeat(64)
const CHAIN_SECRET = "chain-secret-0123456789abcdef0123456789"
const BYPASS = "bypass-secret-value"
const PUMP_SECRET = "pump-secret-value"

const ENV_KEYS = [
  "VERCEL_ENV",
  "AI_PROVIDER",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "BATCH_CHAIN_SECRET",
  "PREVIEW_EXEC_BASE_URL",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
  "BATCH_PUMP_SECRET",
]

function setValidEnv(): void {
  process.env["VERCEL_ENV"] = "preview"
  process.env["AI_PROVIDER"] = "openai"
  process.env["OPENAI_API_KEY"] = "sk-test"
  process.env["OPENAI_MODEL"] = "gpt-4.1-mini"
  process.env["BATCH_CHAIN_SECRET"] = CHAIN_SECRET
  process.env["PREVIEW_EXEC_BASE_URL"] = ALLOWED_EXEC_BASE_URL
  process.env["VERCEL_AUTOMATION_BYPASS_SECRET"] = BYPASS
  process.env["BATCH_PUMP_SECRET"] = PUMP_SECRET
}

function req(headers: Record<string, string> = { "x-vercel-protection-bypass": BYPASS, "x-batch-pump-secret": PUMP_SECRET }): Request {
  return new Request(`${ALLOWED_EXEC_BASE_URL}/api/batch/pump`, { method: "POST", headers })
}

async function callPost(request: Request): Promise<{ status: number; body: Record<string, unknown> }> {
  const { POST } = await import("@/app/api/batch/pump/route")
  const res = await POST(request)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

function claimed(): void {
  claimBatchPumpLease.mockResolvedValue({ kind: "claimed", approval: { id: APPROVAL_ID }, leaseTokenHash: LEASE_HASH })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  claimBatchPumpLease.mockReset()
  runLeasedApprovalStep.mockReset()
  afterCallbacks.length = 0
  setValidEnv()
  // 자기 호출이 0회임을 증명하려면 fetch 자체를 감시해야 한다.
  fetchMock = vi.fn(() => Promise.resolve(new Response("", { status: 200 })))
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const key of ENV_KEYS) {
    Reflect.deleteProperty(process.env, key)
  }
})

describe("환경 게이트", () => {
  it("Production 배포는 하드 거부하고 claim조차 하지 않는다", async () => {
    process.env["VERCEL_ENV"] = "production"
    const res = await callPost(req())
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ ok: false, reason: "production-blocked" })
    expect(claimBatchPumpLease).not.toHaveBeenCalled()
  })

  it("fake provider는 거부한다", async () => {
    process.env["AI_PROVIDER"] = "fake"
    const res = await callPost(req())
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ reason: "provider-not-openai" })
    expect(claimBatchPumpLease).not.toHaveBeenCalled()
  })

  it("고정 Preview 별칭이 아닌 base URL은 거부한다", async () => {
    process.env["PREVIEW_EXEC_BASE_URL"] = "https://evil.vercel.app"
    const res = await callPost(req())
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ reason: "base-url-missing" })
  })

  it("pump 시크릿이 설정되지 않았으면 409다", async () => {
    Reflect.deleteProperty(process.env, "BATCH_PUMP_SECRET")
    const res = await callPost(req())
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ reason: "pump-secret-missing" })
    expect(claimBatchPumpLease).not.toHaveBeenCalled()
  })
})

describe("인증", () => {
  it("bypass 헤더가 없으면 401이고 claim하지 않는다", async () => {
    const res = await callPost(req({ "x-batch-pump-secret": PUMP_SECRET }))
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ reason: "bypass" })
    expect(claimBatchPumpLease).not.toHaveBeenCalled()
  })

  it("pump 시크릿이 없으면 401이고 claim하지 않는다", async () => {
    const res = await callPost(req({ "x-vercel-protection-bypass": BYPASS }))
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ reason: "pump-secret" })
    expect(claimBatchPumpLease).not.toHaveBeenCalled()
  })

  it("pump 시크릿이 틀리면 401이다", async () => {
    const res = await callPost(req({ "x-vercel-protection-bypass": BYPASS, "x-batch-pump-secret": "wrong" }))
    expect(res.status).toBe(401)
    expect(claimBatchPumpLease).not.toHaveBeenCalled()
  })

  it("Authorization Bearer로도 통과한다", async () => {
    claimed()
    runLeasedApprovalStep.mockResolvedValue({ kind: "processed", done: false, approvalStatus: "running" })
    const res = await callPost(req({ "x-vercel-protection-bypass": BYPASS, authorization: `Bearer ${PUMP_SECRET}` }))
    expect(res.status).toBe(202)
  })

  it("응답 본문에 시크릿·해시·승인 id가 담기지 않는다", async () => {
    claimed()
    runLeasedApprovalStep.mockResolvedValue({ kind: "processed", done: false, approvalStatus: "running" })
    const res = await callPost(req())
    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain(PUMP_SECRET)
    expect(serialized).not.toContain(BYPASS)
    expect(serialized).not.toContain(LEASE_HASH)
    expect(serialized).not.toContain(APPROVAL_ID)
  })
})

describe("접수와 생성 분리", () => {
  it("실행 중 승인이 없으면 200 noop이고 생성을 예약하지 않는다", async () => {
    claimBatchPumpLease.mockResolvedValue({ kind: "idle" })

    const res = await callPost(req())

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, noop: true, reason: "idle" })
    expect(afterCallbacks).toHaveLength(0)
    expect(runLeasedApprovalStep).not.toHaveBeenCalled()
  })

  it("생성이 끝나지 않았는데도 202로 먼저 응답한다", async () => {
    claimed()
    let release: (() => void) | undefined
    runLeasedApprovalStep.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve({ kind: "processed", done: false, approvalStatus: "running" })
          }
        }),
    )

    const res = await callPost(req())

    expect(res.status).toBe(202)
    expect(res.body).toMatchObject({ ok: true, accepted: true })
    expect(runLeasedApprovalStep).not.toHaveBeenCalled()
    expect(afterCallbacks).toHaveLength(1)

    const pending = afterCallbacks[0]?.()
    expect(runLeasedApprovalStep).toHaveBeenCalledTimes(1)
    release?.()
    await pending
  })

  it("after() 1회 실행에 생성도 정확히 1회만 돈다", async () => {
    claimed()
    runLeasedApprovalStep.mockResolvedValue({ kind: "processed", done: false, approvalStatus: "running" })

    await callPost(req())
    await afterCallbacks[0]?.()

    expect(claimBatchPumpLease).toHaveBeenCalledTimes(1)
    expect(runLeasedApprovalStep).toHaveBeenCalledTimes(1)
    const passed = runLeasedApprovalStep.mock.calls[0]?.[0] as { approval: { id: string }; leaseTokenHash: string }
    expect(passed.approval.id).toBe(APPROVAL_ID)
    expect(passed.leaseTokenHash).toBe(LEASE_HASH)
  })

  it("claim이 터지면 500이고 생성을 예약하지 않는다", async () => {
    claimBatchPumpLease.mockRejectedValue(new Error("db down"))
    const res = await callPost(req())
    expect(res.status).toBe(500)
    expect(res.body).toMatchObject({ ok: false, errorCode: "internal" })
    expect(afterCallbacks).toHaveLength(0)
  })

  it("생성이 터져도 after() 콜백은 던지지 않는다", async () => {
    claimed()
    runLeasedApprovalStep.mockRejectedValue(new Error("boom"))

    await callPost(req())
    await expect(afterCallbacks[0]?.()).resolves.toBeUndefined()
  })
})

// 이 구조의 존재 이유 — 재귀 호출이 0이어야 508이 다시 발생하지 않는다.
describe("자기 호출 없음", () => {
  for (const [name, outcome] of [
    ["잔여가 남아 있어도", { kind: "processed", done: false, approvalStatus: "running" }],
    ["완료된 뒤에도", { kind: "completed", approvalStatus: "completed" }],
    ["생성이 실패해도", { kind: "conflict", reason: "run-failed" }],
  ] as const) {
    it(`${name} 다음 실행을 스스로 발사하지 않는다`, async () => {
      claimed()
      runLeasedApprovalStep.mockResolvedValue(outcome)

      await callPost(req())
      await afterCallbacks[0]?.()

      expect(fetchMock).not.toHaveBeenCalled()
      expect(afterCallbacks).toHaveLength(1)
    })
  }
})

// ── 구조 보증: Batch 자동 실행 경로에 자기 호출이 없다 ──────────
// Vercel은 같은 함수의 HTTP 재귀 호출을 4회 초과에서 508로 차단한다. 재시도·timeout으로는 우회할 수
// 없으므로 "코드에 self-fetch가 아예 없다"를 소스 스캔으로 고정한다.
describe("Batch 자동 실행 경로에 self-fetch 없음", () => {
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")))
      .map((entry) => `${entry.parentPath}/${entry.name}`)

  const FETCH_CALL = new RegExp(String.raw`\bfetch\s*\(`, "u")

  it("app/api/batch 어디에도 fetch 호출이 없다", () => {
    const files = sourceFiles("app/api/batch")
    expect(files.length).toBeGreaterThan(1)
    expect(files.filter((file) => FETCH_CALL.test(readFileSync(file, "utf8")))).toEqual([])
  })

  it("lib/batch에도 직접 fetch 호출이 없다", () => {
    const files = sourceFiles("lib/batch")
    expect(files.length).toBeGreaterThan(3)
    expect(files.filter((file) => FETCH_CALL.test(readFileSync(file, "utf8")))).toEqual([])
  })

  it("Production→Preview activate 발사는 그대로 남아 있다", () => {
    // 유일하게 허용되는 바깥 방향 호출 — 재귀가 아니라 교차 배포다 (Production에서 Preview로).
    const kick = readFileSync("lib/batch/approval-kick.ts", "utf8")
    expect(kick).toContain("/api/batch/execute")
    expect(kick).toContain("mode: \"activate\"")
  })

  it("self-chain 발사 코드가 저장소에 남아 있지 않다", () => {
    const files = [...sourceFiles("app/api/batch"), ...sourceFiles("lib/batch")]
    const sources = files.map((file) => readFileSync(file, "utf8")).join(String.fromCharCode(10))
    expect(sources).not.toContain("scheduleNextTick")
    expect(sources).not.toContain("SELF_CHAIN_TIMEOUT_MS")
    // tick 모드 실행 경로 자체가 사라졌다.
    expect(sources).not.toContain("executeTick")
  })
})
