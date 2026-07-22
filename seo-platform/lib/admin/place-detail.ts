import { parseGenerationRetry, parseGenerationStoredMetadata, parseGenerationStoredQuality, parseGenerationTitleNormalization, type StoredQualityReport } from "@/lib/ai/generation-mapping"
import type { AiGenerationRetryAudit } from "@/lib/ai/types"
import type { TitleNormalization } from "@/lib/ai/title-normalization"
import type { AiGenerationUsage } from "@/lib/ai/types"
import type { AiGenerationStatus } from "@/lib/domain/constants"
import type { Json, PlaceRow, SeoPageRow, SeoPageVerificationStatus } from "@/types/database"
import { formatKstDateTime } from "./time"

export type AdminPlaceFaqItem = {
  readonly question: string
  readonly answer: string
}

export type AdminPlaceInternalLink = {
  readonly href: string
  readonly label: string
}

export type AdminPlaceContent = {
  readonly description: string | null
  readonly metaTitle: string | null
  readonly metaDescription: string | null
  readonly faq: readonly AdminPlaceFaqItem[]
  readonly keywords: readonly string[]
  readonly internalLinks: readonly AdminPlaceInternalLink[]
}

export type AdminPlaceGenerationView = {
  readonly id: string
  readonly status: AiGenerationStatus
  readonly model: string | null
  readonly provider: string | null
  readonly usage: AiGenerationUsage | null
  readonly estimatedCost: number | null
  readonly errorCode: string | null
  readonly createdAt: string
  readonly appliedAt: string | null
  readonly output: AdminPlaceContent | null
  readonly quality: StoredQualityReport | null
  readonly titleNormalization: TitleNormalization | null
  // 품질 FAIL 복구 재시도 감사 기록 — 일반 생성은 null.
  readonly retry: AiGenerationRetryAudit | null
}

export type AdminPlaceSeoPageView = {
  readonly id: string
  readonly status: SeoPageRow["status"]
  readonly path: string
  readonly title: string | null
  readonly description: string | null
  readonly createdAt: string
  readonly lastModifiedAt: string | null
  readonly publishedAt: string | null
  // 공개 URL 비동기 검증 상태 (migration 202607220001 이전 행·미게시 행은 null)
  readonly verificationStatus: SeoPageVerificationStatus | null
  readonly verificationCheckedAt: string | null
  readonly verificationAttempts: number | null
  readonly lastHttpStatus: number | null
}

export type AdminPlaceDetail = {
  readonly id: string
  readonly name: string
  readonly category: string
  readonly region: string
  readonly address: string | null
  readonly phone: string | null
  readonly homepage: string | null
  readonly slug: string | null
  readonly status: PlaceRow["status"]
  readonly aiState: "미리보기 대기" | "적용됨"
  readonly content: AdminPlaceContent
  readonly seoPage: AdminPlaceSeoPageView | null
  readonly latestPreview: AdminPlaceGenerationView | null
  readonly generations: readonly AdminPlaceGenerationView[]
  readonly publicPath: string | null
  readonly isPublic: boolean
}

// 품질 패널 표시 상태 — 항상 "현재 상태를 대표하는 generation"(최신 preview/applied) 기준으로 계산한다.
// 게시 완료 후 과거 FAIL preview가 현재 상태처럼 노출되던 문제(13호점)를 막는다.
export type GenerationQualityPanelState = {
  readonly generation: AdminPlaceGenerationView
  readonly quality: StoredQualityReport
  // 품질 FAIL 복구 재시도 generation이 적용된 상태 — "복구 재시도 완료" 배지 표시
  readonly recovered: boolean
  readonly recoveryNote: string | null
  readonly showRetryButton: boolean
}

