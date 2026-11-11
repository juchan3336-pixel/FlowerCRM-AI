import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/seo-pages/publish-hold", () => ({
  acquirePublishLock: () => Promise.resolve(true),
  releasePublishLock: () => Promise.resolve(),
  isPublishFrozen: () => Promise.resolve(false),
}))

import type { AiGeneratedSeoContent, AiGenerationInput, AiProvider } from "@/lib/ai/types"
import { FakeDeterministicAiProvider } from "@/lib/ai/fake-provider"
import { applyAiGeneration, generateAiPreview, VerifiedAddressBlockedError } from "@/lib/ai/service"
import { decideBatchCandidate } from "@/lib/batch/candidate-policy"
import {
  addressResolutionRecordOf,
  checkGenerationAddressRecord,
  rawAddressHash,
  resolveVerifiedAddress,
  validateVerifiedAddressEntries,
  VERIFIED_ADDRESSES,
  type VerifiedAddressEntry,
} from "@/lib/domain/verified-address"
import { publicPlacePageRowToSource } from "@/lib/public-seo/place-pages"
import { listPublishedPublicPages } from "@/lib/public-seo/public-pages"
import { planVerifiedAddressCacheSync, verifiedAddressSignature } from "@/lib/seo-pages/verified-address-cache"
import { InMemorySyncRepository } from "@/lib/sync/in-memory-repository"
import { syncSheetRows } from "@/lib/sync/service"
import type { PublicPlacePageRow } from "@/types/database"

const ENTRY: VerifiedAddressEntry = {
  placeId: "11111111-1111-4111-8111-111111111111",
  expectedSlug: "area-seoul-gangseogu-geomtowedinghol",
  expectedName: "검토웨딩홀",
  expectedRawAddress: "서울 강서구 강서로 388 지하1층, 1-6층 (지번) 등촌동 678-14",
  verifiedAddress: "서울 강서구 강서로 388",
  sourceUrl: "https://example.test/location",
  sourceQuote: "서울특별시 강서구 강서로 388",
  reason: "DB 주소의 층·호 표기를 공식 사이트에서 확인하지 못해 생성·공개 주소에서 사용하지 않음",
  reviewedAt: "2026-11-11",
  revision: 1,
  contentUpdatedAt: "2026-11-11T04:00:00.000Z",
}
const SUBJECT = { placeId: ENTRY.placeId, slug: ENTRY.expectedSlug, name: ENTRY.expectedName, rawAddress: ENTRY.expectedRawAddress }

describe("검수 주소 판정", () => {
  it("keeps the production map well-formed", () => {
    expect(validateVerifiedAddressEntries(VERIFIED_ADDRESSES, new Date().toISOString())).toEqual([])
  })

  it("rejects malformed entries", () => {
    const now = "2026-11-12T00:00:00.000Z"
    const problems = (patch: Partial<VerifiedAddressEntry>): readonly string[] => validateVerifiedAddressEntries([{ ...ENTRY, ...patch }], now)
    expect(validateVerifiedAddressEntries([ENTRY], now)).toEqual([])
    expect(validateVerifiedAddressEntries([ENTRY, ENTRY], now).join()).toContain("중복")
    expect(problems({ verifiedAddress: "" }).length).toBeGreaterThan(0)
    expect(problems({ verifiedAddress: "서울 강서구 강서로 388 1층" }).join()).toContain("도로명 + 건물번호")
    expect(problems({ verifiedAddress: "서울 강서구 강서로 390" }).join()).toContain("verifiedAddress로 시작하지 않음")
    expect(problems({ sourceUrl: "example.test" }).join()).toContain("sourceUrl")
    expect(problems({ reviewedAt: "2026/11/11" }).join()).toContain("reviewedAt")
    expect(problems({ revision: 0 }).join()).toContain("revision")
    expect(problems({ contentUpdatedAt: "2026-11-13T00:00:00.000Z" }).join()).toContain("미래")
    expect(problems({ placeId: "not-a-uuid" }).join()).toContain("placeId")
  })

  it("separates not-registered, matched and conflict", () => {
    expect(resolveVerifiedAddress({ placeId: "22222222-2222-4222-8222-222222222222", slug: "other", name: "다른 곳", rawAddress: "서울 중구 세종대로 1" }, [ENTRY])).toEqual({ kind: "not-registered" })
    expect(resolveVerifiedAddress(SUBJECT, [ENTRY])).toEqual({ kind: "matched", address: "서울 강서구 강서로 388", revision: 1, rawAddressHash: rawAddressHash(ENTRY.expectedRawAddress), contentUpdatedAt: ENTRY.contentUpdatedAt })
  })

  it.each([
    ["slug", { slug: "area-seoul-gangseogu-renamed" }, ["slug"]],
    ["name", { name: "검토컨벤션" }, ["name"]],
    ["raw address", { rawAddress: "서울 강서구 강서로 388 (지번) 등촌동 678-14" }, ["raw-address"]],
    ["missing address", { rawAddress: null }, ["raw-address"]],
  ] as const)("treats a changed %s as conflict, never as the raw address", (_label, patch, fields) => {
    expect(resolveVerifiedAddress({ ...SUBJECT, ...patch }, [ENTRY])).toEqual({ kind: "conflict", placeId: ENTRY.placeId, fields })
  })

  it("treats a wrong or missing place id on a registered slug as conflict", () => {
    expect(resolveVerifiedAddress({ ...SUBJECT, placeId: "33333333-3333-4333-8333-333333333333" }, [ENTRY])).toEqual({ kind: "conflict", placeId: ENTRY.placeId, fields: ["place-id"] })
    expect(resolveVerifiedAddress({ ...SUBJECT, placeId: null }, [ENTRY]).kind).toBe("conflict")
  })
})

