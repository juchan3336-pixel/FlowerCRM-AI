import { assertAiOutputAllowed, parseAiProviderOutput } from "./guardrails"
import type { AiGenerationInput, AiGenerationRecord, AiProvider, AiRepository } from "./types"

const GUARDRAILS = [
  "Do not invent facts absent from the source place.",
  "Do not generate phone, email, or price information.",
  "Express ordering and delivery availability only through the default CTA.",
  "Keep funeral and hospital language factual and restrained.",
] as const

export type GenerateAiPreviewInput = {
  readonly placeId: string
  readonly provider: AiProvider
  readonly repository: AiRepository
}

export type ApplyAiGenerationServiceInput = {
  readonly generationId: string
  readonly repository: AiRepository
}

export async function generateAiPreview(input: GenerateAiPreviewInput): Promise<AiGenerationRecord> {
  const place = await input.repository.findPlaceById(input.placeId)
  if (place === undefined) {
    throw new MissingAiPlaceError(input.placeId)
  }
  const generationInput: AiGenerationInput = {
    place: {
      id: place.id,
      name: place.name,
      category: place.category,
      city: place.city,
      district: place.district,
      address: place.address,
      homepage: place.homepage,
    },
    guardrails: GUARDRAILS,
  }
  const output = parseAiProviderOutput(await input.provider.generateSeoContent(generationInput))
  assertAiOutputAllowed(output, place)
  return input.repository.createAiGeneration({ placeId: place.id, input: generationInput, output })
}

export async function applyAiGeneration(input: ApplyAiGenerationServiceInput): Promise<AiGenerationRecord> {
  const generation = await input.repository.findAiGenerationById(input.generationId)
  if (generation === undefined) {
    throw new MissingAiGenerationError(input.generationId)
  }
  if (generation.status !== "preview") {
    throw new AiGenerationAlreadyAppliedError(input.generationId)
  }
  const place = await input.repository.findPlaceById(generation.place_id)
  if (place === undefined) {
    throw new MissingAiPlaceError(generation.place_id)
  }
  return input.repository.applyAiGeneration({
    generationId: generation.id,
    before: {
      description: place.description,
      meta_title: place.meta_title,
      meta_description: place.meta_description,
      faq: place.faq,
      keywords: place.keywords,
      internal_links: place.internal_links,
    },
    after: generation.output,
  })
}

export class MissingAiPlaceError extends Error {
  readonly name = "MissingAiPlaceError"

  constructor(readonly placeId: string) {
    super(`Missing AI place ${placeId}`)
  }
}

export class MissingAiGenerationError extends Error {
  readonly name = "MissingAiGenerationError"

  constructor(readonly generationId: string) {
    super(`Missing AI generation ${generationId}`)
  }
}

export class AiGenerationAlreadyAppliedError extends Error {
  readonly name = "AiGenerationAlreadyAppliedError"

  constructor(readonly generationId: string) {
    super(`AI generation is not preview: ${generationId}`)
  }
}
