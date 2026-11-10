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
//
// 쓰기는 places가 먼저이고, 그 UPDATE가 compare-and-swap이다: 읽었을 때의 updated_at(트리거가 모든 수정마다
// 갱신)이 그대로일 때만 쓴다. 평가하는 사이 누가 그 장소를 고쳤으면 0행이라 덮어쓰지 않고 충돌로 끝난다.
// 승자만 seo_pages·generation을 맞춘다. 그 두 쓰기가 실패하면 장소는 보정됐고 나머지는 옛 값인 상태가 남는데,
// 같은 edits로 다시 호출하면(새 해시로) "변경 없음"이 아니라 어긋난 쪽을 맞추는 동기화로 수렴한다.
//
// 호출자는 게시 보류(publish hold)를 쥐고 있어야 한다 — 이 함수는 게시와의 상호 배제를 스스로 만들지 않는다.
import { createHash } from "node:crypto"

import { assertAiOutputAllowed, parseAiProviderOutput } from "@/lib/ai/guardrails"
import { evaluateGenerationQuality } from "@/lib/ai/generation-runner"
import type { AiGeneratedSeoContent } from "@/lib/ai/types"
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import { computePlaceContentHash } from "./content-hash"
import { loadBatchAvoidanceForItem } from "./generation-batch-service"
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
  // 평가하는 사이 장소가 수정됐다 — 아무것도 덮어쓰지 않았다.
  | "write-conflict"

export type ReadyCorrectionResult =
  | { readonly kind: "corrected"; readonly changedFields: readonly ResolvableField[]; readonly contentHash: string }
  // 장소는 이미 보정본이고, 어긋나 있던 seo_pages·generation만 맞췄다 (이전 실행이 중간에 실패한 경우).
  | { readonly kind: "synced"; readonly contentHash: string }
  | { readonly kind: "blocked"; readonly reason: ReadyCorrectionBlock }
  | { readonly kind: "invalid-field"; readonly field: ResolvableField }
  | { readonly kind: "quality-not-pass"; readonly status: string; readonly issueCodes: readonly string[] }
  // 장소는 보정됐지만 뒤따르는 쓰기가 실패했다 — 게시 보류를 풀지 말고 같은 edits로 다시 실행해 맞춘다.
  | { readonly kind: "failed"; readonly step: "seo-page" | "generation" }

const READY_ITEM_STATUSES = ["ready", "warn_ready"]

