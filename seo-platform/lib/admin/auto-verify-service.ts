import "server-only"

// 자동 업체 확인 pump 코어 — Cron이 주기적으로 불러 미확인 후보를 조금씩 소화한다.
//
// 한 tick = 후보 여러 곳(기본 5)을 확인한다. AI 호출이 아니라 홈페이지 조회라 비용이 없고,
// 곳당 최대 3요청·8초라 tick 전체가 함수 실행 한도 안에 들어온다.
// 통과 조건은 auto-verify-policy가 정하고, 여기서는 수집·기록만 한다.
//
// 통과하면 verified로 올려 2단계 후보가 되고, 통과하지 못하면 사유를 남긴 채 큐에 남는다 —
// 사람이 나중에 그 사유를 보고 직접 확인하면 된다. 어느 쪽이든 checked_at을 찍어 같은 곳을 다시 보지 않는다.
import { contentModeForCategory, mappedCategories } from "@/lib/ai/content-mode"
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import { decideAutoVerify, hostOf, type AutoVerifyManualReason } from "./auto-verify-policy"
import { isVerificationQueueCandidate } from "./verification-queue"
import { collectVerificationEvidence } from "./verification-evidence-server"

export const AUTO_VERIFY_BATCH_SIZE = 5

// 콘텐츠 모드가 매핑된 업종 원문 목록 — 시트 값 그대로다 (예: funeral, 호텔, 제조).
function supportedCategories(): readonly string[] {
  return mappedCategories().filter((category) => contentModeForCategory(category) !== null)
}

export type AutoVerifyTickOutcome =
  | { readonly kind: "disabled" }
  | { readonly kind: "idle" }
  | { readonly kind: "processed"; readonly checked: number; readonly verified: number; readonly manual: number }
  | { readonly kind: "failed"; readonly errorCode: "internal" }

export function httpStatusForAutoVerifyOutcome(outcome: AutoVerifyTickOutcome): number {
  return outcome.kind === "failed" ? 500 : 200
}

export function safeAutoVerifyResponseBody(outcome: AutoVerifyTickOutcome): Record<string, unknown> {
  return outcome.kind === "processed"
    ? { kind: outcome.kind, checked: outcome.checked, verified: outcome.verified, manual: outcome.manual }
    : { kind: outcome.kind }
}

export function parseAutoVerifySetting(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "on"
}

async function isEnabled(): Promise<boolean> {
  const client = createSupabaseServiceRoleClient()
  const { data } = await client.from("settings").select("value").eq("key", "auto_verify").maybeSingle()
  return parseAutoVerifySetting(data?.value)
}

// 같은 호스트를 쓰는 다른 장소 수 — 지점 목록·프랜차이즈 공용 사이트 판정에 쓴다.
async function countPlacesSharingHost(homepage: string, placeId: string): Promise<number> {
  const host = hostOf(homepage)
  if (host === null) {
    return 0
  }
  const client = createSupabaseServiceRoleClient()
  const { count } = await client
    .from("places")
    .select("id", { count: "exact", head: true })
    .neq("id", placeId)
    .or(`homepage.ilike.%://${host}/%,homepage.ilike.%://${host},homepage.ilike.%://www.${host}/%,homepage.ilike.%://www.${host}`)
  return (count ?? 0) + 1
}

export async function runAutoVerifyTick(batchSize = AUTO_VERIFY_BATCH_SIZE): Promise<AutoVerifyTickOutcome> {
  try {
    if (!(await isEnabled())) {
      return { kind: "disabled" }
    }
    const client = createSupabaseServiceRoleClient()
    // 콘텐츠 모드가 있는 업종만 대상으로 삼는다. 이 필터가 없으면 전체 6,955곳 중 지원 업종 2,476곳에
    // 닿기까지 4,479행을 훑느라 15시간을 버린다 (2026-08-06 실측). 지원 밖 업종은 검증해도
    // 생성 후보가 되지 못하므로 아예 건드리지 않는다.
    const { data: places, error } = await client
      .from("places")
      .select("*")
      .eq("status", "draft")
      .is("official_verification_status", null)
      .is("auto_verify_checked_at", null)
      .in("category", [...supportedCategories()])
      .not("homepage", "is", null)
      .not("address", "is", null)
      .order("collected_at", { ascending: false, nullsFirst: false })
      .limit(batchSize * 4)
    if (error !== null) {
      return { kind: "failed", errorCode: "internal" }
    }
    if (places.length === 0) {
      return { kind: "idle" }
    }

    const targets = places.filter((place) => isVerificationQueueCandidate(place)).slice(0, batchSize)
    if (targets.length === 0) {
      // 업종은 맞지만 큐 조건에 걸린 행(추모시설 등) — 다시 보지 않도록 사유를 남기고 끝낸다.
      const skipped = places.slice(0, batchSize)
      for (const place of skipped) {
        await stampChecked(place.id, 0, "not-eligible")
      }
      return { kind: "processed", checked: skipped.length, verified: 0, manual: skipped.length }
    }

    let verified = 0
    let manual = 0
    for (const place of targets) {
      // isVerificationQueueCandidate가 이미 homepage 비어 있음을 걸렀다.
      const homepage = place.homepage.trim()
      const evidence = await collectVerificationEvidence(place.id)
      const sameHostPlaceCount = await countPlacesSharingHost(homepage, place.id)
      const decision = decideAutoVerify({
        homepage,
        httpStatus: evidence.httpStatus,
        matched: evidence.matched,
        textUnavailable: evidence.textUnavailable,
        sameHostPlaceCount,
      })
      if (decision.kind === "verified") {
        // 조건부 갱신 — 그 사이 사람이 처리했으면 덮어쓰지 않는다.
        await client
          .from("places")
          .update({
            official_verification_status: "verified",
            verified_at: new Date().toISOString(),
            verified_by: "auto-verify",
            verification_source_urls: [homepage],
            auto_verify_checked_at: new Date().toISOString(),
            auto_verify_score: evidence.matched.length,
            auto_verify_reason: null,
          })
          .eq("id", place.id)
          .eq("status", "draft")
          .is("official_verification_status", null)
        verified += 1
      } else {
        await stampChecked(place.id, evidence.matched.length, decision.reason)
        manual += 1
      }
    }
    return { kind: "processed", checked: targets.length, verified, manual }
  } catch {
    return { kind: "failed", errorCode: "internal" }
  }
}

async function stampChecked(placeId: string, score: number, reason: AutoVerifyManualReason): Promise<void> {
  const client = createSupabaseServiceRoleClient()
  await client
    .from("places")
    .update({ auto_verify_checked_at: new Date().toISOString(), auto_verify_score: score, auto_verify_reason: reason })
    .eq("id", placeId)
    .is("official_verification_status", null)
}
