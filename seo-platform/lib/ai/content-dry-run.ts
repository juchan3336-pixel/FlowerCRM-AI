// 비장례 ContentMode 무저장 실측(Dry-run) — Preview에서 실제 모델로 생성해 보되 아무것도 저장하지 않는다.
//
// 왜 필요한가: celebration·corporate-celebration은 PR #59/#60에서 구조와 검사만 만들었고
// 실제 모델 출력을 한 번도 본 적이 없다. 그렇다고 확인을 위해 Production 후보 자격(funeral-only)을
// 임시로 열면, 되돌리기 전에 무언가 저장·게시될 위험이 생긴다.
//
// 그래서 자격은 그대로 두고, 생성 계층만 그대로 빌려 쓴다:
// generateAiPreview → 실제 프롬프트·제목·키워드·FAQ 다양화 → 실제 품질 검사 → 실제 재시도 정책.
// 다른 점은 저장소뿐이다. 아래 in-memory 저장소는 생성 결과를 메모리에만 담고 어떤 쓰기도 하지 않는다.
import { evaluateGeneratedContent, type QualityReport, type RecentContentSnapshot } from "./content-quality"
import { contentModeForCategory, type ContentMode } from "./content-mode"
import { forbiddenTermsOf, findForbiddenModeVocabulary, type ForbiddenVocabularyFinding } from "./mode-vocabulary"
import { generateAiPreview } from "./service"
import type { AiGeneratedSeoContent, AiGenerationRecord, AiProvider, AiRepository, NewAiGeneration } from "./types"
import type { SyncedPlace } from "@/lib/sync/types"

// 실측 대상은 코드에 고정한다 — 요청 본문으로 임의의 장소를 지정할 수 없다.
// 2026-08-01 배치에서 실제로 잘못 생성됐던 두 곳이라, 같은 장소가 이제 제대로 나오는지 보는 것이 목적이다.
export const CONTENT_DRY_RUN_ALLOWLIST: Readonly<Record<string, ContentMode>> = {
  "38b4e03d-725d-4a7d-95eb-0d7d01e6e2dc": "celebration", // 라마다스위츠 거제호텔
  "b69fd464-67fd-4548-a82d-c15c23ffa4f1": "corporate-celebration", // KCC 울산공장
}

export type DryRunPlace = Pick<
  SyncedPlace,
  "id" | "name" | "category" | "city" | "district" | "address" | "homepage" | "status" | "slug"
> & {
  readonly official_verification_status: string | null
  readonly exclusion_reason: string | null
  readonly verification_source_urls: readonly string[]
}

export type DryRunBlockReason =
  | "not-allowlisted"
  | "place-missing"
  | "not-draft"
  | "not-verified"
  | "excluded"
  | "category-unsupported"
  | "mode-mismatch"
  | "verification-source-missing"

export type DryRunAttempt = {
  readonly kind: "initial" | "retry"
  readonly content: AiGeneratedSeoContent
  readonly quality: QualityReport
  readonly forbidden: readonly ForbiddenVocabularyFinding[]
  readonly tokensInput: number | null
  readonly tokensOutput: number | null
  readonly costUsd: number | null
  readonly durationMs: number
}

export type ContentDryRunResult =
  | { readonly kind: "blocked"; readonly reason: DryRunBlockReason; readonly placeId: string }
  | {
      readonly kind: "completed"
      readonly placeId: string
      readonly name: string
      readonly category: string
      readonly contentMode: ContentMode
      readonly model: string
      readonly attempts: readonly DryRunAttempt[]
      readonly retried: boolean
      readonly finalStatus: "pass" | "warn" | "failed"
      // 이 실행이 남긴 것이 없음을 응답에 명시한다 (감사·오해 방지).
      readonly stored: false
      readonly applied: false
      readonly published: false
    }

export type ContentDryRunDependencies = {
  readonly provider: AiProvider
  readonly model: string
  readonly loadPlace: (placeId: string) => Promise<DryRunPlace | null>
  readonly loadRecentContent: () => Promise<readonly RecentContentSnapshot[]>
  readonly loadVerifiedInternalPaths: () => Promise<ReadonlySet<string>>
  readonly usage?: () => { readonly input_tokens: number | null; readonly output_tokens: number | null } | null
  readonly estimateCostUsd?: (usage: { readonly input_tokens: number | null; readonly output_tokens: number | null } | null) => number | null
  readonly now?: () => number
}

