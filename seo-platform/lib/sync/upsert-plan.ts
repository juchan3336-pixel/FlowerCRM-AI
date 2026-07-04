import type { SourcePlaceFields, SyncedPlace } from "./types"

export type SyncUpsertPlan =
  | { readonly kind: "insert"; readonly next: SourcePlaceFields }
  | { readonly kind: "update"; readonly current: SyncedPlace; readonly next: SourcePlaceFields }
  | { readonly kind: "skip"; readonly current: SyncedPlace }

const SOURCE_FIELD_KEYS = [
  "source",
  "source_sheet_name",
  "source_row_number",
  "source_key",
  "name",
  "normalized_name",
  "category",
  "detail_category",
  "region",
  "city",
  "district",
  "address",
  "normalized_address",
  "phone",
  "normalized_phone",
  "homepage",
  "email",
  "source_url",
  "collected_at",
  "grade",
  "sales_status",
  "memo",
  "imported_payload",
] as const

export function planSyncUpsert(
  input: Readonly<{ current: SyncedPlace | undefined; next: SourcePlaceFields }>,
): SyncUpsertPlan {
  if (input.current === undefined) {
    return { kind: "insert", next: input.next }
  }

  if (hasSourceChanges(input.current, input.next)) {
    return { kind: "update", current: input.current, next: input.next }
  }

  return { kind: "skip", current: input.current }
}

function hasSourceChanges(current: SyncedPlace, next: SourcePlaceFields): boolean {
  return SOURCE_FIELD_KEYS.some((key) => JSON.stringify(current[key]) !== JSON.stringify(next[key]))
}