export function resolveGenerationQualityPanelState(
  input: Readonly<{ generations: readonly AdminPlaceGenerationView[]; isPublished: boolean }>,
): GenerationQualityPanelState | null {
  // 이력은 최신순 — 전송 실패(failed)·반려(rejected) 레코드는 건너뛰고 최신 preview/applied를 현재 상태로 본다.
  const generation = input.generations.find((entry) => entry.status === "preview" || entry.status === "applied")
  if (generation?.quality == null) {
    return null
  }
  const recoveredRetry = generation.status === "applied" ? generation.retry : null
  const recoveryNote =
    recoveredRetry === null
      ? null
      : recoveredRetry.reason.includes("repeat-faq")
        ? "최초 생성은 FAQ 중복으로 차단됐으며, 복구 generation이 적용되었습니다."
        : "최초 생성은 품질 검사 FAIL로 차단됐으며, 복구 generation이 적용되었습니다."
  // 재시도 버튼: 현재 상태가 FAIL preview이고, 그 자신이 재시도가 아니며, 게시된 장소가 아닐 때만.
  const showRetryButton = !input.isPublished && generation.status === "preview" && generation.quality.status === "fail" && generation.retry === null
  return { generation, quality: generation.quality, recovered: recoveredRetry !== null, recoveryNote, showRetryButton }
}

export type AdminPlaceDetailResult =
  | { readonly kind: "found"; readonly detail: AdminPlaceDetail }
  | { readonly kind: "not-found" }
  | { readonly kind: "error"; readonly message: string }

export type AdminPlaceGenerationHistoryRow = {
  readonly id: string
  readonly status: string
  readonly model: string | null
  readonly created_at: string
  readonly applied_at: string | null
  readonly output: Json | null
}

export type AdminPlaceSeoPageRow = Pick<SeoPageRow, "id" | "status" | "path" | "title" | "description" | "created_at" | "last_modified_at" | "published_at"> &
  Partial<Pick<SeoPageRow, "verification_status" | "verification_checked_at" | "verification_attempts" | "last_http_status">>

export interface AdminPlaceDetailRepository {
  findPlaceById(placeId: string): Promise<PlaceRow | null>
  findPlaceSeoPage(placeId: string): Promise<AdminPlaceSeoPageRow | null>
  listAiGenerations(placeId: string, limit: number): Promise<readonly AdminPlaceGenerationHistoryRow[]>
}

const GENERATION_HISTORY_LIMIT = 10
const AI_GENERATION_STATUSES = ["preview", "applied", "rejected", "failed"] as const

export async function loadAdminPlaceDetail(repository: AdminPlaceDetailRepository, placeId: string): Promise<AdminPlaceDetailResult> {
  try {
    const [place, seoPage, generationRows] = await Promise.all([
      repository.findPlaceById(placeId),
      repository.findPlaceSeoPage(placeId),
      repository.listAiGenerations(placeId, GENERATION_HISTORY_LIMIT),
    ])

    if (place === null) {
      return { kind: "not-found" }
    }

    const generations = generationRows.map((row) => generationRowToView(row))
    const latestPreview = generations.find((generation) => generation.status === "preview") ?? null
    const seoPageView = seoPage === null ? null : seoPageRowToView(seoPage)
    const content = placeRowToContent(place)
    const publicPath = place.slug === null || place.slug.trim().length === 0 ? null : `/places/${place.slug}`

    return {
      kind: "found",
      detail: {
        id: place.id,
        name: place.name,
        category: place.detail_category ?? place.category,
        region: formatRegion(place.region, place.city, place.district),
        address: place.address,
        phone: place.phone,
        homepage: place.homepage,
        slug: place.slug,
        status: place.status,
        aiState: hasAppliedContent(content) ? "적용됨" : "미리보기 대기",
        content,
        seoPage: seoPageView,
        latestPreview,
        generations,
        publicPath,
        isPublic: place.status === "published" && seoPageView?.status === "published",
      },
    }
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : "unknown error" }
  }
}

function generationRowToView(row: AdminPlaceGenerationHistoryRow): AdminPlaceGenerationView {
  const storedMetadata = parseGenerationStoredMetadata(row.output)

  return {
    id: row.id,
    status: (AI_GENERATION_STATUSES as readonly string[]).includes(row.status) ? (row.status as AiGenerationStatus) : "failed",
    model: storedMetadata.model ?? row.model,
    provider: storedMetadata.provider,
    usage: storedMetadata.usage,
    estimatedCost: storedMetadata.estimatedCost,
    errorCode: storedMetadata.errorCode,
    createdAt: formatKstDateTime(row.created_at),
    appliedAt: row.applied_at === null ? null : formatKstDateTime(row.applied_at),
    output: parseGenerationOutput(row.output),
    quality: parseGenerationStoredQuality(row.output),
    titleNormalization: parseGenerationTitleNormalization(row.output),
    retry: parseGenerationRetry(row.output),
  }
}

