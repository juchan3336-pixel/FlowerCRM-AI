import "server-only"

// needs_review 해소 오케스트레이션 — 관리자가 검토·보정한 generation을 정식 상태 전이로 ready까지 올린다.
// 모든 전이는 repository의 조건부 UPDATE를 쓰고, 어떤 단계도 테이블을 임의로 직접 수정하지 않는다.
// 실패하면 item을 needs_review로 되돌려 부분 상태(processing 잔류)를 남기지 않는다.
import { assertAiOutputAllowed, parseAiProviderOutput } from "@/lib/ai/guardrails"
import { evaluateGenerationQuality } from "@/lib/ai/generation-runner"
import {
  applyResolutionEdits,
  buildManualReviewAudit,
  decideNeedsReviewResolution,
  type NeedsReviewResolutionBlock,
  type ResolutionFieldEdits,
  type ResolvableField,
} from "./needs-review-resolution"
import { createSupabaseBatchRepository } from "./supabase-batch-repository"
import type { AiGeneratedSeoContent } from "@/lib/ai/types"
import type { Json } from "@/types/database"

export type ResolveNeedsReviewInput = {
  readonly itemId: string
  readonly generationId: string
  readonly edits: ResolutionFieldEdits
  readonly confirmed: boolean
  readonly actor: string | null
}

export type ResolveNeedsReviewResult =
  | { readonly kind: "resolved"; readonly path: string; readonly changedFields: readonly ResolvableField[]; readonly itemStatus: "ready" | "warn_ready" }
  | { readonly kind: "blocked"; readonly reason: NeedsReviewResolutionBlock }
  | { readonly kind: "quality-not-pass"; readonly status: "pass" | "warn" | "fail" | "unknown" }
  | { readonly kind: "invalid-field"; readonly field: ResolvableField }
  | { readonly kind: "failed"; readonly reason: string }

// 관리자 명시 확인이 있는 해소 경로는 warn을 허용한다 (자동 경로의 warn_policy=auto-ready와 같은 수준의 인간 승인).
// fail·평가 불가만 차단 — 금지 표현 등 fail 수준 문제는 사람 확인만으로 넘을 수 없다.
function hasBlockingQuality(quality: Readonly<{ status: string; issues: readonly unknown[] }> | null): boolean {
  if (quality === null || quality.status === "fail") {
    return true
  }
  return quality.issues.some((issue) => typeof issue === "object" && issue !== null && (issue as Record<string, unknown>)["level"] === "fail")
}

// item에 남는 사유 코드 — reason-labels에 한글 라벨이 등록되어 있다.
const REASON_QUALITY_NOT_PASS = "review-quality-not-pass"
const REASON_SEO_PAGE_BLOCKED = "review-seo-page-blocked"
const REASON_UNEXPECTED = "review-unexpected"

