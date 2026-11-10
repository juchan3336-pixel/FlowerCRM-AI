import "server-only"

// 게시 준비(ready) 상태 콘텐츠의 수동 보정 — 이미 적용(applied)됐지만 아직 공개 전인 장소의
// 제목·본문·메타 설명을 고친다.
//
// 기존 검토 해소(resolveNeedsReviewItem)는 needs_review + preview만 다룬다. 품질 검사를 통과해 ready가 된
// 뒤에 사람이 읽고 발견한 결함(배치 내 중복 문장, 제목과 본문 불일치)은 고칠 경로가 없었다.
// 상태를 preview로 되돌려 우회하지 않는다 — applied 기록·사용량·비용은 그대로 두고 콘텐츠만 바꾼다.
//
// 안전 조건:
//  - draft 장소 + seo_pages ready(미공개) + applied generation + 그 generation을 쓴 ready/warn_ready item
//  - 호출자가 본 콘텐츠의 해시(expectedContentHash)가 지금 places 콘텐츠와 같을 때만 진행
//  - 보정안은 생성 경로와 같은 스키마·가드레일, 같은 품질 평가(같은 배치 앞선 본문 포함)를 통과해야 저장
//  - 쓰기 순서는 generation → seo_pages → places. 해시 기준인 places를 마지막에 써서, 중간에 실패해도
//    같은 입력으로 다시 실행하면 같은 결과로 수렴한다 (places가 바뀐 뒤에는 해시가 달라 재실행이 막힌다).
import { createHash } from "node:crypto"

import { assertAiOutputAllowed, parseAiProviderOutput } from "@/lib/ai/guardrails"
import { evaluateGenerationQuality } from "@/lib/ai/generation-runner"
import type { AiGeneratedSeoContent } from "@/lib/ai/types"
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import { computePlaceContentHash } from "./content-hash"
import { applyResolutionEdits, type ResolvableField, type ResolutionFieldEdits } from "./needs-review-resolution"
import { READY_CORRECTION_FIELDS, type ReadyCorrectionEdits } from "./ops-task"
import type { Json } from "@/types/database"

export { READY_CORRECTION_FIELDS, type ReadyCorrectionEdits }

export type ReadyCorrectionInput = {
  readonly placeId: string
  readonly generationId: string
  readonly expectedContentHash: string
  readonly edits: ReadyCorrectionEdits
  readonly actor: string
  readonly reason: string
}

export type ReadyCorrectionBlock =
  | "place-not-found"
  | "place-not-draft"
  | "generation-not-applied"
  | "generation-mismatch"
  | "seo-page-not-ready"
  | "item-not-ready"
  | "content-changed"
  | "no-changes"

export type ReadyCorrectionResult =
  | { readonly kind: "corrected"; readonly changedFields: readonly ResolvableField[]; readonly contentHash: string }
  | { readonly kind: "blocked"; readonly reason: ReadyCorrectionBlock }
  | { readonly kind: "invalid-field"; readonly field: ResolvableField }
  | { readonly kind: "quality-not-pass"; readonly status: string; readonly issueCodes: readonly string[] }
  | { readonly kind: "failed"; readonly step: "generation" | "seo-page" | "place" }

const READY_ITEM_STATUSES = ["ready", "warn_ready"]

