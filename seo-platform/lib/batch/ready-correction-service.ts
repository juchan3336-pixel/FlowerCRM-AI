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
// 쓰기 순서와 이유:
//  0) 의도 기록 — generation.output.pending_correction에 보정본·원문·주체·사유·평가 결과를 먼저 남긴다.
//     이 뒤 어느 단계에서 죽어도 "무엇을 왜 고치려 했는지"가 사라지지 않는다.
//  1) places — compare-and-swap. 읽었을 때의 updated_at(트리거가 모든 수정마다 갱신)이 그대로일 때만 쓴다.
//     평가하는 사이 누가 그 장소를 고쳤으면 0행이라 덮어쓰지 않고 충돌로 끝난다.
//  2) seo_pages → 3) generation 확정(보정본 반영, 이력 append, pending 제거).
//
// 2·3이 실패하면 장소는 보정본이고 나머지는 옛 값인 상태가 남는다. 같은 edits로 다시 호출하면 "이어 하기"다:
// 기록해 둔 의도(pending)의 결과 해시가 지금 장소 해시와 같을 때만, 그 의도에 담긴 평가 결과로 2·3을 끝낸다.
// 의도 기록 없이 "장소가 이미 이 값이니 나머지를 맞춘다"는 동기화는 하지 않는다 — 평가도 감사도 없는 쓰기가 된다.
//
// 호출자는 게시 금지(publish freeze)와 게시 lock을 쥐고 있어야 한다 — 이 함수는 게시와의 상호 배제를 만들지 않는다.
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
  // 끝나지 않은 이전 보정이 있는데, 지금 요청이 그것을 이어 하는 것이 아니다.
  | "incomplete-correction"

export type ReadyCorrectionResult =
  // resumed: 이전 실행이 장소까지만 쓰고 멈춘 보정을 이어서 끝냈다.
  | { readonly kind: "corrected"; readonly changedFields: readonly ResolvableField[]; readonly contentHash: string; readonly resumed: boolean }
  | { readonly kind: "blocked"; readonly reason: ReadyCorrectionBlock }
  | { readonly kind: "invalid-field"; readonly field: ResolvableField }
  | { readonly kind: "quality-not-pass"; readonly status: string; readonly issueCodes: readonly string[] }
  // intent: 의도 기록 실패 — 아무것도 바뀌지 않았다.
  // seo-page·generation: 장소는 보정됐고 뒤 쓰기가 실패했다 — 게시 금지를 유지하고 같은 edits로 다시 실행해 끝낸다.
  // place-changed: 마무리하는 동안 장소가 바뀌었다 — 세 곳이 어긋났을 수 있어 사람이 확인해야 한다.
  | { readonly kind: "failed"; readonly step: "intent" | "seo-page" | "generation" | "place-changed" }

const READY_ITEM_STATUSES = ["ready", "warn_ready"]

