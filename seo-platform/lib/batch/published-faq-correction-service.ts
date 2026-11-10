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
// ai_generations에는 행 버전 컬럼이 없다. output을 쓰는 모든 경로가 output_revision 계약
// (lib/ai/generation-output-revision.ts)을 따른다: 읽은 버전 그대로일 때만 쓰고, 쓸 때 새 버전을 넣는다.
// 그 사이 품질표 첨부 같은 다른 쓰기가 있었으면 0행이라 덮어쓰지 않는다.
//
// 완료 뒤의 재시도: 확정까지 끝난 뒤 재확인 조회나 결과 저장이 실패하면 호출자는 실패로 알지만 보정은 끝나 있다.
// 그때 같은 요청이 다시 오면, 이 요청과 정확히 맞는 완료 이력 1건이 있고 지금 상태가 그 기록과 일치하는지
// 쓰기 없이 확인해 완료로 답한다 (이력을 다시 쌓지 않는다).
//
// 호출자는 게시 금지(publish freeze)와 게시 lock을 쥐고 있어야 한다.
import { createHash } from "node:crypto"

import { contentModeForCategory } from "@/lib/ai/content-mode"
import { scanBannedExpressions } from "@/lib/ai/content-quality"
import { outputRevisionOf, whereOutputRevision, withNextOutputRevision } from "@/lib/ai/generation-output-revision"
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
  // 의도 기록이 있는데 해석되지 않는다(손상·형식 오류·null) — 무엇을 하다 멈춘 것인지 모르므로 사람이 확인해야 한다.
  | "corrupt-intent"

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
  readonly seo_published_at: string
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
    client.from("seo_pages").select("id,place_id,status,published_at,path,last_modified_at,updated_at").eq("page_type", "place").eq("place_id", input.placeId),
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
  // "의도 없음"은 키가 아예 없을 때뿐이다. 키가 있는데 해석되지 않으면(JSON null 포함) 없는 것으로 치지 않는다 —
  // 그 상태에서 새 보정을 시작하거나 완료로 답하면, 멈춘 작업의 흔적을 덮거나 남긴 채 성공을 말하게 된다.
  const rawPending = wrapper[PENDING_KEY]
  const pending = rawPending === undefined ? null : parsePending(rawPending)
  if (rawPending !== undefined && pending === null) {
    return { kind: "blocked", reason: "corrupt-intent" }
  }
  const targets = {
    placeId: input.placeId,
    generationId: input.generationId,
    seoPageId: seoPage.id,
    seoPublishedAt: seoPage.published_at,
    seoUpdatedAt: seoPage.updated_at,
    placeUpdatedAt: place.data.updated_at,
  }

  if (currentHash !== input.expectedContentHash) {
    // 장소가 요청자가 본 내용과 다르다. 허용하는 경우는 둘뿐이다 — 둘 다 "이 요청 자신이 만든 상태"일 때다.
    // (a) 이 요청이 장소까지 쓰고 멈췄다: 기록된 의도가 이 요청·이 대상과 같고 결과 해시가 지금 장소와 같다 → 마무리만 한다.
    if (
      pending !== null &&
      isSameRequest(pending, input) &&
      pending.before_hash === input.expectedContentHash &&
      pending.after_hash === currentHash &&
      pending.seo_page_id === seoPage.id &&
      pending.path === seoPage.path &&
      sameInstant(pending.seo_published_at, seoPage.published_at)
    ) {
      const failedStep = await finishCorrection(client, targets, wrapper, pending)
      return failedStep === null ? { kind: "corrected", contentHash: currentHash, resumed: true, path: seoPage.path } : { kind: "failed", step: failedStep }
    }
    // (b) 이 요청이 이미 끝까지 반영됐다: 완료 이력과 지금 상태가 일치한다 → 쓰기 없이 완료로 답한다.
    if (pending === null && isAlreadyCompleted(wrapper, input, { currentHash, seoPage })) {
      return { kind: "corrected", contentHash: currentHash, resumed: true, path: seoPage.path }
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
    seo_published_at: seoPage.published_at,
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
  const withIntent: Wrapper = withNextOutputRevision({ ...wrapper, [PENDING_KEY]: intent })

  // 0) 의도 기록 — 읽었을 때의 output 버전 그대로일 때만 쓴다. 그 사이 다른 경로(품질표 첨부, 다른 보정)가 썼으면 0행이다.
  const intentWrite = await whereOutputRevision(client.from("ai_generations").update({ output: withIntent }).eq("id", input.generationId).eq("status", "applied"), wrapper).select("id")
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
  if (!sameInstant(seoNow.data.last_modified_at, intent.corrected_at)) {
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
  const nextOutput: Wrapper = withNextOutputRevision({
    ...rest,
    generated: content,
    after: content,
    [HISTORY_KEY]: alreadyRecorded ? [...history] : [...history, record],
  })
  // wrapper는 방금 쓴 의도 기록(또는 이어 하기에서 읽은 값)이다 — 그 버전 위에만 확정한다.
  const generationUpdate = await whereOutputRevision(client.from("ai_generations").update({ output: nextOutput }).eq("id", targets.generationId).eq("status", "applied"), wrapper).select("id")
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
  const seoOk = seoCheck.data.status === "published" && sameInstant(seoCheck.data.published_at, targets.seoPublishedAt) && sameInstant(seoCheck.data.last_modified_at, intent.corrected_at)
  const finalOutput = asRecord(generationCheck.data.output)
  const finalHistory = finalOutput === null ? null : finalOutput[HISTORY_KEY]
  const recordedOnce = Array.isArray(finalHistory) && finalHistory.filter((entry) => asRecord(entry)?.["correction_id"] === intent.correction_id).length === 1
  const generationOk =
    generationCheck.data.status === "applied" &&
    finalOutput !== null &&
    // 방금 쓴 버전 그대로다 — 확정 뒤 다른 쓰기가 끼어들지 않았다.
    outputRevisionOf(finalOutput) === outputRevisionOf(nextOutput) &&
    finalOutput[PENDING_KEY] === undefined &&
    recordedOnce &&
    // 생성 기록의 현행 콘텐츠 두 곳이 모두 장소와 같은 보정본이다.
    storedContentHash(finalOutput["generated"]) === intent.after_hash &&
    storedContentHash(finalOutput["after"]) === intent.after_hash
  return placeOk && seoOk && generationOk ? null : "verify"
}

// 두 시각이 같은 순간인지 — 문자열이 아니라 시각으로, 마이크로초까지 비교한다.
// 같은 순간을 코드는 "…05.882Z"로, DB(timestamptz)는 "…05.882+00:00"으로 돌려준다. 문자열로 비교하면
// 보정이 세 곳에 모두 반영된 뒤에도 재확인이 실패한다 (2026-11-10 첫 실행에서 실제로 그랬다).
// Date.parse만으로 비교하면 밀리초 아래가 버려져, 마이크로초만 다른 두 시각(다른 게시 시각)이 같다고 판정된다.
// 해석되지 않는 값은 어떤 시각과도 같지 않다.
export function sameInstant(a: unknown, b: unknown): boolean {
  const left = toEpochMicros(a)
  return left !== null && left === toEpochMicros(b)
}

const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/

function toEpochMicros(value: unknown): bigint | null {
  if (typeof value !== "string") {
    return null
  }
  const match = ISO_INSTANT.exec(value)
  if (match === null) {
    return null
  }
  const [, wholeSeconds, fraction, zone] = match
  // 소수 초를 뗀 시각을 해석한다 — 초 단위 정수가 나온다. 소수 초는 6자리(마이크로초)로 맞춰 따로 더한다.
  const epochMs = Date.parse(`${wholeSeconds ?? ""}${zone ?? ""}`)
  if (Number.isNaN(epochMs)) {
    return null
  }
  return BigInt(epochMs) * 1000n + BigInt((fraction ?? "").padEnd(6, "0"))
}

// 저장된 콘텐츠의 해시 — 형식이 스키마에 맞지 않으면 null (어떤 해시와도 같지 않다).
function storedContentHash(value: unknown): string | null {
  try {
    parseAiProviderOutput(value)
  } catch {
    return null
  }
  return computePlaceContentHash(value as never)
}

// 이 요청이 이미 끝까지 반영됐는지 — 쓰기 없이 판정한다.
// 요청의 대상·index·질문·답·보정 전 해시와 정확히 맞는 완료 이력이 1건이고, 지금의 장소·생성 기록·SEO 페이지가 그 기록과 일치해야 한다.
function isAlreadyCompleted(
  wrapper: Wrapper,
  input: PublishedFaqCorrectionInput,
  now: Readonly<{ currentHash: string; seoPage: Readonly<{ id: string; path: string | null; published_at: string | null; last_modified_at: string | null }> }>,
): boolean {
  const history = wrapper[HISTORY_KEY]
  if (!Array.isArray(history)) {
    return false
  }
  const matching = history
    .map((entry) => asRecord(entry))
    .filter(
      (entry) =>
        entry !== null &&
        entry["place_id"] === input.placeId &&
        entry["faq_index"] === input.faqIndex &&
        entry["question"] === input.expectedQuestion &&
        entry["answer_after"] === input.answer &&
        entry["before_hash"] === input.expectedContentHash,
    )
  const record = matching.length === 1 ? matching[0] : null
  if (record === null || record === undefined) {
    return false
  }
  return (
    record["after_hash"] === now.currentHash &&
    record["seo_page_id"] === now.seoPage.id &&
    record["path"] === now.seoPage.path &&
    sameInstant(record["seo_published_at"], now.seoPage.published_at) &&
    sameInstant(record["corrected_at"], now.seoPage.last_modified_at) &&
    storedContentHash(wrapper["generated"]) === now.currentHash &&
    storedContentHash(wrapper["after"]) === now.currentHash
  )
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
    typeof record["seo_published_at"] !== "string" ||
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
