// 검수 주소 — DB 주소(places.address)에 공식 사이트에서 확인하지 못한 층·동·호가 붙어 있는 장소에 대해,
// 공식 원문에서 글자 대조로 확인한 "도로명 + 건물번호"까지만 생성 입력과 공개 주소로 쓴다.
//
// - DB 원문은 바꾸지 않는다. 미확인 상세가 틀렸다는 뜻도 아니다 — 확인하지 못한 것을 쓰지 않을 뿐이다.
// - 주키는 placeId다. SEO 페이지는 생성 뒤에 생기므로 SEO 페이지 ID에 기대면 생성 단계와 순환한다.
// - 등록된 장소의 slug·이름·DB 원문이 등록 시점과 달라지면 "conflict"다. 이때 원문으로 되돌아가지 않는다:
//   생성·적용·게시를 멈추고 공개 표면에서도 내린다. 사람이 엔트리를 다시 확인해 revision을 올려야 풀린다.
// - 전역 정규식으로 층·호를 잘라내는 방식은 쓰지 않는다. 등록된 장소만, 등록된 값으로만 바꾼다.
import { createHash } from "node:crypto"

export type VerifiedAddressEntry = {
  readonly placeId: string
  readonly expectedSlug: string
  readonly expectedName: string
  // 등록 시점에 읽은 places.address 원문 그대로 (꼬리 표기 포함)
  readonly expectedRawAddress: string
  // 공식 원문에서 확인한 도로명 + 건물번호까지의 주소 (DB 표기 형식에 맞춘 시·도 약칭)
  readonly verifiedAddress: string
  readonly sourceUrl: string
  // sourceUrl 페이지에 글자 그대로 있는 문구
  readonly sourceQuote: string
  readonly reason: string
  // 공식 원문을 확인한 날 (YYYY-MM-DD)
  readonly reviewedAt: string
  // 엔트리 내용이 바뀔 때마다 1씩 올린다 — 생성 기록과 대조해 "생성 뒤에 맵이 바뀐 글"을 걸러낸다.
  readonly revision: number
  // 이 엔트리를 실제로 수정한 시각 (ISO). 공개 수정 시각(lastmod)에 반영된다 — 재확인만 했다면 올리지 않는다.
  readonly contentUpdatedAt: string
}

const UNVERIFIED_DETAIL_REASON = "DB 주소의 층·호 표기를 공식 사이트에서 확인하지 못해 생성·공개 주소에서 사용하지 않음"

export const VERIFIED_ADDRESSES: readonly VerifiedAddressEntry[] = [
  {
    placeId: "f88d7783-6467-41c1-ac9b-a3c4d8d6aaca",
    expectedSlug: "area-gyeongbuk-gyeongsansi-deoateuraum",
    expectedName: "더아트라움",
    expectedRawAddress: "경북 경산시 계양로 38 1,3-4층 (지번) 계양동 681",
    verifiedAddress: "경북 경산시 계양로 38",
    sourceUrl: "https://xn--oi2b94xv6ae01a.kr/page/location.php",
    sourceQuote: "경상북도 경산시 계양로 38 더아트라움",
    reason: UNVERIFIED_DETAIL_REASON,
    reviewedAt: "2026-11-11",
    revision: 1,
    contentUpdatedAt: "2026-11-11T04:26:03.000Z",
  },
  {
    placeId: "85337bca-b605-447b-92ba-f35736c2d196",
    expectedSlug: "area-gyeonggi-ansansi-deo-benireu",
    expectedName: "더 베니르",
    expectedRawAddress: "경기 안산시 단원구 광덕4로 256 1,3-5층 (지번) 고잔동 729-8",
    verifiedAddress: "경기 안산시 단원구 광덕4로 256",
    sourceUrl: "https://www.the-venir.com/location/",
    sourceQuote: "경기 안산시 단원구 광덕4로 256",
    reason: UNVERIFIED_DETAIL_REASON,
    reviewedAt: "2026-11-11",
    revision: 1,
    contentUpdatedAt: "2026-11-11T04:26:03.000Z",
  },
  {
    placeId: "89ee1b23-f077-4e1f-b0a1-9f89fb8e5d4b",
    expectedSlug: "area-seoul-gangseogu-deobenyujiseoul",
    expectedName: "더베뉴지서울",
    expectedRawAddress: "서울 강서구 강서로 388 지하1-지하5층, 1-6층 (지번) 등촌동 678-14",
    verifiedAddress: "서울 강서구 강서로 388",
    sourceUrl: "https://www.venueg.co.kr/92",
    sourceQuote: "도로명 주소 : 서울특별시 강서구 강서로 388 더 베뉴지 서울",
    reason: UNVERIFIED_DETAIL_REASON,
    reviewedAt: "2026-11-11",
    revision: 1,
    contentUpdatedAt: "2026-11-11T04:26:03.000Z",
  },
]