describe("생성 기록 대조", () => {
  const matched = resolveVerifiedAddress(SUBJECT, [ENTRY])
  const record = matched.kind === "matched" ? addressResolutionRecordOf(matched) : null

  it("accepts a record made under the current entry", () => {
    expect(checkGenerationAddressRecord(matched, record)).toEqual({ ok: true })
  })

  it("blocks content generated before the place was registered", () => {
    expect(checkGenerationAddressRecord(matched, undefined)).toMatchObject({ ok: false, reason: "record-missing" })
  })

  it("blocks content generated under an older revision even though the place still matches", () => {
    const bumped = resolveVerifiedAddress(SUBJECT, [{ ...ENTRY, revision: 2 }])
    expect(bumped.kind).toBe("matched")
    expect(checkGenerationAddressRecord(bumped, record)).toMatchObject({ ok: false, reason: "record-stale" })
  })

  it("blocks on conflict and on a record left behind by a removed entry", () => {
    expect(checkGenerationAddressRecord(resolveVerifiedAddress({ ...SUBJECT, name: "검토컨벤션" }, [ENTRY]), record)).toMatchObject({ ok: false, reason: "conflict" })
    expect(checkGenerationAddressRecord({ kind: "not-registered" }, record)).toMatchObject({ ok: false, reason: "record-stale" })
    expect(checkGenerationAddressRecord({ kind: "not-registered" }, undefined)).toEqual({ ok: true })
  })
})

class RecordingProvider implements AiProvider {
  readonly inputs: AiGenerationInput[] = []
  private readonly inner = new FakeDeterministicAiProvider()

  generateSeoContent(input: AiGenerationInput): Promise<AiGeneratedSeoContent> {
    this.inputs.push(input)
    return this.inner.generateSeoContent(input)
  }
}

async function seededFuneralPlace(): Promise<{ readonly repository: InMemorySyncRepository; readonly entry: VerifiedAddressEntry; readonly placeId: string; readonly rawAddress: string }> {
  const rows: unknown = JSON.parse(await readFile(resolve("tests/fixtures/sheet-rows.json"), "utf8"))
  const repository = new InMemorySyncRepository()
  await syncSheetRows({ repository, rows, sheetName: "기업 DB" })
  const place = repository.places().find((row) => row.category === "funeral" && row.address !== null)
  if (place?.address === null || place?.address === undefined) {
    throw new Error("fixture에 주소 있는 funeral 장소가 필요합니다")
  }
  // 대역 엔트리 — 원문 주소의 앞 두 토큰까지만 '확인된 주소'로 본다 (판정 로직만 검증).
  const verifiedAddress = place.address.split(/\s+/).slice(0, 2).join(" ")
  return { repository, placeId: place.id, rawAddress: place.address, entry: { ...ENTRY, placeId: place.id, expectedSlug: place.slug, expectedName: place.name, expectedRawAddress: place.address, verifiedAddress } }
}

