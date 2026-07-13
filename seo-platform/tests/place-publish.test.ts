import { describe, expect, it } from "vitest"

import {
  archivePlacePage,
  parseRpcResult,
  publishPlacePage,
  restorePlacePage,
  PLACE_PUBLISH_RESULT_KINDS,
  type PlacePublishRepository,
} from "@/lib/seo-pages/place-publish"
import type { Json } from "@/types/database"

describe("place publish rpc wrappers", () => {
  it("publishes one ready place page and returns the public path", async () => {
    // Given: the RPC reports a successful publish.
    const calls: string[] = []
    const repository = fakeRepository({
      publish: { kind: "published", seo_page_id: "seo-1", path: "/places/place-1-slug", published_at: "2026-07-13T08:00:00.000Z" },
      onCall: (name) => calls.push(name),
    })

    // When: the wrapper runs for a single place.
    const result = await publishPlacePage(repository, "place-1")

    // Then: the typed result carries path and publish time for revalidation and notices.
    expect(result).toEqual({ kind: "published", path: "/places/place-1-slug", publishedAt: "2026-07-13T08:00:00.000Z" })
    expect(calls).toEqual(["publish"])
  })

  it("treats an already published page as a no-op without touching published_at", async () => {
    // Given: the RPC reports already-published with the original timestamp.
    const repository = fakeRepository({
      publish: { kind: "already-published", path: "/places/place-1-slug", published_at: "2026-07-01T00:00:00.000Z" },
    })

    // When: publish runs again.
    const result = await publishPlacePage(repository, "place-1")

    // Then: the original publish time is preserved in the result.
    expect(result.kind).toBe("already-published")
    expect(result.publishedAt).toBe("2026-07-01T00:00:00.000Z")
  })

  it("surfaces every blocked publish reason as a typed kind", () => {
    // Given / When / Then: all RPC kinds parse into the allowed union.
    for (const kind of PLACE_PUBLISH_RESULT_KINDS) {
      expect(parseRpcResult({ kind }, PLACE_PUBLISH_RESULT_KINDS).kind).toBe(kind)
    }
    expect(parseRpcResult({ kind: "surprise" }, PLACE_PUBLISH_RESULT_KINDS).kind).toBe("unexpected")
    expect(parseRpcResult("garbage", PLACE_PUBLISH_RESULT_KINDS).kind).toBe("unexpected")
    expect(parseRpcResult(null, PLACE_PUBLISH_RESULT_KINDS).kind).toBe("unexpected")
  })

  it("archives a published page and keeps the recorded publish time", async () => {
    // Given: the RPC archives and echoes the preserved published_at.
    const repository = fakeRepository({
      archive: { kind: "archived", path: "/places/place-1-slug", published_at: "2026-07-13T08:00:00.000Z" },
    })

    // When: the archive wrapper runs.
    const result = await archivePlacePage(repository, "place-1")

    // Then: the archive result keeps the path for revalidation and the preserved timestamp.
    expect(result).toEqual({ kind: "archived", path: "/places/place-1-slug", publishedAt: "2026-07-13T08:00:00.000Z" })
  })

  it("restores an archived page back to ready", async () => {
    // Given: the RPC restores the page.
    const repository = fakeRepository({ restore: { kind: "restored", path: "/places/place-1-slug" } })

    // When: the restore wrapper runs.
    const result = await restorePlacePage(repository, "place-1")

    // Then: the page can be reviewed and republished.
    expect(result.kind).toBe("restored")
  })

  it("rejects wrong-state transitions with blocked kinds", async () => {
    // Given: RPC refusals for wrong lifecycle states.
    const repository = fakeRepository({
      publish: { kind: "not-ready", seo_status: "draft" },
      archive: { kind: "not-published", seo_status: "ready" },
      restore: { kind: "not-archived", seo_status: "published" },
    })

    // When / Then: each wrapper surfaces the refusal without throwing.
    expect((await publishPlacePage(repository, "place-1")).kind).toBe("not-ready")
    expect((await archivePlacePage(repository, "place-1")).kind).toBe("not-published")
    expect((await restorePlacePage(repository, "place-1")).kind).toBe("not-archived")
  })
})

function fakeRepository(input: Readonly<{ publish?: Json; archive?: Json; restore?: Json; onCall?: (name: string) => void }>): PlacePublishRepository {
  return {
    publishPlacePage() {
      input.onCall?.("publish")
      return Promise.resolve(input.publish ?? { kind: "missing-place" })
    },
    archivePlacePage() {
      input.onCall?.("archive")
      return Promise.resolve(input.archive ?? { kind: "missing-place" })
    },
    restorePlacePage() {
      input.onCall?.("restore")
      return Promise.resolve(input.restore ?? { kind: "missing-seo-page" })
    },
  }
}