export async function correctReadyContent(input: ReadyCorrectionInput): Promise<ReadyCorrectionResult> {
  const client = createSupabaseServiceRoleClient()

  const [place, generation, seoPage, items] = await Promise.all([
    client.from("places").select("*").eq("id", input.placeId).maybeSingle(),
    client.from("ai_generations").select("id,place_id,status,output").eq("id", input.generationId).maybeSingle(),
    client.from("seo_pages").select("id,status,published_at").eq("page_type", "place").eq("place_id", input.placeId).maybeSingle(),
    client.from("batch_run_items").select("id,batch_id,sequence,status,generation_id,retry_generation_id").eq("place_id", input.placeId),
  ])
  if (place.error !== null || generation.error !== null || seoPage.error !== null || items.error !== null) {
    throw new Error("Failed to load ready-correction target")
  }
  if (place.data === null) {
    return { kind: "blocked", reason: "place-not-found" }
  }
  if (place.data.status !== "draft") {
    return { kind: "blocked", reason: "place-not-draft" }
  }
  if (generation.data?.status !== "applied") {
    return { kind: "blocked", reason: "generation-not-applied" }
  }
  if (generation.data.place_id !== input.placeId) {
    return { kind: "blocked", reason: "generation-mismatch" }
  }
  if (seoPage.data?.status !== "ready" || seoPage.data.published_at !== null) {
    return { kind: "blocked", reason: "seo-page-not-ready" }
  }
  // 그 generation을 최종 콘텐츠로 쓴 item (재시도가 있으면 재시도 generation이 최종이다).
  const item = items.data.find((candidate) => READY_ITEM_STATUSES.includes(candidate.status) && (candidate.retry_generation_id ?? candidate.generation_id) === input.generationId)
  if (item === undefined) {
    return { kind: "blocked", reason: "item-not-ready" }
  }

  const current: AiGeneratedSeoContent = parseAiProviderOutput({
    meta_title: place.data.meta_title,
    meta_description: place.data.meta_description,
    description: place.data.description,
    faq: place.data.faq,
    keywords: place.data.keywords,
    internal_links: place.data.internal_links,
  })
  if (computePlaceContentHash(place.data) !== input.expectedContentHash) {
    return { kind: "blocked", reason: "content-changed" }
  }

  const edits: ResolutionFieldEdits = {}
  for (const field of READY_CORRECTION_FIELDS) {
    const value = input.edits[field]
    if (value !== undefined) {
      edits[field] = value
    }
  }
  const edited = applyResolutionEdits(current, edits)
  if (edited.kind === "invalid") {
    return { kind: "invalid-field", field: edited.field }
  }
  if (edited.changedFields.length === 0) {
    return { kind: "blocked", reason: "no-changes" }
  }
  try {
    // 생성 경로와 같은 스키마·가드레일 (전화·이메일·가격 누출, 형식 오류 차단).
    assertAiOutputAllowed(parseAiProviderOutput(edited.content), place.data as never)
  } catch {
    return { kind: "invalid-field", field: edited.changedFields[0] ?? "body" }
  }

  // 보정안을 저장하기 전에 평가한다 — 통과하지 못하면 어떤 기록도 바꾸지 않는다.
  const { loadBatchAvoidanceForItem } = await import("./generation-batch-service")
  const avoidance = await loadBatchAvoidanceForItem(item)
  const quality = await evaluateGenerationQuality(input.generationId, { contentOverride: edited.content, pendingBodies: avoidance.bodies ?? [], persist: false })
  if (quality === null || quality.status === "fail" || quality.issues.some((issue) => issue.level === "fail")) {
    return { kind: "quality-not-pass", status: quality?.status ?? "unknown", issueCodes: (quality?.issues ?? []).map((issue) => issue.code) }
  }

  const nextHash = computePlaceContentHash(edited.content)
  const correctedAt = new Date().toISOString()
  const wrapper = typeof generation.data.output === "object" && generation.data.output !== null && !Array.isArray(generation.data.output) ? { ...(generation.data.output as Record<string, Json | undefined>) } : {}
  const nextOutput = {
    ...wrapper,
    generated: edited.content as unknown as Json,
    after: edited.content as unknown as Json,
    quality: quality as unknown as Json,
    // 원본 필드는 before에 보존한다. provider·model·usage·estimated_cost·audit는 손대지 않는다.
    ready_correction: {
      corrected_by: input.actor,
      corrected_at: correctedAt,
      reason: input.reason.slice(0, 300),
      changed_fields: edited.changedFields,
      before: edited.before,
      before_hash: input.expectedContentHash,
      after_hash: nextHash,
      // 재실행 식별용 — 같은 보정이 두 번 기록됐는지 구분한다.
      correction_id: createHash("sha256").update(`${input.generationId}:${input.expectedContentHash}:${nextHash}`, "utf8").digest("hex").slice(0, 16),
    } as unknown as Json,
  }

  // 1) generation — applied 상태일 때만.
  const generationUpdate = await client.from("ai_generations").update({ output: nextOutput }).eq("id", input.generationId).eq("status", "applied").select("id")
  if (generationUpdate.error !== null || generationUpdate.data.length !== 1) {
    return { kind: "failed", step: "generation" }
  }
  // 2) seo_pages — 재적용은 title/description을 갱신하지 않으므로 여기서 직접 맞춘다. ready·미공개일 때만.
  const seoUpdate = await client
    .from("seo_pages")
    .update({ title: edited.content.meta_title, description: edited.content.meta_description, last_modified_at: correctedAt })
    .eq("id", seoPage.data.id)
    .eq("status", "ready")
    .is("published_at", null)
    .select("id")
  if (seoUpdate.error !== null || seoUpdate.data.length !== 1) {
    return { kind: "failed", step: "seo-page" }
  }
  // 3) places — 해시 기준이므로 마지막. draft일 때만.
  const placeUpdate = await client
    .from("places")
    .update({ meta_title: edited.content.meta_title, meta_description: edited.content.meta_description, description: edited.content.description })
    .eq("id", input.placeId)
    .eq("status", "draft")
    .select("id")
  if (placeUpdate.error !== null || placeUpdate.data.length !== 1) {
    return { kind: "failed", step: "place" }
  }
  return { kind: "corrected", changedFields: edited.changedFields, contentHash: nextHash }
}
