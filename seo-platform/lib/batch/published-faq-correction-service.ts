import "server-only"

// 게시된 페이지의 FAQ 답변 보정 — 저장 경로. 판정은 published-faq-correction.ts.
//
// 공개 FAQ는 places.faq를 직접 읽는 공개 뷰를 거쳐 화면과 FAQ JSON-LD에 함께 나간다.
// 그래서 seo_pages에 FAQ를 복사하거나 다시 게시하지 않는다 — 게시 상태·published_at·slug·canonical은 그대로다.
//
// 안전 조건:
//  - published 장소 + 그 장소의 place SEO 페이지가 정확히 1개이고 published(published_at 있음)
//  - 같은 장소의 applied generation이고, 그 generation을 최종 콘텐츠로 쓴 batch item이 있다
//  - 현재 업종에서 콘텐츠 모드를 정할 수 있다 (모호하면 진행하지 않는다)
//  - 호출자가 본 콘텐츠 해시가 지금 장소 콘텐츠와 같다
//  - 보정안이 스키마·개인정보/가격 가드·금지 표현·모드 어휘 검사에서 '새 문제'를 만들지 않는다
//
// 쓰기 순서:
//  0) 의도 기록(generation.output.pending_published_faq_correction) — 무엇을 왜 고치려 했는지 먼저 남긴다
//  1) places.faq — status=published + 읽었을 때의 updated_at 조건 (compare-and-swap)
//  2) seo_pages.last_modified_at — 같은 행 버전·상태·published_at 조건
//  3) generation.output — generated/after를 현행 FAQ에 맞추고 이력에 한 번 append, 의도 제거
//  4) 재확인 — 세 곳과 불변이어야 할 값들을 다시 읽어 확인한다
// 모든 UPDATE는 영향 행이 정확히 1개인지 확인한다. 0행은 성공이 아니다.
//
// 1 이후에 실패하면 같은 step(같은 expectedContentHash = 보정 전 해시)으로 다시 실행해 이어서 끝낸다.
// 이어 하기는 "기록된 의도가 이 요청과 같고, 의도의 결과 해시가 지금 장소 해시와 같을 때"만 허용한다.
// 의도 기록 없이 "이미 같은 답이니 나머지를 맞춘다"는 동기화는 하지 않는다.
//
// ai_generations에는 행 버전 컬럼이 없다. 의도·확정 쓰기는 의도 표식(correction_id)을 조건으로 걸고,
// 마지막 재확인에서 이 경로가 바꾸지 않는 키가 읽었을 때와 같은지 비교해 동시 수정을 잡는다.
//
// 호출자는 게시 금지(publish freeze)와 게시 lock을 쥐고 있어야 한다.
import { createHash } from "node:crypto"

import { contentModeForCategory } from "@/lib/ai/content-mode"
import { scanBannedExpressions } from "@/lib/ai/content-quality"
import { assertAiOutputAllowed, parseAiProviderOutput } from "@/lib/ai/guardrails"
import { findForbiddenModeVocabulary, forbiddenVocabularyCode } from "@/lib/ai/mode-vocabulary"
import type { AiGeneratedSeoContent } from "@/lib/ai/types"
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { Json } from "@/types/database"
import { computePlaceContentHash } from "./content-hash"
import { editFaqAnswer, newIssueCodes } from "./published-faq-correction"

export const PENDING_KEY = "pending_published_faq_correction"
export const HISTORY_KEY = "published_faq_corrections"

export type PublishedFaqCorrectionInput = {
  readonly taskId: string
  readonly stepIndex: number
  readonly placeId: string
  readonly generationId: string
  readonly expectedContentHash: string
  readonly faqIndex: number
  readonly expectedQuestion: string
  readonly answer: string
  readonly actor: string
  readonly reason: string
}

export type PublishedFaqCorrectionBlock =
  | "place-not-found"
  | "place-not-published"
  | "generation-not-applied"
  | "generation-mismatch"
  | "seo-page-not-published"
  | "item-not-linked"
  | "mode-unsupported"
  | "content-changed"
  | "index-out-of-range"
  | "question-mismatch"
  | "no-changes"
  // 끝나지 않은 다른 보정이 장소까지 써 둔 상태다 — 그 보정을 먼저 끝내야 한다.
  | "incomplete-correction"
  // 평가하는 사이 장소가 수정됐다 — 장소는 덮어쓰지 않았다.
  | "write-conflict"

