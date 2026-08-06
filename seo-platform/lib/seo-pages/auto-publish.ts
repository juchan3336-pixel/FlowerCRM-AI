import "server-only"

// 자동 게시 pump 코어 — Production Cron이 1분 주기로 호출해 게시 준비(ready)·적격 장소를
// 한 번에 1곳씩 자동 게시한다 (2026-08-06 지시: 생성 클릭 후 사람 개입 없이 게시까지).
//
// 안전장치는 수동 게시와 완전히 같다: 후보 판정(decidePublishCandidate — verified·draft·적용 generation)과
// 게시 직전 어휘 재검사·RPC guard(runPlacePublish)를 그대로 지난다. needs_review·failed는 적용 자체가
// 없어 ready가 되지 못하므로 여기 오지 않는다 — "문제 없으면 게시"의 판정은 기존 품질 계층이 한다.
// 스위치는 settings 테이블 auto_publish 행("on"일 때만 동작) — 기본은 꺼짐.
import { runPlacePublish } from "./publish-runner"
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"

export type AutoPublishTickOutcome =
  | { readonly kind: "disabled" }
  | { readonly kind: "idle" }
  | { readonly kind: "published"; readonly placeId: string; readonly name: string; readonly path: string | null }
  | { readonly kind: "blocked"; readonly placeId: string; readonly name: string; readonly reason: string }
  | { readonly kind: "failed"; readonly errorCode: "internal" }

// settings.auto_publish 값 해석 — "on"만 켜짐으로 본다 (그 외 값·행 없음 = 꺼짐).
export function parseAutoPublishSetting(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "on"
}

export function httpStatusForAutoPublishOutcome(outcome: AutoPublishTickOutcome): number {
  switch (outcome.kind) {
    case "published":
    case "idle":
    case "disabled":
    case "blocked":
      return 200
    case "failed":
      return 500
  }
}

// 응답 본문 — 시크릿·내부 오류 원문을 노출하지 않는다.
export function safeAutoPublishResponseBody(outcome: AutoPublishTickOutcome): Record<string, unknown> {
  switch (outcome.kind) {
    case "published":
      return { kind: outcome.kind, placeId: outcome.placeId, name: outcome.name, path: outcome.path }
    case "blocked":
      return { kind: outcome.kind, placeId: outcome.placeId, name: outcome.name, reason: outcome.reason }
    default:
      return { kind: outcome.kind }
  }
}

export async function isAutoPublishEnabled(): Promise<boolean> {
  const client = createSupabaseServiceRoleClient()
  const { data } = await client.from("settings").select("value").eq("key", "auto_publish").maybeSingle()
  return parseAutoPublishSetting(data?.value)
}

// 한 tick = 적격 후보 1곳 게시. 후보가 없으면 idle — 다음 후보는 다음 Cron 호출이 처리한다.
// (sync pump와 같은 구조: 이 함수는 자기 자신도, 다른 배포도 호출하지 않는다.)
export async function runAutoPublishTick(dependencies: Readonly<{ registerAfter: (callback: () => Promise<void>) => void }>): Promise<AutoPublishTickOutcome> {
  try {
    if (!(await isAutoPublishEnabled())) {
      return { kind: "disabled" }
    }
    const { listBatchPublishCandidates } = await import("@/lib/batch/publish-batch-service")
    const candidates = await listBatchPublishCandidates()
    const next = candidates.find((candidate) => candidate.decision.eligible)
    if (next === undefined) {
      return { kind: "idle" }
    }
    const result = await runPlacePublish(next.placeId, { registerAfter: dependencies.registerAfter })
    if (result.kind === "published" || result.kind === "already-published") {
      return { kind: "published", placeId: next.placeId, name: next.name, path: result.path }
    }
    // 차단(어휘·카테고리·RPC guard)은 그 장소만 남기고 멈춘다 — 다음 tick도 같은 장소에서 다시 차단되므로
    // 운영자가 처리(보관·보정)하기 전까지 자동 게시가 그 지점에서 정지한다. 조용히 건너뛰지 않는 것이 의도다.
    return { kind: "blocked", placeId: next.placeId, name: next.name, reason: result.kind }
  } catch {
    return { kind: "failed", errorCode: "internal" }
  }
}