describe("생성·적용 경계", () => {
  it("sends only the verified address to the model and records the resolution", async () => {
    const { repository, entry, placeId, rawAddress } = await seededFuneralPlace()
    const provider = new RecordingProvider()

    const preview = await generateAiPreview({ placeId, provider, repository, verifiedAddresses: [entry] })

    expect(provider.inputs[0]?.place.address).toBe(entry.verifiedAddress)
    expect(provider.inputs[0]?.place.address).not.toBe(rawAddress)
    expect(preview.input.address_resolution).toEqual({ revision: 1, effective_address: entry.verifiedAddress, raw_address_hash: rawAddressHash(rawAddress) })
  })

  it("leaves unregistered places exactly as before", async () => {
    const { repository, placeId, rawAddress } = await seededFuneralPlace()
    const provider = new RecordingProvider()

    const preview = await generateAiPreview({ placeId, provider, repository, verifiedAddresses: [] })

    expect(provider.inputs[0]?.place.address).toBe(rawAddress)
    expect(preview.input.address_resolution).toBeUndefined()
  })

  it("stops before calling the model when the registered place no longer matches", async () => {
    const { repository, entry, placeId } = await seededFuneralPlace()
    const provider = new RecordingProvider()

    await expect(generateAiPreview({ placeId, provider, repository, verifiedAddresses: [{ ...entry, expectedName: "다른 이름" }] })).rejects.toBeInstanceOf(VerifiedAddressBlockedError)
    expect(provider.inputs).toHaveLength(0)
    expect(repository.aiGenerations()).toHaveLength(0)
  })

  it("refuses to apply a preview made before registration", async () => {
    const { repository, entry, placeId } = await seededFuneralPlace()
    const legacy = await generateAiPreview({ placeId, provider: new FakeDeterministicAiProvider(), repository, verifiedAddresses: [] })

    await expect(applyAiGeneration({ generationId: legacy.id, repository, verifiedAddresses: [entry] })).rejects.toMatchObject({ reason: "record-missing" })
    expect(repository.places().find((row) => row.id === placeId)?.meta_title).toBeNull()
  })

  it("refuses to apply after the map revision changed, and applies when nothing changed", async () => {
    const { repository, entry, placeId } = await seededFuneralPlace()
    const preview = await generateAiPreview({ placeId, provider: new FakeDeterministicAiProvider(), repository, verifiedAddresses: [entry] })

    await expect(applyAiGeneration({ generationId: preview.id, repository, verifiedAddresses: [{ ...entry, revision: 2 }] })).rejects.toMatchObject({ reason: "record-stale" })
    expect(repository.places().find((row) => row.id === placeId)?.meta_title).toBeNull()

    const applied = await applyAiGeneration({ generationId: preview.id, repository, verifiedAddresses: [entry] })
    expect(applied.status).toBe("applied")
  })
})

describe("후보 판정", () => {
  const base = { generationCount: 0, seoPagePathExists: false, slugDuplicateCount: 0, verificationSourceUrls: ["https://example.test"] }
  const registered = firstLiveEntry()
  const place = { id: registered.placeId, status: "draft", slug: registered.expectedSlug, official_verification_status: "verified", exclusion_reason: null, category: "숙박/행사", name: registered.expectedName, address: registered.expectedRawAddress } as const

  it("keeps a matching registered place eligible", () => {
    expect(decideBatchCandidate({ ...base, place })).toMatchObject({ eligible: true })
  })

  it("makes a registered place ineligible once its raw address drifts", () => {
    expect(decideBatchCandidate({ ...base, place: { ...place, address: `${registered.verifiedAddress} 2층` } })).toMatchObject({ eligible: false, reason: "verified-address-conflict" })
  })
})

function firstLiveEntry(): VerifiedAddressEntry {
  const [entry] = VERIFIED_ADDRESSES
  if (entry === undefined) {
    throw new Error("운영 맵이 비어 있습니다")
  }
  return entry
}
const LIVE = firstLiveEntry()