export type PublishedFaqCorrectionResult =
  | { readonly kind: "corrected"; readonly contentHash: string; readonly resumed: boolean; readonly path: string | null }
  | { readonly kind: "blocked"; readonly reason: PublishedFaqCorrectionBlock }
  | { readonly kind: "rejected"; readonly check: "schema" | "banned" | "vocabulary"; readonly codes: readonly string[] }
  // intent: 아무것도 바뀌지 않았다. seo-page·generation·verify: 장소는 보정됐다 — 게시 금지를 유지하고 같은 step으로 다시 실행한다.
  | { readonly kind: "failed"; readonly step: "intent" | "seo-page" | "generation" | "verify" }

type PendingIntent = {
  readonly correction_id: string
  readonly task_id: string
  readonly step_index: number
  readonly place_id: string
  readonly seo_page_id: string
  readonly path: string | null
  readonly faq_index: number
  readonly question: string
  readonly answer_before: string
  readonly answer_after: string
  readonly corrected_by: string
  readonly corrected_at: string
  readonly reason: string
  readonly checks: Json
  readonly before_hash: string
  readonly after_hash: string
  readonly content: AiGeneratedSeoContent
}

type Client = ReturnType<typeof createSupabaseServiceRoleClient>
type Wrapper = Record<string, Json | undefined>

const LINKED_ITEM_STATUSES = ["ready", "warn_ready"]

