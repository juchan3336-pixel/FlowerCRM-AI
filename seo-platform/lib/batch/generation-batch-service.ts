import "server-only"

// Batch 생성 오케스트레이션 — 클라이언트가 순차 호출하는 단건 처리 구조.
// 한 액션 호출은 정확히 1개 item만 처리한다 (함수 시간 제한 회피 + 진행률 표시 + 중단·재개 자연 구현).
// 모든 전이는 repository의 조건부 UPDATE로 멱등하며, 실패 정책은 A(해당 장소만 중단, 다음 계속)다.
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { BatchRunItemRow, BatchRunRow, Json, PlaceRow } from "@/types/database"
import { evaluateGenerationQuality, runPlaceAiGeneration } from "@/lib/ai/generation-runner"
import { BATCH_RETRY_ERROR_CODE_PREFIX, BATCH_RETRY_FAILURE_MESSAGE_PREFIX } from "@/lib/ai/retry-policy"

// 복구 재시도가 이미 소진되어 실행하지 않은 item의 사유 코드.
// "retry-" 접두를 쓰지 않는다 — 차단은 소진이 아니므로 소진 흔적으로 읽히면 안 된다.
const RETRY_BLOCKED_REASON = "quality-fail-retry-blocked"
import { actualCostSoFar, planBatchStart, summarizeBatchTotals, totalsToJson, type BatchStartPlan } from "./batch-view"
import { buildBatchAvoidance, isAvoidanceSourceItem, type BatchAvoidanceContext, type BatchAvoidanceSource } from "./batch-avoidance"
import { decideBatchCandidate, type BatchCandidateDecision } from "./candidate-policy"
import { DEFAULT_MAX_COST_USD, SKIP_REASON_COST_LIMIT, shouldSkipRemainingForCost } from "./cost-policy"
import { decideBatchItemOutcome, forbiddenVocabularyTerms as forbiddenTermsFromIssues, FORBIDDEN_VOCABULARY_AFTER_RETRY_REASON, FORBIDDEN_VOCABULARY_REASON } from "./quality-policy"
import { createSupabaseBatchRepository } from "./supabase-batch-repository"
import type { BatchRunSettings } from "./types"

export type BatchCandidateView = {
  readonly placeId: string
  readonly name: string
  readonly region: string
  readonly address: string | null
  readonly decision: BatchCandidateDecision
}

// 선택 화면용: 공식 검증(verified)된 draft 장소들의 하드 조건 판정 결과.
export async function listBatchGenerationCandidates(): Promise<readonly BatchCandidateView[]> {
  const client = createSupabaseServiceRoleClient()
  const { data: places, error } = await client
    .from("places")
    .select("*")
    .eq("status", "draft")
    .eq("official_verification_status", "verified")
    .order("verified_at", { ascending: false })
    .limit(50)
  if (error !== null) {
    throw new Error(`Failed to list batch candidates: ${error.message}`)
  }
  const views: BatchCandidateView[] = []
  for (const place of places) {
    views.push({
      placeId: place.id,
      name: place.name,
      region: [place.region, place.district].filter((v) => v !== null).join(" "),
      address: place.address,
      decision: await decideCandidateWithContext(place),
    })
  }
  return views
}

async function decideCandidateWithContext(place: PlaceRow): Promise<BatchCandidateDecision> {
  const client = createSupabaseServiceRoleClient()
  const [{ count: generationCount }, slugDup, seoPage] = await Promise.all([
    client.from("ai_generations").select("id", { count: "exact", head: true }).eq("place_id", place.id),
    place.slug === null
      ? Promise.resolve({ count: 0 })
      : client.from("places").select("id", { count: "exact", head: true }).eq("slug", place.slug).neq("id", place.id),
    place.slug === null
      ? Promise.resolve({ count: 0 })
      : client.from("seo_pages").select("id", { count: "exact", head: true }).eq("path", `/places/${place.slug}`),
  ])
  return decideBatchCandidate({
    place,
    generationCount: generationCount ?? 0,
    slugDuplicateCount: slugDup.count ?? 0,
    seoPagePathExists: (seoPage.count ?? 0) > 0,
  })
}

export type StartGenerationBatchResult =
  | { readonly kind: "started"; readonly batchId: string }
  | { readonly kind: "already-running" }
  | { readonly kind: "invalid"; readonly plan: Extract<BatchStartPlan, { kind: "invalid" }> }