function publicRow(patch: Partial<PublicPlacePageRow> = {}): PublicPlacePageRow {
  return {
    seo_page_id: "seo-1",
    page_type: "place",
    page_slug: LIVE.expectedSlug,
    path: `/places/${LIVE.expectedSlug}`,
    title: `${LIVE.expectedName} 축하화환 주문 전 확인 사항`,
    page_description: "주문 전 확인 안내",
    canonical_url: `https://example.test/places/${LIVE.expectedSlug}`,
    priority: 0.6,
    change_frequency: "weekly",
    last_modified_at: "2026-11-01T00:00:00.000Z",
    place_id: LIVE.placeId,
    name: LIVE.expectedName,
    category: "숙박/행사",
    detail_category: null,
    region: "경북",
    city: "경북",
    district: "경산시",
    address: LIVE.expectedRawAddress,
    homepage: null,
    place_slug: LIVE.expectedSlug,
    order_url: null,
    place_description: "본문",
    meta_title: null,
    meta_description: null,
    faq: [{ question: "주소는 어떻게 확인하나요?", answer: `주소는 ${LIVE.verifiedAddress}입니다.` }],
    keywords: [],
    internal_links: [],
    ...patch,
  }
}

describe("공개 표면", () => {
  it("shows only the verified address and reflects the entry edit time", () => {
    const source = publicPlacePageRowToSource(publicRow())
    expect(source?.address).toBe(LIVE.verifiedAddress)
    expect(source?.lastModifiedAt).toBe(LIVE.contentUpdatedAt)
    if (source === null) {
      return
    }
    const [page] = listPublishedPublicPages([source])
    expect(page?.address).toBe(LIVE.verifiedAddress)
    expect(JSON.stringify(page)).not.toContain("층")
  })

  it("keeps a later database edit time", () => {
    expect(publicPlacePageRowToSource(publicRow({ last_modified_at: "2027-01-01T00:00:00.000Z" }))?.lastModifiedAt).toBe("2027-01-01T00:00:00.000Z")
  })

  it.each([
    ["raw address changed", { address: `${LIVE.verifiedAddress} 9층` }],
    ["name changed", { name: "다른 이름" }],
    ["place slug changed", { place_slug: "area-renamed" }],
    ["page slug differs from place slug", { page_slug: "area-other-page", path: "/places/area-other-page" }],
    ["place id missing", { place_id: null }],
  ] as const)("takes the page off every public surface when %s", (_label, patch) => {
    expect(publicPlacePageRowToSource(publicRow(patch))).toBeNull()
  })

  it("does not touch unregistered places", () => {
    const row = publicRow({ place_id: "44444444-4444-4444-8444-444444444444", page_slug: "area-unregistered", place_slug: "area-unregistered", path: "/places/area-unregistered", name: "미등록 예식장", address: "서울 중구 세종대로 1 3층 (지번) 태평로1가 31" })
    const source = publicPlacePageRowToSource(row)
    expect(source?.address).toBe("서울 중구 세종대로 1 3층 (지번) 태평로1가 31")
    expect(source?.lastModifiedAt).toBe("2026-11-01T00:00:00.000Z")
  })
})

describe("공개 캐시 맞추기", () => {
  const place = { id: ENTRY.placeId, slug: ENTRY.expectedSlug, name: ENTRY.expectedName, address: ENTRY.expectedRawAddress }

  it("does nothing while the recorded verdict still holds", () => {
    const recorded = { [ENTRY.placeId]: verifiedAddressSignature(ENTRY, place) }
    expect(planVerifiedAddressCacheSync([ENTRY], [place], recorded).changes).toEqual([])
  })

  it("refreshes the place path on first sight, on drift to conflict and on recovery", () => {
    const first = planVerifiedAddressCacheSync([ENTRY], [place], {})
    expect(first.changes).toEqual([{ placeId: ENTRY.placeId, signature: verifiedAddressSignature(ENTRY, place), paths: [`/places/${ENTRY.expectedSlug}`] }])

    const matchedState = { [ENTRY.placeId]: verifiedAddressSignature(ENTRY, place) }
    const drifted = { ...place, address: "서울 강서구 강서로 388 9층" }
    const toConflict = planVerifiedAddressCacheSync([ENTRY], [drifted], matchedState)
    expect(toConflict.changes).toHaveLength(1)

    const conflictState = { [ENTRY.placeId]: verifiedAddressSignature(ENTRY, drifted) }
    expect(planVerifiedAddressCacheSync([ENTRY], [place], conflictState).changes).toHaveLength(1)
  })

  it("refreshes both the registered and the current path when the slug changed", () => {
    const renamed = { ...place, slug: "area-seoul-gangseogu-renamed" }
    const plan = planVerifiedAddressCacheSync([ENTRY], [renamed], { [ENTRY.placeId]: verifiedAddressSignature(ENTRY, place) })
    expect(plan.changes[0]?.paths).toEqual([`/places/${ENTRY.expectedSlug}`, "/places/area-seoul-gangseogu-renamed"])
  })

  it("refreshes after a revision bump", () => {
    const recorded = { [ENTRY.placeId]: verifiedAddressSignature(ENTRY, place) }
    expect(planVerifiedAddressCacheSync([{ ...ENTRY, revision: 2 }], [place], recorded).changes).toHaveLength(1)
  })
})

