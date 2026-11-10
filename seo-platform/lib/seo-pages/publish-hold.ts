import "server-only"

// 게시 보류(publish hold) — 게시 준비 콘텐츠를 고치는 동안 게시가 끼어들지 못하게 하는 전역 표식.
//
// ready 보정은 places·seo_pages·ai_generations 세 곳을 차례로 쓴다. 그 사이에 게시가 끼면
// 제목과 본문이 서로 다른 중간 상태가 공개되거나, 공개본과 생성 기록이 갈라진다.
// 게시 코어(runPlacePublish — 단건·배치·자동 게시 공용)가 진입 시 이 표식을 보고 물러난다.
//
// settings 테이블의 한 행(publish_hold)이다 — key가 PK라 동시에 둘이 잡을 수 없다 (INSERT가 획득).
// 만료 시각(until)이 지나면 무효다: 보정 작업이 죽어 해제하지 못해도 게시가 영원히 막히지 않게.
// 읽기에 실패하거나 값이 깨져 있으면 "보류 중"으로 본다 — 모르면 게시하지 않는 쪽이 안전하다.
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { Json } from "@/types/database"

export const PUBLISH_HOLD_SETTING_KEY = "publish_hold"
const UNIQUE_VIOLATION = "23505"

export type PublishHold = { readonly by: string; readonly until: string }

// 행이 없으면 null(보류 없음). 행은 있는데 해석되지 않으면 "invalid" — 호출자는 보류 중으로 취급한다.
export function parsePublishHold(value: unknown): PublishHold | "invalid" | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return "invalid"
  }
  const { by, until } = value as Record<string, unknown>
  if (typeof by !== "string" || by.length === 0 || typeof until !== "string" || Number.isNaN(Date.parse(until))) {
    return "invalid"
  }
  return { by, until }
}

export function isPublishHoldActive(value: unknown, nowIso: string): boolean {
  const hold = parsePublishHold(value)
  if (hold === null) {
    return false
  }
  return hold === "invalid" || Date.parse(nowIso) < Date.parse(hold.until)
}

export async function isPublishHeld(nowIso: string = new Date().toISOString()): Promise<boolean> {
  try {
    const client = createSupabaseServiceRoleClient()
    const { data, error } = await client.from("settings").select("value").eq("key", PUBLISH_HOLD_SETTING_KEY).maybeSingle()
    if (error !== null) {
      return true
    }
    return isPublishHoldActive(data?.value, nowIso)
  } catch {
    return true
  }
}

// 보류 획득 — 만료된 옛 표식은 (그 표식의 until이 그대로일 때만) 지우고 다시 잡는다.
// 살아 있는 표식이 있으면 false. 획득에 성공해야만 호출자가 보정을 시작한다.
export async function acquirePublishHold(input: Readonly<{ by: string; until: string; nowIso: string }>): Promise<boolean> {
  const client = createSupabaseServiceRoleClient()
  const existing = await client.from("settings").select("value").eq("key", PUBLISH_HOLD_SETTING_KEY).maybeSingle()
  if (existing.error !== null) {
    throw new Error(`Failed to read publish hold: ${existing.error.message}`)
  }
  if (existing.data !== null) {
    const hold = parsePublishHold(existing.data.value)
    if (hold === "invalid" || hold === null || Date.parse(input.nowIso) < Date.parse(hold.until)) {
      return false
    }
    const cleared = await client.from("settings").delete().eq("key", PUBLISH_HOLD_SETTING_KEY).eq("value->>until", hold.until).select("key")
    if (cleared.error !== null || cleared.data.length !== 1) {
      return false
    }
  }
  const inserted = await client.from("settings").insert({ key: PUBLISH_HOLD_SETTING_KEY, value: { by: input.by, until: input.until } as Json })
  if (inserted.error !== null) {
    if (inserted.error.code === UNIQUE_VIOLATION) {
      return false
    }
    throw new Error(`Failed to acquire publish hold: ${inserted.error.message}`)
  }
  return true
}

// 자기가 잡은 표식만 지운다.
export async function releasePublishHold(by: string): Promise<void> {
  const client = createSupabaseServiceRoleClient()
  const { error } = await client.from("settings").delete().eq("key", PUBLISH_HOLD_SETTING_KEY).eq("value->>by", by)
  if (error !== null) {
    throw new Error(`Failed to release publish hold: ${error.message}`)
  }
}