export async function startGenerationBatch(input: Readonly<{ placeIds: readonly string[]; createdBy: string | null; officialCheckApproved: boolean; maxCostUsd?: number }>): Promise<StartGenerationBatchResult> {
  const client = createSupabaseServiceRoleClient()
  const { data: places, error } = await client.from("places").select("*").in("id", [...new Set(input.placeIds)])
  if (error !== null) {
    throw new Error(`Failed to load batch places: ${error.message}`)
  }
  const decisions = new Map<string, BatchCandidateDecision>()
  for (const place of places) {
    decisions.set(place.id, await decideCandidateWithContext(place))
  }
  const usdKrwRate = Number.parseFloat(process.env["AI_COST_USD_KRW_RATE"] ?? "") || 1400
  // 승인 Batch(PR-B)는 approved_max_cost_usd를 넘겨 그 값이 상한이 된다. 브라우저 Batch는 미전달 → 글로벌 기본값 유지.
  const maxCostUsd = input.maxCostUsd ?? DEFAULT_MAX_COST_USD
  const plan = planBatchStart({
    placeIds: input.placeIds,
    decisions,
    officialCheckApproved: input.officialCheckApproved,
    maxCostUsd,
    usdKrwRate,
  })
  if (plan.kind === "invalid") {
    return { kind: "invalid", plan }
  }

  const settings: BatchRunSettings = {
    max_items: plan.placeIds.length,
    max_cost_usd: maxCostUsd,
    warn_policy: "auto-ready",
    usd_krw_rate: usdKrwRate,
    official_check_approved: true,
    estimated_tokens: plan.estimate.estimatedTokens,
    estimated_cost_usd: plan.estimate.estimatedCostUsd,
  }
  const repository = createSupabaseBatchRepository()
  const byId = new Map(places.map((place) => [place.id, place]))
  const created = await repository.createRun({
    kind: "generate",
    createdBy: input.createdBy,
    settings,
    items: plan.placeIds.map((placeId, index) => {
      const place = byId.get(placeId)
      return {
        placeId,
        sequence: index + 1,
        inputSnapshot: {
          name: place?.name ?? null,
          address: place?.address ?? null,
          phone: place?.phone ?? null,
          slug: place?.slug ?? null,
          official_verification_status: place?.official_verification_status ?? null,
        },
      }
    }),
  })
  if (created.kind === "already-running") {
    return { kind: "already-running" }
  }
  return { kind: "started", batchId: created.run.id }
}

export type ProcessNextResult = {
  readonly runStatus: BatchRunRow["status"]
  readonly done: boolean
  readonly processed: { readonly placeId: string; readonly status: BatchRunItemRow["status"]; readonly reason: string | null } | null
}

// 다음 queued/interrupted item 1건 처리. 없으면 run을 completed로 닫는다(집계 확정).
// options.trigger는 감사용(이벤트 detail) — 처리 로직에는 영향이 없다.
export async function processNextGenerationItem(batchId: string, options?: Readonly<{ trigger?: "auto" | "resume"; actor?: string | null }>): Promise<ProcessNextResult> {
  const repository = createSupabaseBatchRepository()
  const run = await repository.getRun(batchId)
  if (run?.kind !== "generate") {
    return { runStatus: "failed", done: true, processed: null }
  }
  if (run.status !== "running") {
    return { runStatus: run.status, done: true, processed: null }
  }
  const settings = run.settings as unknown as BatchRunSettings

  // 비용 상한: 다음 item 시작 전 판정 — 도달 시 잔여 skipped_cost_limit.
  const itemsBefore = await repository.listItems(batchId)
  if (shouldSkipRemainingForCost(actualCostSoFar(itemsBefore), settings.max_cost_usd)) {
    await repository.skipRemainingItems(batchId, "generate", SKIP_REASON_COST_LIMIT)
    return finalize(repository, batchId)
  }

  const item = await repository.claimNextItem(batchId, "generate", "generating", { trigger: options?.trigger ?? "auto", actor: options?.actor ?? null })
  if (item === null) {
    return finalize(repository, batchId)
  }

  // 같은 Batch에서 앞서 완료된 item(작은 sequence, 종료 상태)의 audit·키워드를 회피 입력으로 되돌린다 (PR-S3).
  // 앞선 item은 전부 종료 상태라 재개·새로고침 후에도 같은 컨텍스트가 재구성된다 (결정성).
  const batchAvoidance = await loadBatchAvoidance(itemsBefore, item.sequence)

  const outcome = await processClaimedItem(repository, item, batchAvoidance)
  return { runStatus: "running", done: false, processed: { placeId: item.place_id, status: outcome.status, reason: outcome.reason } }
}