export type VerifiedAddressConflictField = "slug" | "name" | "raw-address" | "place-id"

export type VerifiedAddressResolution =
  | { readonly kind: "not-registered" }
  | { readonly kind: "matched"; readonly address: string; readonly revision: number; readonly rawAddressHash: string; readonly contentUpdatedAt: string }
  | { readonly kind: "conflict"; readonly placeId: string; readonly fields: readonly VerifiedAddressConflictField[] }

export type VerifiedAddressSubject = {
  readonly placeId: string | null
  readonly slug: string | null
  readonly name: string | null
  readonly rawAddress: string | null
}

export function rawAddressHash(rawAddress: string | null): string {
  return createHash("sha256").update(rawAddress ?? "", "utf8").digest("hex")
}

// 등록 여부와 일치 여부를 함께 판정한다.
// placeId로 찾지 못했더라도 slug가 등록 장소의 것이면 conflict다 — 잘못된 ID가 넘어온 호출이 "미등록"으로 빠져
// 원문 주소를 그대로 쓰는 일을 막는다.
export function resolveVerifiedAddress(subject: VerifiedAddressSubject, entries: readonly VerifiedAddressEntry[] = VERIFIED_ADDRESSES): VerifiedAddressResolution {
  const byId = subject.placeId === null ? undefined : entries.find((entry) => entry.placeId === subject.placeId)
  if (byId === undefined) {
    const bySlug = subject.slug === null ? undefined : entries.find((entry) => entry.expectedSlug === subject.slug)
    return bySlug === undefined ? { kind: "not-registered" } : { kind: "conflict", placeId: bySlug.placeId, fields: ["place-id"] }
  }
  const fields: VerifiedAddressConflictField[] = []
  if (subject.slug !== byId.expectedSlug) {
    fields.push("slug")
  }
  if (subject.name !== byId.expectedName) {
    fields.push("name")
  }
  if (subject.rawAddress !== byId.expectedRawAddress) {
    fields.push("raw-address")
  }
  if (fields.length > 0) {
    return { kind: "conflict", placeId: byId.placeId, fields }
  }
  return { kind: "matched", address: byId.verifiedAddress, revision: byId.revision, rawAddressHash: rawAddressHash(byId.expectedRawAddress), contentUpdatedAt: byId.contentUpdatedAt }
}

export function isVerifiedAddressRegistered(placeId: string, entries: readonly VerifiedAddressEntry[] = VERIFIED_ADDRESSES): boolean {
  return entries.some((entry) => entry.placeId === placeId)
}

// 생성 입력(ai_generations.input)에 남기는 재현용 기록.
export type AddressResolutionRecord = {
  readonly revision: number
  readonly effective_address: string
  readonly raw_address_hash: string
}

export function addressResolutionRecordOf(resolution: Extract<VerifiedAddressResolution, { kind: "matched" }>): AddressResolutionRecord {
  return { revision: resolution.revision, effective_address: resolution.address, raw_address_hash: resolution.rawAddressHash }
}

export type GenerationAddressCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "conflict" | "record-missing" | "record-stale"; readonly detail: string }

// 생성 기록이 지금의 판정과 같은가 — 적용·검수 해소·게시 직전에 같은 함수로 본다.
// 등록 장소인데 기록이 없는 글(등록 전에 만든 글)과, 생성 뒤에 맵·원문이 바뀐 글은 통과시키지 않는다.
// 미등록 장소는 기록이 없어야 정상이다. 기록이 있는데 지금은 미등록이면(엔트리 삭제) 그 글의 주소 전제가 사라진 것이라 막는다.
export function checkGenerationAddressRecord(resolution: VerifiedAddressResolution, record: unknown): GenerationAddressCheck {
  const parsed = parseAddressResolutionRecord(record)
  if (resolution.kind === "conflict") {
    return { ok: false, reason: "conflict", detail: `검수 주소 등록 값과 현재 장소 정보가 다름: ${resolution.fields.join(", ")}` }
  }
  if (resolution.kind === "not-registered") {
    return parsed === null ? { ok: true } : { ok: false, reason: "record-stale", detail: "생성 당시에는 검수 주소가 등록돼 있었으나 지금은 등록이 없음" }
  }
  if (parsed === null) {
    return { ok: false, reason: "record-missing", detail: "검수 주소 등록 전에 만든 글 — 주소 기록이 없음" }
  }
  if (parsed.revision !== resolution.revision || parsed.effective_address !== resolution.address || parsed.raw_address_hash !== resolution.rawAddressHash) {
    return { ok: false, reason: "record-stale", detail: `생성 당시 주소 기록(revision ${String(parsed.revision)})이 현재 검수 주소(revision ${String(resolution.revision)})와 다름` }
  }
  return { ok: true }
}