export async function correctPublishedFaq(input: PublishedFaqCorrectionInput): Promise<PublishedFaqCorrectionResult> {
  const client = createSupabaseServiceRoleClient()

  const [place, generation, seoPages, items] = await Promise.all([
    client.from("places").select("*").eq("id", input.placeId).maybeSingle(),
    client.from("ai_generations").select("id,place_id,status,output").eq("id", input.generationId).maybeSingle(),
    client.from("seo_pages").select("id,place_id,status,published_at,path,updated_at").eq("page_type", "place").eq("place_id", input.placeId),
    client.from("batch_run_items").select("id,status,generation_id,retry_generation_id").eq("place_id", input.placeId),
  ])
  if (place.error !== null || generation.error !== null || seoPages.error !== null || items.error !== null) {
    throw new Error("Failed to load published-faq-correction target")
  }
  if (place.data === null) {
    return { kind: "blocked", reason: "place-not-found" }
  }
  if (place.data.status !== "published") {
    return { kind: "blocked", reason: "place-not-published" }
  }
  if (generation.data?.status !== "applied") {
    return { kind: "blocked", reason: "generation-not-applied" }
  }
  if (generation.data.place_id !== input.placeId) {
    return { kind: "blocked", reason: "generation-mismatch" }
  }
  const seoPage = seoPages.data.length === 1 ? seoPages.data[0] : undefined
  if (seoPage?.status !== "published" || seoPage.published_at === null) {
    return { kind: "blocked", reason: "seo-page-not-published" }
  }
  // 그 generation을 최종 콘텐츠로 쓴 item (재시도가 있으면 재시도 generation이 최종이다).
  const linked = items.data.some((item) => LINKED_ITEM_STATUSES.includes(item.status) && (item.retry_generation_id ?? item.generation_id) === input.generationId)
  if (!linked) {
    return { kind: "blocked", reason: "item-not-linked" }
  }
  // 모드는 지금의 업종에서 다시 구한다 — 저장된 생성 기록의 모드를 믿지 않는다.
  const mode = contentModeForCategory(place.data.category)
  if (mode === null) {
    return { kind: "blocked", reason: "mode-unsupported" }
  }

  const stored = {
    meta_title: place.data.meta_title,
    meta_description: place.data.meta_description,
    description: place.data.description,
    faq: place.data.faq,
    keywords: place.data.keywords,
    internal_links: place.data.internal_links,
  }
  // 형식은 스키마로 확인하되, 보정의 바탕은 저장된 값 그대로 쓴다. 스키마 해석 결과는 객체 키 순서가
  // 저장본(jsonb)과 달라질 수 있고, 그러면 보정 뒤 해시가 DB에서 다시 읽은 해시와 어긋난다.
  parseAiProviderOutput(stored)
  const current = stored as unknown as AiGeneratedSeoContent
  const currentHash = computePlaceContentHash(place.data)
  const wrapper: Wrapper = asRecord(generation.data.output) ?? {}
  const pending = parsePending(wrapper[PENDING_KEY])
  const targets = {
    placeId: input.placeId,
    generationId: input.generationId,
    seoPageId: seoPage.id,
    seoPublishedAt: seoPage.published_at,
    seoUpdatedAt: seoPage.updated_at,
    placeUpdatedAt: place.data.updated_at,
  }

  if (currentHash !== input.expectedContentHash) {
    // 장소가 요청자가 본 내용과 다르다. 단 하나의 예외: 이 요청 자신이 장소까지 쓰고 멈춘 경우 — 마무리만 한다.
    if (pending !== null && isSameRequest(pending, input) && pending.before_hash === input.expectedContentHash && pending.after_hash === currentHash) {
      const failedStep = await finishCorrection(client, targets, wrapper, pending)
      return failedStep === null ? { kind: "corrected", contentHash: currentHash, resumed: true, path: seoPage.path } : { kind: "failed", step: failedStep }
    }
    return { kind: "blocked", reason: "content-changed" }
  }

  // 다른 보정이 장소까지 써 둔 상태 위에 새 보정을 얹지 않는다.
  if (pending !== null && pending.after_hash === currentHash) {
    return { kind: "blocked", reason: "incomplete-correction" }
  }

  const edited = editFaqAnswer(current, input)
  if (edited.kind !== "edited") {
    return { kind: "blocked", reason: edited.kind }
  }

  // 생성 경로와 같은 스키마·가드(전화·이메일·가격 누출).
  try {
    assertAiOutputAllowed(parseAiProviderOutput(edited.content), place.data as never)
  } catch {
    return { kind: "rejected", check: "schema", codes: [] }
  }
  // 금지 표현·모드 어휘 — 보정 전에도 있던 문제는 이 보정의 책임이 아니므로, 새로 생긴 것만 본다.
  const bannedNew = newIssueCodes(codesOf(scanBannedExpressions(current)), codesOf(scanBannedExpressions(edited.content)))
  if (bannedNew.length > 0) {
    return { kind: "rejected", check: "banned", codes: bannedNew }
  }
  const vocabularyInput = { mode, placeName: place.data.name, regionTokens: [place.data.city, place.data.district] }
  const vocabularyBefore = findForbiddenModeVocabulary({ ...vocabularyInput, content: current }).map(forbiddenVocabularyCode)
  const vocabularyAfter = findForbiddenModeVocabulary({ ...vocabularyInput, content: edited.content }).map(forbiddenVocabularyCode)
  const vocabularyNew = newIssueCodes(vocabularyBefore, vocabularyAfter)
  if (vocabularyNew.length > 0) {
    return { kind: "rejected", check: "vocabulary", codes: vocabularyNew }
  }

  const nextHash = computePlaceContentHash(edited.content)
  const intent: PendingIntent = {
    // 같은 대상·같은 전후 해시면 같은 ID — 다시 실행해도 이력이 중복되지 않는다.
    correction_id: createHash("sha256").update(`${input.generationId}:${currentHash}:${nextHash}`, "utf8").digest("hex").slice(0, 16),
    task_id: input.taskId,
    step_index: input.stepIndex,
    place_id: input.placeId,
    seo_page_id: seoPage.id,
    path: seoPage.path,
    faq_index: input.faqIndex,
    question: input.expectedQuestion,
    answer_before: edited.before,
    answer_after: input.answer,
    corrected_by: input.actor,
    corrected_at: new Date().toISOString(),
    reason: input.reason,
    checks: { mode, banned_baseline: codesOf(scanBannedExpressions(current)), vocabulary_baseline: vocabularyBefore, new_issues: [] },
    before_hash: currentHash,
    after_hash: nextHash,
    content: edited.content,
  }
  const withIntent: Wrapper = { ...wrapper, [PENDING_KEY]: intent }

  // 0) 의도 기록 — 읽었을 때의 의도 표식 그대로일 때만 쓴다 (다른 실행이 끼어들었으면 0행).
  let intentQuery = client.from("ai_generations").update({ output: withIntent }).eq("id", input.generationId).eq("status", "applied")
  intentQuery = pending === null ? intentQuery.is(pendingMarker(), null) : intentQuery.eq(pendingMarker(), pending.correction_id)
  const intentWrite = await intentQuery.select("id")
  if (intentWrite.error !== null || intentWrite.data.length !== 1) {
    return { kind: "failed", step: "intent" }
  }

  // 1) places.faq — compare-and-swap. FAQ 배열 말고는 아무것도 쓰지 않는다.
  const placeUpdate = await client
    .from("places")
    .update({ faq: edited.content.faq })
    .eq("id", input.placeId)
    .eq("status", "published")
    .eq("updated_at", place.data.updated_at)
    .select("id,updated_at")
  if (placeUpdate.error !== null) {
    throw new Error(`Failed to write corrected FAQ: ${placeUpdate.error.message}`)
  }
  const written = placeUpdate.data.length === 1 ? placeUpdate.data[0] : undefined
  if (written === undefined) {
    // 장소는 그대로다. 남은 의도는 결과 해시가 장소와 맞지 않아 이어 하기 대상이 아니다.
    return { kind: "blocked", reason: "write-conflict" }
  }

  const failedStep = await finishCorrection(client, { ...targets, placeUpdatedAt: written.updated_at }, withIntent, intent)
  if (failedStep !== null) {
    return { kind: "failed", step: failedStep }
  }
  return { kind: "corrected", contentHash: nextHash, resumed: false, path: seoPage.path }
}