async function loadBatchAvoidance(items: readonly BatchRunItemRow[], currentSequence: number): Promise<BatchAvoidanceContext> {
  const priorItems = items
    .filter((item) => isAvoidanceSourceItem({ sequence: item.sequence, status: item.status, generationId: item.retry_generation_id ?? item.generation_id }, currentSequence))
    .sort((a, b) => a.sequence - b.sequence)
  const generationIds = priorItems.map((item) => item.retry_generation_id ?? item.generation_id ?? "")
  const { listGenerationAvoidanceSources } = await import("@/lib/ai/supabase-repository")
  const sourcesById = await listGenerationAvoidanceSources(generationIds)
  const sources: BatchAvoidanceSource[] = priorItems.map((item) => {
    const source = sourcesById.get(item.retry_generation_id ?? item.generation_id ?? "")
    const snapshot = item.input_snapshot
    const name = typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot) ? (snapshot as Record<string, unknown>)["name"] : null
    return {
      audit: source?.audit ?? null,
      placeName: typeof name === "string" ? name : "",
      region: null,
      keywords: source?.keywords ?? [],
    }
  })
  return buildBatchAvoidance(sources)
}

async function processClaimedItem(
  repository: ReturnType<typeof createSupabaseBatchRepository>,
  item: BatchRunItemRow,
  batchAvoidance: BatchAvoidanceContext,
): Promise<{ status: BatchRunItemRow["status"]; reason: string | null }> {
  try {
    // 1) 생성 (재개 시 기존 generation 재사용 — 중복 생성 금지)
    let generationId = item.generation_id
    let tokensInput = item.tokens_input ?? 0
    let tokensOutput = item.tokens_output ?? 0
    let costUsd = item.cost_usd ?? 0
    if (generationId === null) {
      const generated = await runPlaceAiGeneration({ placeId: item.place_id, batchAvoidance })
      if (generated.kind !== "generated") {
        const reason = generated.kind === "failed" || generated.kind === "misconfigured" ? generated.errorCode : generated.kind
        await repository.recordItemResult(item.id, { status: "failed", currentStep: null, lastErrorCode: reason, lastErrorMessage: `생성 실패: ${reason}`, finished: true })
        return { status: "failed", reason }
      }
      generationId = generated.generationId
      tokensInput += generated.usage?.input_tokens ?? 0
      tokensOutput += generated.usage?.output_tokens ?? 0
      costUsd += generated.estimatedCostUsd ?? 0
    }

    // 2) 품질 검사
    await repository.touchItemStep(item.id, "checking")
    const quality = await evaluateGenerationQuality(generationId)
    if (quality === null) {
      await repository.recordItemResult(item.id, { status: "needs_review", currentStep: null, generationId, tokensInput, tokensOutput, costUsd, lastErrorCode: "quality-missing", lastErrorMessage: "품질 성적표 계산 실패 — 수동 확인 필요", finished: true })
      return { status: "needs_review", reason: "quality-missing" }
    }
    let outcome = decideBatchItemOutcome(quality, "auto-ready")
    let retryGenerationId: string | null = null
    let finalQuality = quality

    // 3) repeat:faq FAIL / 업종 금지 어휘 FAIL — 제어 재시도 1회 (기존 retry 정책 재사용, 원본 보존)
    if (outcome.kind === "retry-faq" || outcome.kind === "retry-vocabulary") {
      const isVocabularyRetry = outcome.kind === "retry-vocabulary"
      const forbiddenTerms = forbiddenTermsFromIssues(quality.issues)
      const [{ getAiGenerationRetryLookup, countConsumedQualityFailRetriesOf }, { decideQualityFailRetry, faqPairOfFailedGeneration, isRetryAttemptConsumed }] = await Promise.all([
        import("@/lib/ai/supabase-repository"),
        import("@/lib/ai/retry-policy"),
      ])
      const [lookup, consumedRetryCount] = await Promise.all([getAiGenerationRetryLookup(generationId), countConsumedQualityFailRetriesOf(generationId)])
      // 단건 액션과 같은 guard — 이 원본의 복구 재시도가 이미 소진됐으면 Batch도 재시도하지 않는다.
      const decision = decideQualityFailRetry({
        quality: { status: quality.status, issues: quality.issues },
        consumedRetryCount,
        isRetryGeneration: lookup?.isRetryGeneration ?? false,
      })
      if (!decision.allowed) {
        // 업종 금지 어휘는 검토로 넘길 수 없다 — 재시도를 못 쓰면 그대로 item을 닫는다.
        // 그 외 콘텐츠 FAIL은 preview를 보존하고 사용자 검토 대상으로 남긴다 (정책 v1.1).
        const blockedStatus = isVocabularyRetry ? ("failed" as const) : ("needs_review" as const)
        const blockedReason = isVocabularyRetry ? FORBIDDEN_VOCABULARY_REASON : RETRY_BLOCKED_REASON
        await repository.recordItemResult(item.id, {
          status: blockedStatus,
          currentStep: null,
          generationId,
          qualityStatus: quality.status,
          qualityIssues: quality.issues,
          tokensInput,
          tokensOutput,
          costUsd,
          lastErrorCode: blockedReason,
          lastErrorMessage: isVocabularyRetry
            ? `업종에 맞지 않는 표현이 있어 적용하지 않음 (${forbiddenTerms.join(", ")}) — 복구 재시도는 이미 소진됨 (${decision.blockedBy})`
            : `복구 재시도가 이미 소진되어 실행하지 않음 (${decision.blockedBy})`,
          finished: true,
        })
        return { status: blockedStatus, reason: blockedReason }
      }
      const bannedPair = lookup === null ? null : faqPairOfFailedGeneration({ contentPlanFaqKeys: lookup.contentPlanFaqKeys, faqQuestions: lookup.faqQuestions, mode: lookup.mode })
      const retried = await runPlaceAiGeneration({
        placeId: item.place_id,
        batchAvoidance,
        retry: {
          of: generationId,
          reason: outcome.reason,
          bannedFaqPairs: bannedPair === null ? [] : [bannedPair],
          // 재시도 프롬프트에 무엇이 걸렸는지 넘긴다 — 같은 표현을 다시 쓰지 못하게.
          ...(forbiddenTerms.length === 0 ? {} : { forbiddenTerms }),
        },
      })
      if (retried.kind !== "generated") {
        const reason = retried.kind === "failed" || retried.kind === "misconfigured" ? retried.errorCode : retried.kind
        // provider 호출이 시작된 실패만 "1회 소진"이다 — 소진일 때만 retry- 접두 코드·소진 메시지를 남겨
        // guard가 generation 없이도 구조적으로 읽게 한다. 호출 전 차단(misconfigured/busy)은 재시도 1회를 남긴다.
        const consumed = isRetryAttemptConsumed(retried.kind)
        await repository.recordItemResult(item.id, {
          status: "failed",
          currentStep: null,
          generationId,
          tokensInput,
          tokensOutput,
          costUsd,
          lastErrorCode: consumed ? `${BATCH_RETRY_ERROR_CODE_PREFIX}${reason}` : reason,
          lastErrorMessage: consumed ? `${BATCH_RETRY_FAILURE_MESSAGE_PREFIX}${reason}` : `복구 재시도 시작 불가: ${reason}`,
          finished: true,
        })
        return { status: "failed", reason }
      }
      retryGenerationId = retried.generationId
      tokensInput += retried.usage?.input_tokens ?? 0
      tokensOutput += retried.usage?.output_tokens ?? 0
      costUsd += retried.estimatedCostUsd ?? 0
      const retryQuality = retried.quality
      if (retryQuality === null || retryQuality.status === "fail") {
        // 재시도도 FAIL이면 해당 장소만 중단 (추가 재시도 없음).
        // 금지 어휘가 재시도 뒤에도 남았으면 그 사실이 드러나는 코드로 닫는다.
        const stillForbidden = forbiddenTermsFromIssues(retryQuality?.issues ?? [])
        const reason = stillForbidden.length > 0 ? FORBIDDEN_VOCABULARY_AFTER_RETRY_REASON : "retry-quality-fail"
        await repository.recordItemResult(item.id, {
          status: "failed",
          currentStep: null,
          generationId,
          retryGenerationId,
          qualityStatus: "fail",
          qualityIssues: retryQuality?.issues ?? [],
          tokensInput,
          tokensOutput,
          costUsd,
          lastErrorCode: reason,
          lastErrorMessage: stillForbidden.length > 0 ? `복구 재시도 후에도 업종에 맞지 않는 표현이 남음 (${stillForbidden.join(", ")})` : "복구 재시도도 Quality FAIL",
          finished: true,
        })
        return { status: "failed", reason }
      }
      finalQuality = retryQuality
      outcome = decideBatchItemOutcome(retryQuality, "auto-ready")
      if (outcome.kind === "retry-faq" || outcome.kind === "retry-vocabulary") {
        // 이론상 도달 불가(재시도 결과가 다시 retry 대상일 수 없음) — 방어적으로 needs_review.
        outcome = { kind: "needs-review", reason: "warn-other" }
      }
    }

    const effectiveGenerationId = retryGenerationId ?? generationId
    const qualityPatch = {
      generationId,
      retryGenerationId,
      qualityStatus: finalQuality.status,
      qualityIssues: finalQuality.issues as unknown as Json,
      tokensInput,
      tokensOutput,
      costUsd,
    }

    // 4) 분기: auto-ready → apply + seo ready / needs_review → preview 보존
    if (outcome.kind === "auto-ready") {
      await repository.touchItemStep(item.id, "applying")
      const [{ applyAiGeneration }, { createSupabasePlaceSeoGenerationRepository }, { generateSinglePlaceSeoPage }, { createSupabaseAiRepository }] = await Promise.all([
        import("@/lib/ai/service"),
        import("@/lib/seo-pages/supabase-place-generation"),
        import("@/lib/seo-pages/single-place-generation"),
        import("@/lib/ai/supabase-repository"),
      ])
      await applyAiGeneration({ generationId: effectiveGenerationId, repository: createSupabaseAiRepository() })
      const seoResult = await generateSinglePlaceSeoPage({ repository: createSupabasePlaceSeoGenerationRepository(), placeId: item.place_id })
      if (seoResult.kind === "blocked" || seoResult.kind === "missing-place") {
        await repository.recordItemResult(item.id, { status: "failed", currentStep: null, ...qualityPatch, lastErrorCode: "seo-page-blocked", lastErrorMessage: `게시 준비 차단: ${seoResult.kind}`, finished: true })
        return { status: "failed", reason: "seo-page-blocked" }
      }
      await repository.recordItemResult(item.id, { status: outcome.targetStatus, currentStep: null, ...qualityPatch, finished: true })
      return { status: outcome.targetStatus, reason: null }
    }

    // 업종 금지 어휘가 남아 있으면 검토 대기로 넘기지 않는다 — 위 재시도 경로에서 대부분 걸러지지만,
    // 어느 경로로 오든 이 문구가 needs_review로 저장되는 일이 없도록 마지막에 한 번 더 막는다.
    const remainingForbidden = forbiddenTermsFromIssues(finalQuality.issues)
    if (remainingForbidden.length > 0) {
      const reason = retryGenerationId === null ? FORBIDDEN_VOCABULARY_REASON : FORBIDDEN_VOCABULARY_AFTER_RETRY_REASON
      await repository.recordItemResult(item.id, {
        status: "failed",
        currentStep: null,
        ...qualityPatch,
        lastErrorCode: reason,
        lastErrorMessage: `업종에 맞지 않는 표현이 있어 적용하지 않음 (${remainingForbidden.join(", ")})`,
        finished: true,
      })
      return { status: "failed", reason }
    }

    // 콘텐츠 FAIL(outcome.kind==="failed" 포함)도 preview가 보존되므로 needs_review로 수용한다 —
    // item의 failed는 시스템 오류·검증 불가 전용 (docs/content-quality-policy.md v1.1).
    await repository.recordItemResult(item.id, { status: "needs_review", currentStep: null, ...qualityPatch, lastErrorCode: outcome.reason, lastErrorMessage: "자동 ready 조건 미충족 — 사용자 확인 필요", finished: true })
    return { status: "needs_review", reason: outcome.reason }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await repository.recordItemResult(item.id, { status: "failed", currentStep: null, lastErrorCode: "unexpected", lastErrorMessage: message.slice(0, 500), finished: true })
    return { status: "failed", reason: "unexpected" }
  }
}

async function finalize(repository: ReturnType<typeof createSupabaseBatchRepository>, batchId: string): Promise<ProcessNextResult> {
  const items = await repository.listItems(batchId)
  const totals = summarizeBatchTotals(items)
  await repository.finishRun(batchId, "completed", totalsToJson(totals))
  const run = await repository.getRun(batchId)
  return { runStatus: run?.status ?? "completed", done: true, processed: null }
}

export async function cancelGenerationBatch(batchId: string, actor?: string | null): Promise<void> {
  const repository = createSupabaseBatchRepository()
  await repository.recordEvent({ batchId, eventType: "run_cancel_requested", actor: actor ?? null, detail: { cancelled_by_user: true } })
  await repository.skipRemainingItems(batchId, "generate", "cancelled-by-user")
  const items = await repository.listItems(batchId)
  await repository.finishRun(batchId, "cancelled", totalsToJson(summarizeBatchTotals(items)))
}