function seoPageRowToView(row: AdminPlaceSeoPageRow): AdminPlaceSeoPageView {
  return {
    id: row.id,
    status: row.status,
    path: row.path,
    title: row.title,
    description: row.description,
    createdAt: formatKstDateTime(row.created_at),
    lastModifiedAt: row.last_modified_at === null ? null : formatKstDateTime(row.last_modified_at),
    publishedAt: row.published_at === null ? null : formatKstDateTime(row.published_at),
    // migration 미적용 DB에서는 컬럼이 없어 undefined — null로 정규화한다.
    verificationStatus: row.verification_status ?? null,
    verificationCheckedAt: row.verification_checked_at == null ? null : formatKstDateTime(row.verification_checked_at),
    verificationAttempts: row.verification_attempts ?? null,
    lastHttpStatus: row.last_http_status ?? null,
  }
}

export function parseGenerationOutput(value: Json | null): AdminPlaceContent | null {
  const record = asRecord(value)
  if (record === null) {
    return null
  }

  const generated = asRecord(record["generated"]) ?? record
  const description = textOrNull(generated["description"])
  const metaTitle = textOrNull(generated["meta_title"])
  const metaDescription = textOrNull(generated["meta_description"])
  if (description === null && metaTitle === null && metaDescription === null) {
    return null
  }

  return {
    description,
    metaTitle,
    metaDescription,
    faq: parseFaq(generated["faq"]),
    keywords: parseKeywords(generated["keywords"]),
    internalLinks: parseInternalLinks(generated["internal_links"]),
  }
}

function placeRowToContent(place: PlaceRow): AdminPlaceContent {
  return {
    description: textOrNull(place.description),
    metaTitle: textOrNull(place.meta_title),
    metaDescription: textOrNull(place.meta_description),
    faq: parseFaq(place.faq),
    keywords: parseKeywords(place.keywords),
    internalLinks: parseInternalLinks(place.internal_links),
  }
}

function hasAppliedContent(content: AdminPlaceContent): boolean {
  return content.description !== null || content.metaTitle !== null || content.metaDescription !== null
}

function parseFaq(value: Json | undefined): readonly AdminPlaceFaqItem[] {
  if (!isJsonArray(value)) {
    return []
  }

  return value.flatMap((item) => {
    const record = asRecord(item)
    const question = textOrNull(record?.["question"])
    const answer = textOrNull(record?.["answer"])
    return question !== null && answer !== null ? [{ question, answer }] : []
  })
}

function parseKeywords(value: Json | undefined): readonly string[] {
  if (!isJsonArray(value)) {
    return []
  }

  return value.flatMap((item) => (typeof item === "string" && item.trim().length > 0 ? [item] : []))
}

function parseInternalLinks(value: Json | undefined): readonly AdminPlaceInternalLink[] {
  if (!isJsonArray(value)) {
    return []
  }

  return value.flatMap((item) => {
    const record = typeof item === "object" && item !== null && !Array.isArray(item) ? (item as Record<string, Json | undefined>) : null
    const href = textOrNull(record?.["href"])
    const label = textOrNull(record?.["label"])
    return href !== null && label !== null ? [{ href, label }] : []
  })
}

function isJsonArray(value: Json | undefined): value is readonly Json[] {
  return Array.isArray(value)
}

function asRecord(value: Json | null | undefined): Record<string, Json | undefined> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json | undefined>) : null
}

function textOrNull(value: Json | null | undefined): string | null {
  if (typeof value !== "string") {
    return null
  }
  const text = value.trim()
  return text.length > 0 ? text : null
}

function formatRegion(region: string | null, city: string | null, district: string | null): string {
  const cityDistrict = [city, district].filter((value) => value !== null).join(" · ")
  return region ?? (cityDistrict.length > 0 ? cityDistrict : "Nationwide")
}