type PendingCorrection = {
  readonly correction_id: string
  readonly corrected_by: string
  readonly corrected_at: string
  readonly reason: string
  readonly changed_fields: readonly ResolvableField[]
  readonly before: Partial<AiGeneratedSeoContent>
  readonly before_hash: string
  readonly after_hash: string
  readonly content: AiGeneratedSeoContent
  readonly quality: Json
}

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
  const currentHash = computePlaceContentHash(place.data)
  if (currentHash !== input.expectedContentHash) {
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
  const pending = parsePending(wrapper["pending_correction"])
  const targets = { placeId: input.placeId, placeUpdatedAt: place.data.updated_at, seoPageId: seoPage.data.id, generationId: input.generationId }

  if (edited.changedFields.length === 0) {
    // 장소는 이미 이 edits가 반영된 값이다. 기록해 둔 의도가 정확히 이 상태를 만들려던 것일 때만 이어서 끝낸다.
    // 의도가 없거나, 있어도 지금 장소 상태를 만들려던 것이 아니면(적용되지 못한 옛 의도 등) 할 일이 없다.
    if (pending?.after_hash !== currentHash) {
      return { kind: "blocked", reason: "no-changes" }
    }
    const failedStep = await finishCorrection(client, targets, wrapper, pending)
    return failedStep === null ? { kind: "corrected", changedFields: pending.changed_fields, contentHash: currentHash, resumed: true } : { kind: "failed", step: failedStep }
  }

  // 장소까지 쓰고 멈춘 보정이 있는데, 그 위에 다른 보정을 얹으려 한다 — 먼저 그 보정을 끝내야 한다.
  if (pending?.after_hash === currentHash) {
    return { kind: "blocked", reason: "incomplete-correction" }
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

  const nextHash = computePlaceContentHash(edited.content)
  const intent: PendingCorrection = {
    correction_id: createHash("sha256").update(`${input.generationId}:${currentHash}:${nextHash}`, "utf8").digest("hex").slice(0, 16),
    corrected_by: input.actor,
    corrected_at: new Date().toISOString(),
    reason: input.reason.slice(0, 300),
    changed_fields: edited.changedFields,
    // 원문은 before에 보존한다 (places 기준 — 게시될 뻔한 값).
    before: edited.before,
    before_hash: currentHash,
    after_hash: nextHash,
    content: edited.content,
    quality: quality,
  }
  const withIntent: Record<string, Json | undefined> = { ...wrapper, pending_correction: intent }

  // 0) 의도 기록 — 장소를 건드리기 전에 남긴다. 콘텐츠(generated/after)는 아직 그대로다.
  const intentWrite = await client.from("ai_generations").update({ output: withIntent }).eq("id", input.generationId).eq("status", "applied").select("id")
  if (intentWrite.error !== null || intentWrite.data.length !== 1) {
    return { kind: "failed", step: "intent" }
  }

  // 1) places — compare-and-swap.
  const placeUpdate = await client
    .from("places")
    .update({ meta_title: edited.content.meta_title, meta_description: edited.content.meta_description, description: edited.content.description })
    .eq("id", input.placeId)
    .eq("status", "draft")
    .eq("updated_at", place.data.updated_at)
    .select("id,updated_at")
  if (placeUpdate.error !== null) {
    throw new Error(`Failed to write corrected place content: ${placeUpdate.error.message}`)
  }
  const written = placeUpdate.data[0]
  if (written === undefined) {
    // 장소는 그대로다. 남은 의도 기록은 결과 해시가 장소와 맞지 않아 이어 하기 대상이 아니며, 다음 보정이 덮어쓴다.
    return { kind: "blocked", reason: "write-conflict" }
  }

  const failedStep = await finishCorrection(client, { ...targets, placeUpdatedAt: written.updated_at }, withIntent, intent)
  if (failedStep !== null) {
    return { kind: "failed", step: failedStep }
  }
  return { kind: "corrected", changedFields: edited.changedFields, contentHash: nextHash, resumed: false }
}

type Client = ReturnType<typeof createSupabaseServiceRoleClient>

// 장소가 보정본이 된 뒤의 마무리: seo_pages와 generation을 의도에 기록된 콘텐츠로 맞추고 의도를 이력으로 옮긴다.
// 실패한 단계 이름을 돌려준다 (성공이면 null).
async function finishCorrection(
  client: Client,
  targets: Readonly<{ placeId: string; placeUpdatedAt: string; seoPageId: string; generationId: string }>,
  wrapper: Record<string, Json | undefined>,
  intent: PendingCorrection,
): Promise<"seo-page" | "generation" | "place-changed" | null> {
  // seo_pages — 재적용은 title/description을 갱신하지 않으므로 여기서 직접 맞춘다. ready·미공개일 때만.
  const seoUpdate = await client
    .from("seo_pages")
    .update({ title: intent.content.meta_title, description: intent.content.meta_description, last_modified_at: intent.corrected_at })
    .eq("id", targets.seoPageId)
    .eq("status", "ready")
    .is("published_at", null)
    .select("id")
  if (seoUpdate.error !== null || seoUpdate.data.length !== 1) {
    return "seo-page"
  }

  // generation 확정 — provider·model·usage·estimated_cost·audit(최초 생성 감사)는 손대지 않는다.
  // 보정 이력은 덮어쓰지 않고 쌓는다. 품질표는 이 보정본을 평가한 결과로 바꾼다.
  const storedHistory = wrapper["ready_corrections"]
  const history: readonly Json[] = Array.isArray(storedHistory) ? storedHistory : []
  const { content, quality, ...record } = intent
  const rest = Object.fromEntries(Object.entries(wrapper).filter(([key]) => key !== "pending_correction"))
  const nextOutput = {
    ...rest,
    generated: content as unknown as Json,
    after: content as unknown as Json,
    quality,
    ready_corrections: [...history, record as unknown as Json],
  }
  const generationUpdate = await client.from("ai_generations").update({ output: nextOutput }).eq("id", targets.generationId).eq("status", "applied").select("id")
  if (generationUpdate.error !== null || generationUpdate.data.length !== 1) {
    return "generation"
  }

  // 마무리하는 동안 장소가 다시 바뀌지 않았는지 확인한다 — 바뀌었다면 세 곳이 같은 콘텐츠라고 말할 수 없다.
  const check = await client.from("places").select("updated_at").eq("id", targets.placeId).maybeSingle()
  if (check.error !== null || check.data?.updated_at !== targets.placeUpdatedAt) {
    return "place-changed"
  }
  return null
}

function parsePending(value: unknown): PendingCorrection | null {
  const record = asRecord(value)
  if (record === null) {
    return null
  }
  const content = asRecord(record["content"])
  if (
    typeof record["correction_id"] !== "string" ||
    typeof record["before_hash"] !== "string" ||
    typeof record["after_hash"] !== "string" ||
    typeof record["corrected_by"] !== "string" ||
    typeof record["corrected_at"] !== "string" ||
    typeof record["reason"] !== "string" ||
    !Array.isArray(record["changed_fields"]) ||
    content === null ||
    // 기록된 보정본이 스스로 밝힌 결과 해시와 맞지 않으면 믿지 않는다.
    typeof content["meta_title"] !== "string" ||
    computePlaceContentHash(content as never) !== record["after_hash"]
  ) {
    return null
  }
  return record as unknown as PendingCorrection
}

function asRecord(value: unknown): Record<string, Json | undefined> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json | undefined>) : null
}