export async function resolveNeedsReviewItem(input: ResolveNeedsReviewInput): Promise<ResolveNeedsReviewResult> {
  const [{ createSupabaseAiRepository, applyManualGenerationEdits }, { createSupabaseServiceRoleClient }] = await Promise.all([
    import("@/lib/ai/supabase-repository"),
    import("@/lib/supabase/server"),
  ])
  const repository = createSupabaseBatchRepository()
  const client = createSupabaseServiceRoleClient()

  const item = await repository.getItem(input.itemId)
  if (item === null) {
    return { kind: "blocked", reason: "item-not-needs-review" }
  }
  const aiRepository = createSupabaseAiRepository()
  const generation = await aiRepository.findAiGenerationById(input.generationId)
  const place = await aiRepository.findPlaceById(item.place_id)
  const { data: seoPage } = await client.from("seo_pages").select("status").eq("page_type", "place").eq("place_id", item.place_id).maybeSingle()

  if (generation === undefined || place === undefined) {
    return { kind: "blocked", reason: "generation-mismatch" }
  }

  // 1) 관리자·대상·현재 상태 재검증 — 상태를 바꾸기 전에 전부 확인한다.
  const decision = decideNeedsReviewResolution({
    confirmed: input.confirmed,
    itemStatus: item.status,
    itemPlaceId: item.place_id,
    itemGenerationIds: [item.generation_id, item.retry_generation_id],
    generationId: input.generationId,
    generationPlaceId: generation.place_id,
    generationStatus: generation.status,
    placeStatus: place.status,
    seoPageStatus: seoPage?.status ?? null,
  })
  if (!decision.allowed) {
    return { kind: "blocked", reason: decision.blockedBy }
  }

  // 2) 허용된 필드만 미리 반영해 본다 (형식 오류는 상태를 건드리기 전에 차단).
  let nextContent: AiGeneratedSeoContent | null = null
  let changedFields: readonly ResolvableField[] = []
  let beforeFields: Partial<AiGeneratedSeoContent> = {}
  if (decision.mode === "apply") {
    const current = (generation.output as AiGeneratedSeoContent | null) ?? null
    if (current === null) {
      return { kind: "blocked", reason: "generation-not-resolvable" }
    }
    const edited = applyResolutionEdits(current, input.edits)
    if (edited.kind === "invalid") {
      return { kind: "invalid-field", field: edited.field }
    }
    if (edited.changedFields.length > 0) {
      try {
        // 생성 경로와 같은 스키마·가드레일을 통과해야 한다 (전화·이메일·가격 누출, 형식 오류 차단).
        assertAiOutputAllowed(parseAiProviderOutput(edited.content), place)
      } catch {
        return { kind: "invalid-field", field: edited.changedFields[0] ?? "body" }
      }
      nextContent = edited.content
      changedFields = edited.changedFields
      beforeFields = edited.before
    }
  }

  // 3) needs_review → processing (조건부 claim). 0행이면 다른 호출이 이미 가져갔거나 상태가 바뀐 것 — 중복 클릭 방지.
  const claimed = await repository.claimItemForReview(input.itemId, input.actor)
  if (claimed === null) {
    return { kind: "blocked", reason: "item-not-needs-review" }
  }

  try {
    if (decision.mode === "apply") {
      // 4) 보정 반영 → 품질 재평가 → PASS가 아니면 apply 없이 중단.
      if (nextContent !== null) {
        const edited = await applyManualGenerationEdits({
          generationId: input.generationId,
          content: nextContent,
          audit: buildManualReviewAudit({ resolvedBy: input.actor ?? "unknown", changedFields, before: beforeFields }),
        })
        if (!edited) {
          await revertToNeedsReview(repository, input.itemId, REASON_UNEXPECTED, "보정 저장에 실패했습니다 (generation이 preview가 아님)")
          return { kind: "failed", reason: REASON_UNEXPECTED }
        }
      }
      const quality = await evaluateGenerationQuality(input.generationId)
      if (hasBlockingQuality(quality)) {
        await revertToNeedsReview(repository, input.itemId, REASON_QUALITY_NOT_PASS, "재평가가 FAIL이어서 게시 준비를 중단했습니다", quality)
        return { kind: "quality-not-pass", status: quality?.status ?? "unknown" }
      }

      // 5) 기존 apply 코어 재사용 → 6) places 콘텐츠 적용
      await repository.touchItemStep(input.itemId, "applying")
      const { applyAiGeneration } = await import("@/lib/ai/service")
      await applyAiGeneration({ generationId: input.generationId, repository: aiRepository })
    }

    // 7) seo_pages ready 생성 (이미 있으면 기존 행 확인 — 중복 생성 없음)
    const [{ createSupabasePlaceSeoGenerationRepository }, { generateSinglePlaceSeoPage }] = await Promise.all([
      import("@/lib/seo-pages/supabase-place-generation"),
      import("@/lib/seo-pages/single-place-generation"),
    ])
    const seoResult = await generateSinglePlaceSeoPage({ repository: createSupabasePlaceSeoGenerationRepository(), placeId: item.place_id })
    if (seoResult.kind === "blocked" || seoResult.kind === "missing-place") {
      // apply는 끝났고 seo_page만 남은 부분 상태 — needs_review로 되돌려 재개 경로(resume-seo-page)로 이어서 해소한다.
      await revertToNeedsReview(repository, input.itemId, REASON_SEO_PAGE_BLOCKED, `게시 준비 차단: ${seoResult.kind}`)
      return { kind: "failed", reason: REASON_SEO_PAGE_BLOCKED }
    }

    // 8) processing → ready/warn_ready (조건부 전이 + item_result_recorded 이벤트는 repository가 기록)
    // warn이 남아 있으면 warn_ready로 기록해 자동 경로와 같은 라벨로 구분한다 — 둘 다 게시 배치의 claim 대상이다.
    const finalQuality = await evaluateGenerationQuality(input.generationId)
    const itemStatus: "ready" | "warn_ready" = finalQuality !== null && (finalQuality.status !== "pass" || finalQuality.issues.length > 0) ? "warn_ready" : "ready"
    await repository.recordItemResult(input.itemId, {
      status: itemStatus,
      currentStep: null,
      generationId: input.generationId,
      qualityStatus: finalQuality?.status ?? "pass",
      qualityIssues: finalQuality?.issues ?? [],
      lastErrorCode: null,
      lastErrorMessage: null,
      finished: true,
    })
    return { kind: "resolved", path: seoResult.path, changedFields, itemStatus }
  } catch (error) {
    await revertToNeedsReview(repository, input.itemId, REASON_UNEXPECTED, error instanceof Error ? error.message.slice(0, 300) : "unknown")
    return { kind: "failed", reason: REASON_UNEXPECTED }
  }
}

// 실패 복귀 — processing에서만 전이하는 recordItemResult를 그대로 쓴다 (직접 UPDATE 없음).
async function revertToNeedsReview(
  repository: ReturnType<typeof createSupabaseBatchRepository>,
  itemId: string,
  code: string,
  message: string,
  quality?: Readonly<{ status: string; issues: readonly unknown[] }> | null,
): Promise<void> {
  await repository.recordItemResult(itemId, {
    status: "needs_review",
    currentStep: null,
    ...(quality == null ? {} : { qualityStatus: quality.status as "pass" | "warn" | "fail", qualityIssues: quality.issues as unknown as Json }),
    lastErrorCode: code,
    lastErrorMessage: message,
    finished: true,
  })
}