// 게시 코어 — 단건·배치·자동 게시가 모두 지나는 runPlacePublish에서 RPC 전에 막히는지 본다.
const publishPlacePage = vi.fn()
let currentPlace: Record<string, unknown> = {}
let appliedGenerations: readonly { readonly input: unknown }[] = []

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () =>
          table === "ai_generations"
            ? { eq: () => ({ order: () => ({ limit: () => Promise.resolve({ data: appliedGenerations, error: null }) }) }) }
            : { maybeSingle: () => Promise.resolve({ data: currentPlace, error: null }) },
      }),
    }),
  }),
}))
vi.mock("@/lib/seo-pages/place-publish", () => ({
  publishPlacePage: (...args: readonly unknown[]) => {
    publishPlacePage(...args)
    return Promise.resolve({ kind: "published", path: "/places/x" })
  },
}))
vi.mock("@/lib/seo-pages/supabase-place-publish", () => ({ createSupabasePlacePublishRepository: () => ({}) }))
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }))

describe("게시 직전 주소 대조", () => {
  const livePlace = {
    id: LIVE.placeId,
    slug: LIVE.expectedSlug,
    name: LIVE.expectedName,
    address: LIVE.expectedRawAddress,
    category: "숙박/행사",
    city: "경북",
    district: "경산시",
    description: `${LIVE.expectedName} 축하화환 주문 안내입니다.`,
    meta_title: `${LIVE.expectedName} 축하화환 주문 전 확인 사항`,
    meta_description: "축하화환 주문 전 확인 안내",
    faq: [],
    keywords: [],
  }
  const liveResolution = resolveVerifiedAddress({ placeId: LIVE.placeId, slug: LIVE.expectedSlug, name: LIVE.expectedName, rawAddress: LIVE.expectedRawAddress })
  const liveRecord = liveResolution.kind === "matched" ? addressResolutionRecordOf(liveResolution) : null

  beforeEach(() => {
    publishPlacePage.mockClear()
  })

  it("publishes when the applied generation was made under the current entry", async () => {
    currentPlace = livePlace
    appliedGenerations = [{ input: { address_resolution: liveRecord } }]
    const { runPlacePublish } = await import("@/lib/seo-pages/publish-runner")
    expect((await runPlacePublish(LIVE.placeId, { registerAfter: () => undefined })).kind).toBe("published")
    expect(publishPlacePage).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["the generation predates registration", () => livePlace, [{ input: {} }], "record-missing"],
    ["there is no applied generation", () => livePlace, [], "record-missing"],
    ["the generation used another revision", () => livePlace, [{ input: { address_resolution: { ...liveRecord, revision: 99 } } }], "record-stale"],
    ["the raw address drifted after generation", () => ({ ...livePlace, address: `${LIVE.verifiedAddress} 9층` }), [{ input: { address_resolution: liveRecord } }], "conflict"],
  ] as const)("never calls the publish RPC when %s", async (_label, place, generations, reason) => {
    currentPlace = place()
    appliedGenerations = generations
    const { runPlacePublish } = await import("@/lib/seo-pages/publish-runner")
    const result = await runPlacePublish(LIVE.placeId, { registerAfter: () => undefined })
    expect(result).toMatchObject({ kind: "address-blocked", reason })
    expect(publishPlacePage).not.toHaveBeenCalled()
  })
})
