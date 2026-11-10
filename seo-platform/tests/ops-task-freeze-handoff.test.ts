// 중단된 작업의 게시 금지를 새 작업이 넘겨받는 복구 흐름 — 실제 publish-hold 구현과 ops 서비스를 함께 돌린다.
// (ops-task-and-ready-correction.test.ts는 publish-hold를 대역으로 바꿔, 두 번째 호출의 소유자 불일치를 보지 못한다.)
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

type Row = Record<string, unknown>
const tables: Record<string, Row[]> = {}

function builder(table: string) {
  const filters: { column: string; value: unknown; op: "eq" | "in" }[] = []
  let mode: "select" | "delete" | "update" = "select"
  let patch: Row = {}
  let head = false
  const matched = (): Row[] =>
    (tables[table] ?? []).filter((row) =>
      filters.every((filter) => {
        if (filter.op === "in") {
          return Array.isArray(filter.value) && filter.value.includes(row[filter.column])
        }
        const field = /^value->>(.+)$/.exec(filter.column)?.[1]
        if (field !== undefined) {
          return typeof row["value"] === "object" && row["value"] !== null && (row["value"] as Row)[field] === filter.value
        }
        return row[filter.column] === filter.value
      }),
    )
  const run = (): { data: Row[] | null; error: null; count?: number } => {
    const targets = matched()
    if (mode === "delete") {
      tables[table] = (tables[table] ?? []).filter((row) => !targets.includes(row))
    }
    if (mode === "update") {
      for (const row of targets) {
        Object.assign(row, patch)
      }
    }
    return head ? { data: null, error: null, count: targets.length } : { data: targets.map((row) => structuredClone(row)), error: null }
  }
  const api = {
    select: (_columns?: string, options?: { head?: boolean }) => {
      head = options?.head === true
      return api
    },
    delete: () => {
      mode = "delete"
      return api
    },
    update: (next: Row) => {
      mode = "update"
      patch = next
      return api
    },
    eq: (column: string, value: unknown) => {
      filters.push({ column, value, op: "eq" })
      return api
    },
    in: (column: string, value: unknown) => {
      filters.push({ column, value, op: "in" })
      return api
    },
    insert: (row: Row) => {
      if ((tables[table] ?? []).some((existing) => existing["key"] === row["key"])) {
        return Promise.resolve({ error: { message: "duplicate key", code: "23505" } })
      }
      ;(tables[table] ??= []).push(structuredClone(row))
      return Promise.resolve({ error: null })
    },
    maybeSingle: () => {
      const result = run()
      return Promise.resolve({ data: result.data?.[0] ?? null, error: null })
    },
    then: (onFulfilled: (value: ReturnType<typeof run>) => unknown, onRejected?: (reason: unknown) => unknown) => Promise.resolve(run()).then(onFulfilled, onRejected),
  }
  return api
}
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceRoleClient: () => ({ from: (table: string) => builder(table) }) }))

const resolveNeedsReviewItem = vi.fn<(input: unknown) => Promise<unknown>>()
vi.mock("@/lib/batch/needs-review-service", () => ({ resolveNeedsReviewItem: (input: unknown) => resolveNeedsReviewItem(input) }))

const ITEM = "22222222-0000-4000-8000-000000000016"
const GEN = "11111111-0000-4000-8000-000000000016"
const recoveryTask = {
  id: "recovery-b",
  expiresAt: "2026-11-11T00:00:00.000Z",
  actor: "ops:pilot-review",
  inheritFreezeFrom: "pilot-a",
  steps: [{ kind: "resolve-needs-review", itemId: ITEM, generationId: GEN }],
}
const setting = (key: string): Row | undefined => tables["settings"]?.find((row) => row["key"] === key)
const freezeOwner = (): unknown => (setting("publish_freeze")?.["value"] as Row | undefined)?.["by"]

async function runAt(nowIso: string) {
  const { runOpsTask } = await import("@/lib/batch/ops-task-service")
  return runOpsTask({ nowIso })
}

beforeEach(() => {
  tables["batch_approvals"] = []
  tables["batch_runs"] = []
  tables["settings"] = []
  resolveNeedsReviewItem.mockReset()
  resolveNeedsReviewItem.mockResolvedValue({ kind: "resolved", path: "/places/x", changedFields: [], itemStatus: "warn_ready" })
})