// 생성 결과를 메모리에만 담는 저장소. AiRepository 계약을 만족하지만 쓰기 경로가 없다 —
// apply·조회 메서드는 호출되면 즉시 던져서, 실수로 운영 경로가 섞여 들어오면 조용히 성공하지 않는다.
export function createDryRunAiRepository(place: DryRunPlace): AiRepository & { readonly created: readonly NewAiGeneration[] } {
  const created: NewAiGeneration[] = []
  const synced: SyncedPlace = {
    source: "google_sheets",
    source_sheet_name: "dry-run",
    source_row_number: 0,
    source_key: place.id,
    name: place.name,
    normalized_name: place.name,
    category: place.category,
    detail_category: null,
    region: null,
    city: place.city,
    district: place.district,
    address: place.address,
    normalized_address: null,
    phone: null,
    normalized_phone: null,
    homepage: place.homepage,
    email: null,
    source_url: null,
    collected_at: null,
    grade: null,
    sales_status: null,
    memo: null,
    imported_payload: {} as SyncedPlace["imported_payload"],
    synced_at: new Date(0).toISOString(),
    description: null,
    meta_title: null,
    meta_description: null,
    faq: [],
    keywords: [],
    internal_links: [],
    order_url: null,
    status: place.status,
    id: place.id,
    slug: place.slug,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  }
  return {
    created,
    findPlaceById: (placeId: string) => Promise.resolve(placeId === place.id ? synced : undefined),
    createAiGeneration: (input: NewAiGeneration) => {
      created.push(input)
      const record: AiGenerationRecord = {
        id: `dry-run-${String(created.length)}`,
        place_id: input.placeId,
        status: "preview",
        input: input.input,
        output: input.output,
        before: null,
        after: null,
        created_at: new Date(0).toISOString(),
        applied_at: null,
      }
      return Promise.resolve(record)
    },
    findAiGenerationById: () => {
      throw new Error("dry-run repository must not read stored generations")
    },
    applyAiGeneration: () => {
      throw new Error("dry-run repository must not apply generations")
    },
  }
}

function decideBlock(placeId: string, place: DryRunPlace | null): DryRunBlockReason | null {
  const expected = CONTENT_DRY_RUN_ALLOWLIST[placeId]
  if (expected === undefined) {
    return "not-allowlisted"
  }
  if (place === null) {
    return "place-missing"
  }
  if (place.status !== "draft") {
    return "not-draft"
  }
  if (place.official_verification_status === "excluded" || place.exclusion_reason !== null) {
    return "excluded"
  }
  if (place.official_verification_status !== "verified") {
    return "not-verified"
  }
  if (place.verification_source_urls.length === 0) {
    return "verification-source-missing"
  }
  const mode = contentModeForCategory(place.category)
  if (mode === null) {
    return "category-unsupported"
  }
  if (mode !== expected) {
    // allowlist가 기대한 모드와 실제 업종 판정이 다르면 무엇을 실측하는지 알 수 없다 — 진행하지 않는다.
    return "mode-mismatch"
  }
  return null
}

export async function runContentModeDryRun(placeId: string, dependencies: ContentDryRunDependencies): Promise<ContentDryRunResult> {
  const place = CONTENT_DRY_RUN_ALLOWLIST[placeId] === undefined ? null : await dependencies.loadPlace(placeId)
  const blocked = decideBlock(placeId, place)
  if (blocked !== null || place === null) {
    return { kind: "blocked", reason: blocked ?? "place-missing", placeId }
  }
  const mode = contentModeForCategory(place.category)
  if (mode === null) {
    return { kind: "blocked", reason: "category-unsupported", placeId }
  }

  const repository = createDryRunAiRepository(place)
  const [recentContent, verifiedInternalPaths] = await Promise.all([dependencies.loadRecentContent(), dependencies.loadVerifiedInternalPaths()])
  const now = dependencies.now ?? (() => Date.now())

  const attempts: DryRunAttempt[] = []
  const runOnce = async (kind: DryRunAttempt["kind"], forbiddenTerms: readonly string[]): Promise<DryRunAttempt> => {
    const startedAt = now()
    const record = await generateAiPreview({
      placeId: place.id,
      provider: dependencies.provider,
      repository,
      recentContent,
      ...(kind === "retry"
        ? { retry: { of: "dry-run", reason: "forbidden-mode-vocabulary", bannedFaqPairs: [], forbiddenTerms } }
        : {}),
    })
    const content = record.output
    const quality = evaluateGeneratedContent({
      content,
      placeName: place.name,
      regionTokens: [place.city, place.district],
      mode,
      verifiedInternalPaths,
      recentPages: recentContent.filter((page) => page.placeName !== place.name),
    })
    const forbidden = findForbiddenModeVocabulary({ content, mode, placeName: place.name, regionTokens: [place.city, place.district] })
    const usage = dependencies.usage?.() ?? null
    return {
      kind,
      content,
      quality,
      forbidden,
      tokensInput: usage?.input_tokens ?? null,
      tokensOutput: usage?.output_tokens ?? null,
      costUsd: dependencies.estimateCostUsd?.(usage) ?? null,
      durationMs: now() - startedAt,
    }
  }

  const initial = await runOnce("initial", [])
  attempts.push(initial)

  // 운영 Batch와 같은 정책: 금지 어휘가 걸리면 그 표현을 프롬프트에 명시해 1회만 재시도한다.
  let final = initial
  if (initial.forbidden.length > 0) {
    final = await runOnce("retry", forbiddenTermsOf(initial.forbidden))
    attempts.push(final)
  }

  const finalStatus: "pass" | "warn" | "failed" = final.forbidden.length > 0 || final.quality.status === "fail" ? "failed" : final.quality.status === "warn" ? "warn" : "pass"

  return {
    kind: "completed",
    placeId: place.id,
    name: place.name,
    category: place.category,
    contentMode: mode,
    model: dependencies.model,
    attempts,
    retried: attempts.length > 1,
    finalStatus,
    stored: false,
    applied: false,
    published: false,
  }
}