export function parseAddressResolutionRecord(value: unknown): AddressResolutionRecord | null {
  if (typeof value !== "object" || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  const revision = record["revision"]
  const effective = record["effective_address"]
  const hash = record["raw_address_hash"]
  if (typeof revision !== "number" || typeof effective !== "string" || typeof hash !== "string") {
    return null
  }
  return { revision, effective_address: effective, raw_address_hash: hash }
}

// 엔트리 자체의 무결성 — 테스트가 운영 맵에 대해 실행한다 (잘못된 엔트리는 merge 전에 걸러진다).
export function validateVerifiedAddressEntries(entries: readonly VerifiedAddressEntry[], nowIso: string): readonly string[] {
  const problems: string[] = []
  const seenIds = new Set<string>()
  const seenSlugs = new Set<string>()
  for (const entry of entries) {
    const label = entry.expectedName.length > 0 ? entry.expectedName : entry.placeId
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.placeId)) {
      problems.push(`${label}: placeId 형식 오류`)
    }
    if (seenIds.has(entry.placeId)) {
      problems.push(`${label}: placeId 중복`)
    }
    if (seenSlugs.has(entry.expectedSlug)) {
      problems.push(`${label}: slug 중복`)
    }
    seenIds.add(entry.placeId)
    seenSlugs.add(entry.expectedSlug)
    for (const [field, value] of [
      ["expectedSlug", entry.expectedSlug],
      ["expectedName", entry.expectedName],
      ["expectedRawAddress", entry.expectedRawAddress],
      ["verifiedAddress", entry.verifiedAddress],
      ["sourceQuote", entry.sourceQuote],
      ["reason", entry.reason],
    ] as const) {
      if (value.trim().length === 0 || value !== value.trim()) {
        problems.push(`${label}: ${field} 비어 있거나 앞뒤 공백`)
      }
    }
    // 검수 주소는 도로명 + 건물번호로 끝나야 한다 — 층·동·호나 건물명이 섞이면 "확인된 부분만"이라는 전제가 깨진다.
    if (!/[가-힣0-9](로|길) \d+(-\d+)?$/.test(entry.verifiedAddress)) {
      problems.push(`${label}: verifiedAddress가 도로명 + 건물번호로 끝나지 않음`)
    }
    // DB 원문이 검수 주소로 시작해야 한다 — 다른 도로명·번호로 바꾸는 엔트리는 이 맵의 용도가 아니다.
    if (!entry.expectedRawAddress.startsWith(`${entry.verifiedAddress} `)) {
      problems.push(`${label}: DB 원문이 verifiedAddress로 시작하지 않음`)
    }
    if (!/^https:\/\/[^\s]+$/.test(entry.sourceUrl) && !/^http:\/\/[^\s]+$/.test(entry.sourceUrl)) {
      problems.push(`${label}: sourceUrl 형식 오류`)
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewedAt) || Number.isNaN(Date.parse(`${entry.reviewedAt}T00:00:00Z`))) {
      problems.push(`${label}: reviewedAt 형식 오류`)
    }
    if (!Number.isInteger(entry.revision) || entry.revision < 1) {
      problems.push(`${label}: revision은 1 이상의 정수`)
    }
    const updated = Date.parse(entry.contentUpdatedAt)
    if (Number.isNaN(updated) || new Date(updated).toISOString() !== entry.contentUpdatedAt) {
      problems.push(`${label}: contentUpdatedAt 형식 오류`)
    } else if (updated > Date.parse(nowIso)) {
      problems.push(`${label}: contentUpdatedAt이 미래`)
    }
  }
  return problems
}
