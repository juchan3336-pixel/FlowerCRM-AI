import type { Json } from "@/types/database"

export const PLACE_PUBLISH_RESULT_KINDS = [
  "published",
  "already-published",
  "missing-place",
  "missing-seo-page",
  "not-ready",
  "place-not-publishable",
  "missing-content",
] as const

export const PLACE_ARCHIVE_RESULT_KINDS = ["archived", "missing-place", "missing-seo-page", "not-published"] as const

export const PLACE_RESTORE_RESULT_KINDS = ["restored", "missing-seo-page", "not-archived"] as const

export type PlacePublishResultKind = (typeof PLACE_PUBLISH_RESULT_KINDS)[number]
export type PlaceArchiveResultKind = (typeof PLACE_ARCHIVE_RESULT_KINDS)[number]
export type PlaceRestoreResultKind = (typeof PLACE_RESTORE_RESULT_KINDS)[number]

export type PlacePublishRpcResult<Kind extends string> = {
  readonly kind: Kind | "unexpected"
  readonly path: string | null
  readonly publishedAt: string | null
}

export interface PlacePublishRepository {
  publishPlacePage(placeId: string): Promise<Json>
  archivePlacePage(placeId: string): Promise<Json>
  restorePlacePage(placeId: string): Promise<Json>
}

export async function publishPlacePage(repository: PlacePublishRepository, placeId: string): Promise<PlacePublishRpcResult<PlacePublishResultKind>> {
  return parseRpcResult(await repository.publishPlacePage(placeId), PLACE_PUBLISH_RESULT_KINDS)
}

export async function archivePlacePage(repository: PlacePublishRepository, placeId: string): Promise<PlacePublishRpcResult<PlaceArchiveResultKind>> {
  return parseRpcResult(await repository.archivePlacePage(placeId), PLACE_ARCHIVE_RESULT_KINDS)
}

export async function restorePlacePage(repository: PlacePublishRepository, placeId: string): Promise<PlacePublishRpcResult<PlaceRestoreResultKind>> {
  return parseRpcResult(await repository.restorePlacePage(placeId), PLACE_RESTORE_RESULT_KINDS)
}

export function parseRpcResult<Kind extends string>(value: Json, allowedKinds: readonly Kind[]): PlacePublishRpcResult<Kind> {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json | undefined>) : null
  const kindCandidate = record?.["kind"]
  const kind = typeof kindCandidate === "string" && (allowedKinds as readonly string[]).includes(kindCandidate) ? (kindCandidate as Kind) : "unexpected"

  return {
    kind,
    path: textOrNull(record?.["path"]),
    publishedAt: textOrNull(record?.["published_at"]),
  }
}

function textOrNull(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}
