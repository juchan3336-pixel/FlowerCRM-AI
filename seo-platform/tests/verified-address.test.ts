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
import { unwrapStoredGenerationInput, wrapGenerationInput } from "@/lib/ai/generation-mapping"
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
import { COARSE_ADDRESS_ONLY_SLUGS, quotedAddressForms, rewriteQuotedAddress } from "@/lib/public-seo/address-visibility"
import { publicPlacePageRowToSource } from "@/lib/public-seo/place-pages"
import { buildJsonLdObjects, listPublishedPublicPages } from "@/lib/public-seo/public-pages"
import {
  parseVerifiedAddressCacheState,
  planVerifiedAddressCacheSync,
  reconcileVerifiedAddressCacheWith,
  verifiedAddressSignature,
  type VerifiedAddressCacheState,
  type VerifiedAddressCacheStore,
} from "@/lib/seo-pages/verified-address-cache"
import { InMemorySyncRepository } from "@/lib/sync/in-memory-repository"
import { syncSheetRows } from "@/lib/sync/service"
import type { PublicPlacePageRow } from "@/types/database"

const ENTRY: VerifiedAddressEntry = {
  placeId: "11111111-1111-4111-8111-111111111111",
  status: "active",
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

describe("등록 이력 보존", () => {
  it("keeps a retired entry closed instead of falling back to the raw address", () => {
    expect(resolveVerifiedAddress(SUBJECT, [{ ...ENTRY, status: "retired" }])).toEqual({ kind: "conflict", placeId: ENTRY.placeId, fields: ["retired"] })
  })

  // 한 번 등록된 장소는 맵에서 사라지면 안 된다 — 줄을 지우면 '미등록'으로 보여 원문 주소가 조용히 돌아온다.
  // 더 쓰지 않을 엔트리는 status를 "retired"로 바꾼다. 이 목록에서 ID를 빼는 변경은 그 장소의 글·게시 상태를 정리한 뒤에만 한다.
  it("never drops a place that was once registered", () => {
    const everRegistered = [
      "f88d7783-6467-41c1-ac9b-a3c4d8d6aaca",
      "85337bca-b605-447b-92ba-f35736c2d196",
      "89ee1b23-f077-4e1f-b0a1-9f89fb8e5d4b",
      "4f5f6091-2273-4a4d-9cc2-2a8752f4c096", // 빌라드지디 논현
      "519787ec-c469-477c-87ca-932edc0f54b4", // 빌라드지디 수서
      "1c64e95a-3218-4413-a893-0a3892406f9d", // 더파티움 안양
      "1ce74f8e-a39d-4a20-9918-853882d3e7fd", // 셀럽앤어셈
      "2a9d9ee0-4936-4329-b263-0a7c7b536790", // 보테가마지오
      "3f787cb9-aa64-44e4-ba14-81f513a39e8a", // 아르떼서울
      "6751af79-bb0b-4862-a6d4-2772397f3255", // 로프트가든344
      "7372a53a-cc49-4c3a-a34b-aab0f530cc2b", // 더화이트베일
      "7dee0116-6156-46fe-8ebb-feb8703ed467", // 더바실리움
      "f30958ad-09bf-4fd8-9797-787f270e5106", // 규수당 문래점
      "f197bd40-4b28-4dbc-b775-c08c3cb874c3", // 노블발렌티 대치점
      "8fe6131d-fb63-4dd5-80ca-1eaf22b60209", // 레스케이프 서울 명동
      "964095ff-2448-4237-9a57-db9acdafee2a", // 루클라비
      "44e954f2-d9f3-46a9-8bc2-4033ea4496a7", // 아미드호텔서울
      "32d17a98-c9a5-4293-955a-e3294c4a25d0", // 아일랜드캐슬호텔
      "c3c432ed-614b-48a2-9e5e-856be91e01cf", // 호텔앙코르이비스 수원
    ]
    const present = new Set(VERIFIED_ADDRESSES.map((entry) => entry.placeId))
    expect(everRegistered.filter((placeId) => !present.has(placeId))).toEqual([])
    // 새 엔트리를 추가하면 위 목록에도 추가한다.
    expect(VERIFIED_ADDRESSES.map((entry) => entry.placeId).filter((placeId) => !everRegistered.includes(placeId))).toEqual([])
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

  it("rewrites stored quotations of the raw address to the final public address", () => {
    const raw = LIVE.expectedRawAddress
    const tailless = raw.replace(/\s*\(지번\).*$/, "")
    const source = publicPlacePageRowToSource(
      publicRow({
        page_description: `주소는 ${raw}입니다.`,
        place_description: `${tailless}에 위치한 예식장입니다.`,
        faq: [{ question: `${raw}로 보내면 되나요?`, answer: `네, 주소는 ${raw}입니다. 표기는 ${tailless}로도 씁니다.` }],
      }),
    )
    if (source === null) {
      throw new Error("matched 행이 공개에서 빠졌습니다")
    }
    const [page] = listPublishedPublicPages([source])
    const serialized = JSON.stringify(page)
    expect(page?.address).toBe(LIVE.verifiedAddress)
    expect(page?.description).toBe(`주소는 ${LIVE.verifiedAddress}입니다.`)
    expect(page?.placeBody).toBe(`${LIVE.verifiedAddress}에 위치한 예식장입니다.`)
    expect(page?.content.faq[0]).toEqual({ question: `${LIVE.verifiedAddress}로 보내면 되나요?`, answer: `네, 주소는 ${LIVE.verifiedAddress}입니다. 표기는 ${LIVE.verifiedAddress}로도 씁니다.` })
    expect(serialized).not.toContain("층")
    expect(serialized).not.toContain("(지번)")
  })

  it("keeps the coarse-address policy when a verified address is also applied", () => {
    // 축약 대상 장소에 검수 주소가 함께 걸리면, 새 글이 인용하는 검수 주소도 공개 주소보다 자세하다 — 세 표기 모두 축약돼야 한다.
    const [coarseSlug] = [...COARSE_ADDRESS_ONLY_SLUGS]
    const base = publicPlacePageRowToSource(publicRow())
    if (base === null || coarseSlug === undefined) {
      throw new Error("대역 준비 실패")
    }
    const raw = "경남 남해군 남해읍 화전로 169 2층 (지번) 남변리 123"
    const tailless = "경남 남해군 남해읍 화전로 169 2층"
    const effective = "경남 남해군 남해읍 화전로 169"
    const [page] = listPublishedPublicPages([
      {
        ...base,
        slug: coarseSlug,
        path: `/places/${coarseSlug}`,
        rawAddress: raw,
        address: effective,
        description: `주소는 ${effective}입니다.`,
        placeBody: `${tailless}에 있습니다. 원문 표기는 ${raw}입니다.`,
        content: { ...base.content, faq: [{ question: `${effective}로 보내면 되나요?`, answer: `주소는 ${raw}이며 ${tailless}, ${effective}로도 적습니다.` }] },
      },
    ])
    expect(page?.address).toBe("경남 남해군 남해읍")
    expect(page?.description).toBe("주소는 경남 남해군 남해읍입니다.")
    expect(page?.placeBody).toBe("경남 남해군 남해읍에 있습니다. 원문 표기는 경남 남해군 남해읍입니다.")
    expect(page?.content.faq[0]).toEqual({ question: "경남 남해군 남해읍로 보내면 되나요?", answer: "주소는 경남 남해군 남해읍이며 경남 남해군 남해읍, 경남 남해군 남해읍로도 적습니다." })
    if (page === undefined) {
      throw new Error("공개 변환 결과가 없습니다")
    }
    // 화면과 FAQ JSON-LD가 같은 DTO를 쓴다 — 구조화 데이터에도 도로명·건물번호가 남지 않는다.
    const jsonLd = JSON.stringify(buildJsonLdObjects(page))
    for (const leaked of ["화전로", "169", "2층", "(지번)", "남변리"]) {
      expect(JSON.stringify(page)).not.toContain(leaked)
      expect(jsonLd).not.toContain(leaked)
    }
  })

  it("does not rewrite twice or duplicate when the forms are prefixes of each other", () => {
    const forms = quotedAddressForms("서울 강서구 강서로 388 1-6층 (지번) 등촌동 678-14", "서울 강서구 강서로 388")
    expect(rewriteQuotedAddress(forms, "서울 강서구 강서로 388", "주소는 서울 강서구 강서로 388 1-6층 (지번) 등촌동 678-14, 줄여서 서울 강서구 강서로 388 1-6층, 또는 서울 강서구 강서로 388입니다.")).toBe(
      "주소는 서울 강서구 강서로 388, 줄여서 서울 강서구 강서로 388, 또는 서울 강서구 강서로 388입니다.",
    )
    expect(rewriteQuotedAddress(forms, null, "서울 강서구 강서로 388 1-6층")).toBe("서울 강서구 강서로 388 1-6층")
    expect(rewriteQuotedAddress(quotedAddressForms("A (1) [2] 3+4", "A"), "A", "주소 A (1) [2] 3+4 끝")).toBe("주소 A 끝")
  })

  it.each([
    ["the place columns are empty (LEFT JOIN miss)", { place_id: null, place_slug: null, name: null, category: null, address: null }],
    ["the page is linked to another place", { place_id: "55555555-5555-4555-8555-555555555555", place_slug: "area-other-place", name: "다른 예식장", address: "서울 중구 세종대로 1" }],
  ] as const)("takes a registered page slug off the public surface when %s", (_label, patch) => {
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
  const path = `/places/${ENTRY.expectedSlug}`
  const matchedRecord = { signature: verifiedAddressSignature(ENTRY, place), paths: [path] }
  const matchedState: VerifiedAddressCacheState = { [ENTRY.placeId]: matchedRecord }

  it("does nothing while the recorded verdict still holds", () => {
    expect(planVerifiedAddressCacheSync([ENTRY], [place], matchedState).changes).toEqual([])
  })

  it("refreshes the place path on first sight, on drift to conflict and on recovery", () => {
    expect(planVerifiedAddressCacheSync([ENTRY], [place], {}).changes).toEqual([{ placeId: ENTRY.placeId, next: matchedRecord, paths: [path] }])

    const drifted = { ...place, address: "서울 강서구 강서로 388 9층" }
    expect(planVerifiedAddressCacheSync([ENTRY], [drifted], matchedState).changes).toHaveLength(1)

    const conflictState: VerifiedAddressCacheState = { [ENTRY.placeId]: { signature: verifiedAddressSignature(ENTRY, drifted), paths: [path] } }
    expect(planVerifiedAddressCacheSync([ENTRY], [place], conflictState).changes).toHaveLength(1)
    expect(planVerifiedAddressCacheSync([{ ...ENTRY, status: "retired" }], [place], matchedState).changes).toHaveLength(1)
    expect(planVerifiedAddressCacheSync([{ ...ENTRY, revision: 2 }], [place], matchedState).changes).toHaveLength(1)
  })

  it("refreshes the registered and the current path when only the database slug changed", () => {
    const renamed = { ...place, slug: "area-seoul-gangseogu-renamed" }
    expect(planVerifiedAddressCacheSync([ENTRY], [renamed], matchedState).changes[0]?.paths).toEqual([path, "/places/area-seoul-gangseogu-renamed"])
  })

  it("still refreshes the previous path when the entry and the database slug moved together", () => {
    // 등록과 DB slug를 A → B로 함께 고치고 revision을 올린 경우 — /places/A의 캐시도 내려야 한다.
    const moved = { ...ENTRY, expectedSlug: "area-seoul-gangseogu-moved", revision: 2 }
    const plan = planVerifiedAddressCacheSync([moved], [{ ...place, slug: moved.expectedSlug }], matchedState)
    expect(plan.changes[0]?.paths).toEqual([path, "/places/area-seoul-gangseogu-moved"])
    expect(plan.changes[0]?.next?.paths).toEqual(["/places/area-seoul-gangseogu-moved"])
  })

  it("refreshes the previous path and drops the record when the entry disappeared", () => {
    expect(planVerifiedAddressCacheSync([], [], matchedState).changes).toEqual([{ placeId: ENTRY.placeId, next: null, paths: [path] }])
  })

  it("ignores malformed recorded state", () => {
    expect(parseVerifiedAddressCacheState({ a: "old-format", b: { signature: "s", paths: ["/places/x"] }, c: { signature: 1, paths: [] } })).toEqual({ b: { signature: "s", paths: ["/places/x"] } })
    expect(parseVerifiedAddressCacheState(null)).toEqual({})
  })

  function memoryStore(initial: VerifiedAddressCacheState, places: readonly (typeof place)[], failSave: () => boolean = () => false): VerifiedAddressCacheStore & { readonly state: () => VerifiedAddressCacheState } {
    let state = initial
    return {
      state: () => state,
      readState: () => Promise.resolve(state),
      readPlaces: () => Promise.resolve(places),
      saveState: (next) => {
        if (failSave()) {
          return Promise.reject(new Error("save failed"))
        }
        state = next
        return Promise.resolve()
      },
    }
  }

  it("keeps the old record when a path fails and retries every path on the next run", async () => {
    const moved = { ...ENTRY, expectedSlug: "area-seoul-gangseogu-moved", revision: 2 }
    const movedPath = "/places/area-seoul-gangseogu-moved"
    const store = memoryStore(matchedState, [{ ...place, slug: moved.expectedSlug }])
    const attempts: string[] = []
    let failNew = true
    const revalidate = (target: string): boolean => {
      attempts.push(target)
      return !(failNew && target === movedPath)
    }

    expect(await reconcileVerifiedAddressCacheWith(store, revalidate, [moved])).toEqual({ refreshed: 0, failed: 1 })
    // 실패한 경로가 있어도 나머지 경로는 시도했고, 기록은 옛 값 그대로다.
    expect(attempts).toEqual([path, movedPath])
    expect(store.state()).toEqual(matchedState)

    failNew = false
    attempts.length = 0
    expect(await reconcileVerifiedAddressCacheWith(store, revalidate, [moved])).toEqual({ refreshed: 1, failed: 0 })
    expect(attempts).toEqual([path, movedPath])
    expect(store.state()[ENTRY.placeId]?.paths).toEqual([movedPath])

    attempts.length = 0
    expect(await reconcileVerifiedAddressCacheWith(store, revalidate, [moved])).toEqual({ refreshed: 0, failed: 0 })
    expect(attempts).toEqual([])
  })

  it("surfaces a failed state save and revalidates again on the next run", async () => {
    let failSave = true
    const store = memoryStore({}, [place], () => failSave)
    const attempts: string[] = []
    const revalidate = (target: string): boolean => {
      attempts.push(target)
      return true
    }

    await expect(reconcileVerifiedAddressCacheWith(store, revalidate, [ENTRY])).rejects.toThrow("save failed")
    expect(store.state()).toEqual({})

    failSave = false
    expect(await reconcileVerifiedAddressCacheWith(store, revalidate, [ENTRY])).toEqual({ refreshed: 1, failed: 0 })
    expect(attempts).toEqual([path, path])
    expect(store.state()).toEqual(matchedState)
  })

  it("refreshes the old path once after an entry is removed, then forgets it", async () => {
    const store = memoryStore(matchedState, [])
    const attempts: string[] = []
    const revalidate = (target: string): boolean => {
      attempts.push(target)
      return true
    }
    expect(await reconcileVerifiedAddressCacheWith(store, revalidate, [])).toEqual({ refreshed: 1, failed: 0 })
    expect(attempts).toEqual([path])
    expect(store.state()).toEqual({})
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

  // ai_generations.input의 실제 저장 형식으로 감싼다 (lib/ai/generation-mapping.ts wrapGenerationInput과 같은 모양).
  const stored = (generationInput: Record<string, unknown>): Record<string, unknown> => ({ generation_input: generationInput, before: null })

  beforeEach(() => {
    publishPlacePage.mockClear()
  })

  it("keeps the test wrapper identical to the real stored shape", () => {
    const sample = { content_mode: "celebration", place: { id: "p", name: "n", category: "c", city: null, district: null, address: null, homepage: null }, guardrails: [] } as const
    expect(stored({ ...sample })).toEqual(wrapGenerationInput(sample, null))
    expect(unwrapStoredGenerationInput(wrapGenerationInput(sample, null))).toEqual(sample)
    expect(unwrapStoredGenerationInput(sample)).toEqual(sample)
    expect(unwrapStoredGenerationInput(null)).toBeNull()
  })

  it("publishes when the applied generation was made under the current entry", async () => {
    currentPlace = livePlace
    // 실제 저장 형식 — apply 뒤의 input은 { generation_input, before } 래퍼다.
    appliedGenerations = [{ input: stored({ address_resolution: liveRecord }) }]
    const { runPlacePublish } = await import("@/lib/seo-pages/publish-runner")
    expect((await runPlacePublish(LIVE.placeId, { registerAfter: () => undefined })).kind).toBe("published")
    expect(publishPlacePage).toHaveBeenCalledTimes(1)

    // 래퍼가 없던 구 형식도 같은 결과다.
    appliedGenerations = [{ input: { address_resolution: liveRecord } }]
    expect((await runPlacePublish(LIVE.placeId, { registerAfter: () => undefined })).kind).toBe("published")
  })

  it("never publishes content generated under an entry that no longer exists", async () => {
    // 엔트리가 사라져 지금은 미등록으로 보이는 장소 — 생성 기록이 남아 있으면 게시하지 않는다.
    const orphanId = "66666666-6666-4666-8666-666666666666"
    currentPlace = { ...livePlace, id: orphanId, slug: "area-unregistered-now", name: "미등록 예식장" }
    appliedGenerations = [{ input: stored({ address_resolution: liveRecord }) }]
    const { runPlacePublish } = await import("@/lib/seo-pages/publish-runner")
    expect(await runPlacePublish(orphanId, { registerAfter: () => undefined })).toMatchObject({ kind: "address-blocked", reason: "record-stale" })
    expect(publishPlacePage).not.toHaveBeenCalled()

    // 기록이 없는 미등록 장소는 기존대로 게시된다.
    appliedGenerations = [{ input: stored({}) }]
    expect((await runPlacePublish(orphanId, { registerAfter: () => undefined })).kind).toBe("published")
  })

  it.each([
    ["the generation predates registration", () => livePlace, [{ input: stored({}) }], "record-missing"],
    ["there is no applied generation", () => livePlace, [], "record-missing"],
    ["the generation used another revision", () => livePlace, [{ input: stored({ address_resolution: { ...liveRecord, revision: 99 } }) }], "record-stale"],
    ["the raw address drifted after generation", () => ({ ...livePlace, address: `${LIVE.verifiedAddress} 9층` }), [{ input: stored({ address_resolution: liveRecord }) }], "conflict"],
  ] as const)("never calls the publish RPC when %s", async (_label, place, generations, reason) => {
    currentPlace = place()
    appliedGenerations = generations
    const { runPlacePublish } = await import("@/lib/seo-pages/publish-runner")
    const result = await runPlacePublish(LIVE.placeId, { registerAfter: () => undefined })
    expect(result).toMatchObject({ kind: "address-blocked", reason })
    expect(publishPlacePage).not.toHaveBeenCalled()
  })
})
