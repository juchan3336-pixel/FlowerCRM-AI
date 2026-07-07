import { generateSelectedPlaceSeoPages, type PlaceSeoGenerationRepository, type PlaceSeoGenerationResult } from "@/lib/seo-pages/place-generation"

const MAX_SELECTED_ADMIN_ACTION_COUNT = 100

export interface AdminSeoPageActionRepository extends PlaceSeoGenerationRepository {
  publishSelectedReadySeoPages(seoPageIds: readonly string[]): Promise<number>
}

export type AdminSeoPageActionAuth<TRepository extends AdminSeoPageActionRepository> = (repository: TRepository) => Promise<void>

export type GenerateSelectedSampleInput<TRepository extends AdminSeoPageActionRepository> = {
  readonly repository: TRepository
  readonly placeIds: readonly string[]
  readonly assertAllowed: AdminSeoPageActionAuth<TRepository>
}

export type PublishSelectedReadyInput<TRepository extends AdminSeoPageActionRepository> = {
  readonly repository: TRepository
  readonly seoPageIds: readonly string[]
  readonly assertAllowed: AdminSeoPageActionAuth<TRepository>
}

export type PublishSelectedReadyResult =
  | { readonly kind: "published"; readonly selected: number; readonly published: number }
  | { readonly kind: "rejected"; readonly reason: "EmptySelection" | "SampleLimitExceeded"; readonly selected: number; readonly published: 0 }

export async function generateSelectedSampleSeoPages<TRepository extends AdminSeoPageActionRepository>(
  input: GenerateSelectedSampleInput<TRepository>,
): Promise<PlaceSeoGenerationResult> {
  await input.assertAllowed(input.repository)
  return generateSelectedPlaceSeoPages({ repository: input.repository, placeIds: input.placeIds })
}

export async function publishSelectedReadySeoPages<TRepository extends AdminSeoPageActionRepository>(
  input: PublishSelectedReadyInput<TRepository>,
): Promise<PublishSelectedReadyResult> {
  await input.assertAllowed(input.repository)
  const selected = input.seoPageIds.length
  if (selected === 0) {
    return { kind: "rejected", reason: "EmptySelection", selected, published: 0 }
  }
  if (selected > MAX_SELECTED_ADMIN_ACTION_COUNT) {
    return { kind: "rejected", reason: "SampleLimitExceeded", selected, published: 0 }
  }

  const published = await input.repository.publishSelectedReadySeoPages(input.seoPageIds)
  return { kind: "published", selected, published }
}
