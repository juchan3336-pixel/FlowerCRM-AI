import "server-only"

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { PlaceSeoGenerationRepository, SelectablePlaceForSeoGeneration, SeoPageForPlaceGeneration } from "./place-generation"

const PLACE_GENERATION_SELECT = "id,name,address,category,slug,city,district,description,meta_title,meta_description" as const
const SEO_PAGE_CONTEXT_SELECT = "place_id,page_type,slug,path,title,description,canonical_url,status,priority,change_frequency,last_modified_at" as const

export function createSupabasePlaceSeoGenerationRepository(): PlaceSeoGenerationRepository {
  const client = createSupabaseServiceRoleClient()

  return {
    async listSelectedPlaces(placeIds: readonly string[]): Promise<readonly SelectablePlaceForSeoGeneration[]> {
      const { data, error } = await client.from("places").select(PLACE_GENERATION_SELECT).in("id", [...placeIds])
      if (error !== null) {
        throw new SupabasePlaceSeoGenerationReadError(error.message)
      }
      return data
    },
    async listPlaceSeoPageContexts(): Promise<readonly SeoPageForPlaceGeneration[]> {
      const { data, error } = await client.from("seo_pages").select(SEO_PAGE_CONTEXT_SELECT).eq("page_type", "place")
      if (error !== null) {
        throw new SupabasePlaceSeoGenerationReadError(error.message)
      }
      return data
    },
    async insertReadyPlaceSeoPages(pages: readonly SeoPageForPlaceGeneration[]): Promise<number> {
      const { error } = await client.from("seo_pages").insert([...pages])
      if (error !== null) {
        throw new SupabasePlaceSeoGenerationWriteError(error.message)
      }
      return pages.length
    },
  }
}

export class SupabasePlaceSeoGenerationReadError extends Error {
  readonly name = "SupabasePlaceSeoGenerationReadError"

  constructor(readonly detail: string) {
    super(`Failed to read place SEO generation data: ${detail}`)
  }
}

export class SupabasePlaceSeoGenerationWriteError extends Error {
  readonly name = "SupabasePlaceSeoGenerationWriteError"

  constructor(readonly detail: string) {
    super(`Failed to write generated place SEO pages: ${detail}`)
  }
}
