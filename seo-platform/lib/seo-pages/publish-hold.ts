import "server-only"

// 게시와 콘텐츠 보정의 상호 배제 — settings 테이블의 두 행으로 만든다 (DDL 없음, key가 PK).
//
// ready 보정은 places·seo_pages·ai_generations 세 곳을 차례로 쓴다. 그 사이에 게시가 끼면
// 제목과 본문이 서로 다른 중간 상태가 공개된다. "보류 표식을 한 번 읽고 진행"으로는 막을 수 없다 —
// 읽은 뒤 RPC까지의 지연에는 상한이 없기 때문이다. 그래서 게시도 같은 소유권을 실제로 쥔다.
//
//  publish_lock   실행 소유권(lease). 게시 한 건과 보정 작업 하나가 서로 배타적으로 쥔다.
//                 INSERT가 획득이고, 끝나면 지운다. 죽은 소유자를 위해 만료(until)가 있다.
//  publish_freeze 게시 금지 상태. 보정 작업이 시작하며 세우고, 전부 성공했을 때만 내린다.
//                 만료가 없다 — 보정이 중단·사망해 콘텐츠가 중간 상태로 남았을 때, 시간이 지났다는
//                 이유로 게시가 다시 열리면 안 된다. 사람이 상태를 확인하고 명시적으로 내린다.
//
// 순서 규칙 (이 순서가 상호 배제를 만든다):
//   게시   = lock 획득 → freeze 확인 → RPC → lock 해제
//   보정   = freeze 세움 → lock 획득 → 쓰기들 → (성공 시) freeze 내림 → lock 해제
// 게시가 lock을 먼저 쥐면 보정은 lock을 얻지 못해 물러난다. 보정이 freeze를 먼저 세우면, 그 뒤에 lock을
// 얻은 게시는 freeze를 보고 물러난다. 어느 쪽이든 둘이 동시에 쓰기 구간에 있지 않다.
//
// 읽기 실패·값 깨짐은 전부 "게시하지 않는다" 쪽이다. 행이 존재하면(JSON null이어도) 걸려 있는 것이다.
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { Json } from "@/types/database"

export const PUBLISH_LOCK_SETTING_KEY = "publish_lock"
export const PUBLISH_FREEZE_SETTING_KEY = "publish_freeze"
const UNIQUE_VIOLATION = "23505"

export type PublishLock = { readonly by: string; readonly until: string }

// 행의 value를 해석한다. 해석되지 않으면 "invalid" — 호출자는 살아 있는 lock으로 취급한다.
export function parsePublishLock(value: unknown): PublishLock | "invalid" {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "invalid"
  }
  const { by, until } = value as Record<string, unknown>
  if (typeof by !== "string" || by.length === 0 || typeof until !== "string" || Number.isNaN(Date.parse(until))) {
    return "invalid"
  }
  return { by, until }
}

// lock 획득 — 성공해야만 쓰기 구간에 들어간다. 살아 있는 lock이 있으면 false.
// 만료된 lock은 (그 lock의 until이 그대로일 때만) 치우고 다시 잡는다. 값이 깨진 행은 치우지 않는다.
export async function acquirePublishLock(input: Readonly<{ by: string; ttlMs: number; nowIso: string }>): Promise<boolean> {
  const client = createSupabaseServiceRoleClient()
  const existing = await client.from("settings").select("value").eq("key", PUBLISH_LOCK_SETTING_KEY).maybeSingle()
  if (existing.error !== null) {
    throw new Error(`Failed to read publish lock: ${existing.error.message}`)
  }
  if (existing.data !== null) {
    const lock = parsePublishLock(existing.data.value)
    if (lock === "invalid" || Date.parse(input.nowIso) < Date.parse(lock.until)) {
      return false
    }
    const cleared = await client.from("settings").delete().eq("key", PUBLISH_LOCK_SETTING_KEY).eq("value->>until", lock.until).select("key")
    if (cleared.error !== null || cleared.data.length !== 1) {
      return false
    }
  }
  const until = new Date(Date.parse(input.nowIso) + input.ttlMs).toISOString()
  const inserted = await client.from("settings").insert({ key: PUBLISH_LOCK_SETTING_KEY, value: { by: input.by, until } as Json })
  if (inserted.error !== null) {
    if (inserted.error.code === UNIQUE_VIOLATION) {
      return false
    }
    throw new Error(`Failed to acquire publish lock: ${inserted.error.message}`)
  }
  return true
}

// 자기가 쥔 lock만 놓는다.
export async function releasePublishLock(by: string): Promise<void> {
  const client = createSupabaseServiceRoleClient()
  const { error } = await client.from("settings").delete().eq("key", PUBLISH_LOCK_SETTING_KEY).eq("value->>by", by)
  if (error !== null) {
    throw new Error(`Failed to release publish lock: ${error.message}`)
  }
}

// 게시 금지 상태인가 — 행이 존재하면 값과 무관하게 금지다. 읽지 못해도 금지다.
export async function isPublishFrozen(): Promise<boolean> {
  try {
    const client = createSupabaseServiceRoleClient()
    const { data, error } = await client.from("settings").select("key").eq("key", PUBLISH_FREEZE_SETTING_KEY)
    return error !== null || data.length > 0
  } catch {
    return true
  }
}

export type FreezeOutcome = "set" | "inherited" | "held-by-other"

// 게시 금지를 세운다. 이미 서 있으면:
//  - inheritFrom이 지금 소유자와 같을 때만 넘겨받는다 (중단된 작업의 잔여를 새 작업이 이어받는 경우)
//  - 그 외에는 건드리지 않고 held-by-other
export async function setPublishFreeze(input: Readonly<{ by: string; reason: string; nowIso: string; inheritFrom?: string | null }>): Promise<FreezeOutcome> {
  const client = createSupabaseServiceRoleClient()
  const value = { by: input.by, reason: input.reason.slice(0, 200), at: input.nowIso } as Json
  const inserted = await client.from("settings").insert({ key: PUBLISH_FREEZE_SETTING_KEY, value })
  if (inserted.error === null) {
    return "set"
  }
  if (inserted.error.code !== UNIQUE_VIOLATION) {
    throw new Error(`Failed to set publish freeze: ${inserted.error.message}`)
  }
  if (input.inheritFrom === undefined || input.inheritFrom === null) {
    return "held-by-other"
  }
  const taken = await client.from("settings").update({ value }).eq("key", PUBLISH_FREEZE_SETTING_KEY).eq("value->>by", input.inheritFrom).select("key")
  if (taken.error !== null) {
    throw new Error(`Failed to inherit publish freeze: ${taken.error.message}`)
  }
  return taken.data.length === 1 ? "inherited" : "held-by-other"
}

// 자기가 세운(또는 넘겨받은) 금지만 내린다.
export async function clearPublishFreeze(by: string): Promise<boolean> {
  const client = createSupabaseServiceRoleClient()
  const { data, error } = await client.from("settings").delete().eq("key", PUBLISH_FREEZE_SETTING_KEY).eq("value->>by", by).select("key")
  if (error !== null) {
    throw new Error(`Failed to clear publish freeze: ${error.message}`)
  }
  return data.length === 1
}
