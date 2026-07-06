import { createUniqueSlug } from "../domain/slug"
import { DuplicatePlaceSlugError } from "./types"
import type { SourcePlaceFields, SyncRepository } from "./types"

const MAX_SLUG_INSERT_ATTEMPTS = 10

export function createSlugInserter(repository: SyncRepository): SlugInserter {
  let slugs: ReadonlySet<string> | undefined

  return {
    async insert(input: InsertWithUniqueSlugInput): Promise<void> {
      for (let attempt = 0; attempt < MAX_SLUG_INSERT_ATTEMPTS; attempt += 1) {
        const slug = await nextSlug(repository, input.baseSlug, slugs)
        slugs = new Set([...(slugs ?? (await repository.listPlaceSlugs())), slug])
        try {
          await repository.insertPlace({ ...input.place, slug })
          return
        } catch (error) {
          if (!(error instanceof DuplicatePlaceSlugError)) {
            throw error
          }
        }
      }

      throw new SlugInsertRetryExhaustedError(input.baseSlug)
    },
  }
}

async function nextSlug(repository: SyncRepository, baseSlug: string, currentSlugs: ReadonlySet<string> | undefined): Promise<string> {
  return createUniqueSlug(baseSlug, currentSlugs ?? (await repository.listPlaceSlugs()))
}

type SlugInserter = {
  readonly insert: (input: InsertWithUniqueSlugInput) => Promise<void>
}

type InsertWithUniqueSlugInput = {
  readonly baseSlug: string
  readonly place: SourcePlaceFields
}

class SlugInsertRetryExhaustedError extends Error {
  readonly name = "SlugInsertRetryExhaustedError"

  constructor(readonly baseSlug: string) {
    super(`Could not insert a place with a unique slug for ${baseSlug}`)
  }
}