type Targets = Readonly<{ placeId: string; generationId: string; seoPageId: string; seoPublishedAt: string; seoUpdatedAt: string; placeUpdatedAt: string }>

// 장소가 보정본이 된 뒤의 마무리. 실패한 단계 이름을 돌려준다 (성공이면 null).
async function finishCorrection(client: Client, targets: Targets, wrapper: Wrapper, intent: PendingIntent): Promise<"seo-page" | "generation" | "verify" | null> {
  // 2) seo_pages — 수정 시각만. 상태·published_at·경로는 조건으로만 쓰고 바꾸지 않는다.
  // 이전 실행이 여기까지 끝내고 멈췄을 수 있다 — 이미 이 보정의 시각이면 다시 쓰지 않는다.
  const seoNow = await client.from("seo_pages").select("id,status,published_at,last_modified_at,updated_at").eq("id", targets.seoPageId).maybeSingle()
  if (seoNow.error !== null || seoNow.data?.status !== "published" || seoNow.data.published_at !== targets.seoPublishedAt) {
    return "seo-page"
  }
  if (seoNow.data.last_modified_at !== intent.corrected_at) {
    const seoUpdate = await client
      .from("seo_pages")
      .update({ last_modified_at: intent.corrected_at })
      .eq("id", targets.seoPageId)
      .eq("place_id", targets.placeId)
      .eq("status", "published")
      .eq("published_at", targets.seoPublishedAt)
      .eq("updated_at", seoNow.data.updated_at)
      .select("id")
    if (seoUpdate.error !== null || seoUpdate.data.length !== 1) {
      return "seo-page"
    }
  }

  // 3) generation 확정 — provider·model·usage·비용·최초 audit·품질표·기존 ready 이력은 손대지 않는다.
  const storedHistory = wrapper[HISTORY_KEY]
  const history: readonly Json[] = Array.isArray(storedHistory) ? storedHistory : []
  const { content, ...record } = intent
  const alreadyRecorded = history.some((entry) => asRecord(entry)?.["correction_id"] === intent.correction_id)
  const rest = Object.fromEntries(Object.entries(wrapper).filter(([key]) => key !== PENDING_KEY))
  const nextOutput: Wrapper = {
    ...rest,
    generated: content,
    after: content,
    [HISTORY_KEY]: alreadyRecorded ? [...history] : [...history, record],
  }
  const generationUpdate = await client
    .from("ai_generations")
    .update({ output: nextOutput })
    .eq("id", targets.generationId)
    .eq("status", "applied")
    .eq(pendingMarker(), intent.correction_id)
    .select("id")
  if (generationUpdate.error !== null || generationUpdate.data.length !== 1) {
    return "generation"
  }

  // 4) 재확인 — 세 곳이 같은 보정본이고, 바뀌면 안 되는 값이 그대로인지.
  const [placeCheck, seoCheck, generationCheck] = await Promise.all([
    client.from("places").select("*").eq("id", targets.placeId).maybeSingle(),
    client.from("seo_pages").select("status,published_at,last_modified_at").eq("id", targets.seoPageId).maybeSingle(),
    client.from("ai_generations").select("status,output").eq("id", targets.generationId).maybeSingle(),
  ])
  if (placeCheck.error !== null || seoCheck.error !== null || generationCheck.error !== null || placeCheck.data === null || seoCheck.data === null || generationCheck.data === null) {
    return "verify"
  }
  const placeOk = placeCheck.data.status === "published" && placeCheck.data.updated_at === targets.placeUpdatedAt && computePlaceContentHash(placeCheck.data) === intent.after_hash
  const seoOk = seoCheck.data.status === "published" && seoCheck.data.published_at === targets.seoPublishedAt && seoCheck.data.last_modified_at === intent.corrected_at
  const finalOutput = asRecord(generationCheck.data.output)
  const finalHistory = finalOutput === null ? null : finalOutput[HISTORY_KEY]
  const recordedOnce = Array.isArray(finalHistory) && finalHistory.filter((entry) => asRecord(entry)?.["correction_id"] === intent.correction_id).length === 1
  // 이 경로가 바꾸지 않는 키는 읽었을 때와 같아야 한다 (동시 수정 감지).
  const untouchedOk = Object.entries(rest).every(([key, value]) => OWN_KEYS.has(key) || stableJson(finalOutput?.[key]) === stableJson(value))
  const generationOk = generationCheck.data.status === "applied" && finalOutput !== null && finalOutput[PENDING_KEY] === undefined && recordedOnce && untouchedOk
  return placeOk && seoOk && generationOk ? null : "verify"
}