describe("중단된 작업의 게시 금지를 넘겨받는 복구", () => {
  // 작업 A가 함수 사망으로 3분짜리 lock과 만료 없는 freeze를 남긴 상태.
  function leaveDeadTaskA(): void {
    tables["settings"] = [
      { key: "ops_task", value: recoveryTask },
      { key: "publish_freeze", value: { by: "ops-task:pilot-a", reason: "ops task pilot-a", at: "2026-11-10T07:00:00.000Z" } },
      { key: "publish_lock", value: { by: "ops-task:pilot-a", until: "2026-11-10T07:03:00.000Z" } },
      { key: "ops_task_result:pilot-a", value: { status: "running", results: [] } },
    ]
  }

  it("A의 lock이 살아 있는 동안에는 물러나고, lock이 사라진 다음 주기에 같은 설정으로 실행을 끝낸다", async () => {
    leaveDeadTaskA()

    // 1) 첫 시도 — freeze는 넘겨받지만 A의 lock이 아직 유효해 실행하지 못한다. 넘겨받은 freeze는 내리지 않는다.
    expect(await runAt("2026-11-10T07:01:00.000Z")).toEqual({ kind: "blocked", reason: "publish-lock-busy" })
    expect(freezeOwner()).toBe("ops-task:recovery-b")
    expect(setting("ops_task_result:recovery-b")).toBeUndefined()
    expect(resolveNeedsReviewItem).not.toHaveBeenCalled()

    // 2) 다음 주기, 같은 설정(inheritFreezeFrom은 여전히 pilot-a) — 이제 freeze의 소유자는 B 자신이다.
    //    자기 소유를 알아보지 못하면 여기서 publish-frozen으로 영원히 막힌다.
    expect(await runAt("2026-11-10T07:02:00.000Z")).toEqual({ kind: "blocked", reason: "publish-lock-busy" })
    expect(freezeOwner()).toBe("ops-task:recovery-b")

    // 3) A의 lock이 만료된 뒤 — claim하고, 남은 step을 실행하고, 끝나면 freeze를 내리고 lock을 놓는다.
    const outcome = await runAt("2026-11-10T07:04:00.000Z")
    expect(outcome).toMatchObject({ kind: "finished", taskId: "recovery-b", status: "done", results: [{ ok: true, outcome: "warn_ready" }] })
    expect(resolveNeedsReviewItem).toHaveBeenCalledTimes(1)
    expect(setting("ops_task_result:recovery-b")?.["value"]).toMatchObject({ status: "done" })
    expect(setting("publish_freeze")).toBeUndefined()
    expect(setting("publish_lock")).toBeUndefined()
    // A의 결과 기록은 지우지 않는다.
    expect(setting("ops_task_result:pilot-a")).toBeDefined()
  })

  it("넘겨받도록 지정하지 않은 새 작업은 A의 freeze 앞에서 계속 막힌다", async () => {
    leaveDeadTaskA()
    const row = setting("ops_task")
    if (row !== undefined) {
      row["value"] = { ...recoveryTask, inheritFreezeFrom: null }
    }

    expect(await runAt("2026-11-10T07:04:00.000Z")).toEqual({ kind: "blocked", reason: "publish-frozen" })
    expect(freezeOwner()).toBe("ops-task:pilot-a")
    expect(resolveNeedsReviewItem).not.toHaveBeenCalled()
  })

  it("복구 작업이 다시 중단되면 freeze는 복구 작업 소유로 남는다", async () => {
    leaveDeadTaskA()
    resolveNeedsReviewItem.mockResolvedValue({ kind: "quality-not-pass", status: "fail" })

    expect(await runAt("2026-11-10T07:04:00.000Z")).toMatchObject({ kind: "finished", status: "stopped" })
    expect(freezeOwner()).toBe("ops-task:recovery-b")
    expect(setting("publish_lock")).toBeUndefined()
  })

  it("새 작업이 처음 세운 freeze는, 게시가 진행 중이라 물러날 때 내린다 (게시를 불필요하게 막지 않는다)", async () => {
    tables["settings"] = [
      { key: "ops_task", value: { ...recoveryTask, id: "fresh-c", inheritFreezeFrom: null } },
      { key: "publish_lock", value: { by: "publish:place-1:x", until: "2026-11-10T07:03:00.000Z" } },
    ]

    expect(await runAt("2026-11-10T07:01:00.000Z")).toEqual({ kind: "blocked", reason: "publish-lock-busy" })
    expect(setting("publish_freeze")).toBeUndefined()
    // 게시가 끝난 뒤 다음 주기에 실행된다.
    tables["settings"] = (tables["settings"] ?? []).filter((entry) => entry["key"] !== "publish_lock")
    expect(await runAt("2026-11-10T07:02:00.000Z")).toMatchObject({ kind: "finished", status: "done" })
  })
})