export async function correctReadyContent(input: ReadyCorrectionInput): Promise<ReadyCorrectionResult> {
  const client = createSupabaseServiceRoleClient()

  const [place, generation, seoPage, items] = await Promise.all([
    client.from("places").select("*").eq("id", input.placeId).maybeSingle(),
    client.from("ai_generations").select("id,place_id,status,output").eq("id", input.generationId).maybeSingle(),
    client.from("seo_pages").select("id,status,published_at,title,description").eq("page_type", "place").eq("place_id", input.placeId).maybeSingle(),
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
  const wrapper = asRecord(generation.data.output) ?? {}
  const correctedAt = new Date().toISOString()

  if (edited.changedFields.length === 0) {
    // 장소는 이미 이 edits가 반영된 상태다. seo_pages·generation이 장소와 어긋나 있으면 이전 실행이 중간에
    // 실패한 것이므로 그쪽만 맞춘다. 전부 일치하면 할 일이 없다.
    const seoInSync = seoPage.data.title === current.meta_title && seoPage.data.description === current.meta_description
    const stored = asRecord(wrapper["generated"])
    const generationInSync = stored !== null && typeof stored["meta_title"] === "string" && computePlaceContentHash(stored as never) === input.expectedContentHash
    if (seoInSync && generationInSync) {
      return { kind: "blocked", reason: "no-changes" }
    }
    const synced = await writeSeoAndGeneration(client, { seoPageId: seoPage.data.id, generationId: input.generationId, content: current, wrapper, correction: null, correctedAt })
    return synced === null ? { kind: "synced", contentHash: input.expectedContentHash } : { kind: "failed", step: synced }
  }

  try {
    // 생성 경로와 같은 스키마·가드레일 (전화·이메일·가격 누출, 형식 오류 차단).
    assertAiOutputAllowed(parseAiProviderOutput(edited.content), place.data as never)
  } catch {
    return { kind: "invalid-field", field: edited.changedFields[0] ?? "body" }
  }

  // 보정안을 저장하기 전에 평가한다 — 통과하지 못하면 어떤 기록도 바꾸지 않는다.
  const avoidance = await loadBatchAvoidanceForItem(item)
  const quality = await evaluateGenerationQuality(input.generationId, { contentOverride: edited.content, pendingBodies: avoidance.bodies ?? [], persist: false })
  if (quality === null || quality.status === "fail" || quality.issues.some((issue) => issue.level === "fail")) {
    return { kind: "quality-not-pass", status: quality?.status ?? "unknown", issueCodes: (quality?.issues ?? []).map((issue) => issue.code) }
  }

  // 1) places — compare-and-swap. 읽은 뒤로 이 행이 한 번도 수정되지 않았을 때만 쓴다.
  const placeUpdate = await client
    .from("places")
    .update({ meta_title: edited.content.meta_title, meta_description: edited.content.meta_description, description: edited.content.description })
    .eq("id", input.placeId)
    .eq("status", "draft")
    .eq("updated_at", place.data.updated_at)
    .select("id")
  if (placeUpdate.error !== null) {
    throw new Error(`Failed to write corrected place content: ${placeUpdate.error.message}`)
  }
  if (placeUpdate.data.length !== 1) {
    return { kind: "blocked", reason: "write-conflict" }
  }

  const nextHash = computePlaceContentHash(edited.content)
  const correction = {
    corrected_by: input.actor,
    corrected_at: correctedAt,
    reason: input.reason.slice(0, 300),
    changed_fields: edited.changedFields,
    // 원본 필드는 before에 보존한다 (places 기준 — 게시될 뻔한 값).
    before: edited.before,
    before_hash: input.expectedContentHash,
    after_hash: nextHash,
    correction_id: createHash("sha256").update(`${input.generationId}:${input.expectedContentHash}:${nextHash}`, "utf8").digest("hex").slice(0, 16),
    quality,
  }
  const failedStep = await writeSeoAndGeneration(client, { seoPageId: seoPage.data.id, generationId: input.generationId, content: edited.content, wrapper, correction, correctedAt })
  if (failedStep !== null) {
    return { kind: "failed", step: failedStep }
  }
  return { kind: "corrected", changedFields: edited.changedFields, contentHash: nextHash }
}

type Client = ReturnType<typeof createSupabaseServiceRoleClient>

// 장소 CAS에서 이긴 뒤(또는 동기화 모드에서) seo_pages와 generation을 장소 콘텐츠에 맞춘다.
// 실패한 단계 이름을 돌려준다 (성공이면 null).
async function writeSeoAndGeneration(
  client: Client,
  input: Readonly<{ seoPageId: string; generationId: string; content: AiGeneratedSeoContent; wrapper: Record<string, Json | undefined>; correction: Record<string, unknown> | null; correctedAt: string }>,
): Promise<"seo-page" | "generation" | null> {
  // seo_pages — 재적용은 title/description을 갱신하지 않으므로 여기서 직접 맞춘다. ready·미공개일 때만.
  const seoUpdate = await client
    .from("seo_pages")
    .update({ title: input.content.meta_title, description: input.content.meta_description, last_modified_at: input.correctedAt })
    .eq("id", input.seoPageId)
    .eq("status", "ready")
    .is("published_at", null)
    .select("id")
  if (seoUpdate.error !== null || seoUpdate.data.length !== 1) {
    return "seo-page"
  }

  // generation — provider·model·usage·estimated_cost·audit(최초 생성 감사)는 손대지 않는다.
  // 보정 이력은 덮어쓰지 않고 쌓는다: 두 번째 보정이 첫 번째의 주체·사유·원문을 지우지 않게.
  const storedHistory = input.wrapper["ready_corrections"]
  const history: readonly Json[] = Array.isArray(storedHistory) ? storedHistory : []
  const nextOutput = {
    ...input.wrapper,
    generated: input.content as unknown as Json,
    after: input.content as unknown as Json,
    ...(input.correction === null ? {} : { quality: input.correction["quality"] as Json, ready_corrections: [...history, input.correction] as unknown as Json }),
  }
  const generationUpdate = await client.from("ai_generations").update({ output: nextOutput }).eq("id", input.generationId).eq("status", "applied").select("id")
  if (generationUpdate.error !== null || generationUpdate.data.length !== 1) {
    return "generation"
  }
  return null
}

function asRecord(value: unknown): Record<string, Json | undefined> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json | undefined>) : null
}
