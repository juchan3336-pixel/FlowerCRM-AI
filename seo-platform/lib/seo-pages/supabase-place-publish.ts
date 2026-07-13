import "server-only"

import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { Json } from "@/types/database"
import type { PlacePublishRepository } from "./place-publish"

export function createSupabasePlacePublishRepository(): PlacePublishRepository {
  const client = createSupabaseServiceRoleClient()

  async function callRpc(functionName: "publish_place_page" | "archive_place_page" | "restore_place_page", placeId: string): Promise<Json> {
    const { data, error } = await client.rpc(functionName, { target_place_id: placeId })
    if (error !== null) {
      throw new SupabasePlacePublishError(functionName, error.message)
    }
    return data
  }

  return {
    publishPlacePage(placeId: string): Promise<Json> {
      return callRpc("publish_place_page", placeId)
    },
    archivePlacePage(placeId: string): Promise<Json> {
      return callRpc("archive_place_page", placeId)
    },
    restorePlacePage(placeId: string): Promise<Json> {
      return callRpc("restore_place_page", placeId)
    },
  }
}

export class SupabasePlacePublishError extends Error {
  readonly name = "SupabasePlacePublishError"

  constructor(functionName: string, readonly detail: string) {
    super(`Failed to call ${functionName}: ${detail}`)
  }
}