const OWN_KEYS: ReadonlySet<string> = new Set(["generated", "after", HISTORY_KEY, PENDING_KEY])

// PostgREST JSON 경로 — 의도 표식(correction_id). 의도가 없으면 SQL NULL이다.
function pendingMarker(): string {
  return `output->${PENDING_KEY}->>correction_id`
}

function isSameRequest(pending: PendingIntent, input: PublishedFaqCorrectionInput): boolean {
  return pending.place_id === input.placeId && pending.faq_index === input.faqIndex && pending.question === input.expectedQuestion && pending.answer_after === input.answer
}

function codesOf(issues: readonly { readonly code: string }[]): readonly string[] {
  return issues.map((issue) => issue.code)
}

function parsePending(value: unknown): PendingIntent | null {
  const record = asRecord(value)
  if (record === null) {
    return null
  }
  const content = asRecord(record["content"])
  const faq = content === null ? null : content["faq"]
  const index = record["faq_index"]
  if (
    typeof record["correction_id"] !== "string" ||
    typeof record["place_id"] !== "string" ||
    typeof record["seo_page_id"] !== "string" ||
    typeof record["before_hash"] !== "string" ||
    typeof record["after_hash"] !== "string" ||
    typeof record["corrected_by"] !== "string" ||
    typeof record["corrected_at"] !== "string" ||
    typeof record["reason"] !== "string" ||
    typeof record["question"] !== "string" ||
    typeof record["answer_after"] !== "string" ||
    typeof index !== "number" ||
    content === null ||
    !Array.isArray(faq) ||
    // 기록된 보정본이 스스로 밝힌 결과 해시·답변과 맞지 않으면 믿지 않는다 (손상된 의도로 이어 하지 않는다).
    computePlaceContentHash(content as never) !== record["after_hash"] ||
    asRecord(faq[index])?.["answer"] !== record["answer_after"] ||
    asRecord(faq[index])?.["question"] !== record["question"]
  ) {
    return null
  }
  return record as unknown as PendingIntent
}

function asRecord(value: unknown): Wrapper | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Wrapper) : null
}

// jsonb는 키 순서를 보존하지 않는다 — 키를 정렬해 비교한다.
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "object" && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  )
}
