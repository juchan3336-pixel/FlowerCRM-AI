import type { AiGenerationStatus } from "@/lib/domain/constants"
import type { Json, PlaceRow, SeoPageRow } from "@/types/database"
import { formatKstDateTime } from "./time"

export type AdminPlaceFaqItem = {
  readonly question: string
  readonly answer: string
}

export type AdminPlaceContent = {
  readonly description: string | null
  readonly metaTitle: string | null
  readonly metaDescription: string | null
  readonly faq: readonly AdminPlaceFaqItem[]
  readonly keywords: readonly string[]
}

export type AdminPlaceGenerationView = {
  readonly id: string
  readonly status: AiGenerationStatus
  readonly model: string | null
  readonly createdAt: string
  readonly appliedAt: string | null
  readonly output: AdminPlaceContent | null
}

export type AdminPlaceSeoPageView = {
  readonly id: string
  readonly status: SeoPageRow["status"]
  readonly path: string
  readonly title: string | null
  readonly description: string | null
  readonly createdAt: string
  readonly lastModifiedAt: string | null
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

export type AdminPlaceSeoPageRow = Pick<SeoPageRow, "id" | "status" | "path" | "title" | "description" | "created_at" | "last_modified_at">

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
  return {
    id: row.id,
    status: (AI_GENERATION_STATUSES as readonly string[]).includes(row.status) ? (row.status as AiGenerationStatus) : "failed",
    model: row.model,
    createdAt: formatKstDateTime(row.created_at),
    appliedAt: row.applied_at === null ? null : formatKstDateTime(row.applied_at),
    output: parseGenerationOutput(row.output),
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
  }
}

function placeRowToContent(place: PlaceRow): AdminPlaceContent {
  return {
    description: textOrNull(place.description),
    metaTitle: textOrNull(place.meta_title),
    metaDescription: textOrNull(place.meta_description),
    faq: parseFaq(place.faq),
    keywords: parseKeywords(place.keywords),
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
