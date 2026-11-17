import "server-only"

// 공공등록(e하늘) 근거로 장례식장 한 곳을 확인 완료(verified)로 기록한다 — ops 작업 step 하나가 장소 하나를 다룬다.
//
// 쓰는 것: places의 확인 상태·확인 주체·확인 시각·출처 URL, 그리고 settings의 감사 기록 한 행. 수집 원문(이름·주소·전화)과
// 공개 콘텐츠는 건드리지 않는다. 확인 완료는 생성 후보가 된다는 뜻일 뿐 게시가 아니다.
//
// 순서:
//  1) 장소를 읽고 대상 조건 확인 — 장례식장·draft·확인 전·제외 없음·생성/배치/SEO 이력 없음·추모/숙박 이름 아님,
//     읽은 장소의 지문이 설정에 고정한 지문과 같음(그 사이 수집 동기화로 이름·주소·전화가 바뀌었으면 쓰지 않는다)
//  2) e하늘 상세를 정해진 주소에서만 읽고(제한 시간·형식 검사), 근거 지문이 승인한 지문과 같은지 확인
//  3) 본체 일치 판정(judgeRegistryMatch)과 기게시 장례식장과의 시설 단위 중복 확인
//  4) 조건부 갱신(CAS) — 읽은 이름·주소·전화·업종·상태·확인 전 상태가 그대로일 때만, 정확히 1행
//  5) 감사 기록 — 실패하면 실패로 보고한다. 같은 step을 다시 실행하면 "이미 같은 근거로 확인됨"을 알아보고 감사만 마저 남긴다.
import { isLodgingFacilityName, isMemorialFacilityName } from "@/lib/domain/facility-type"
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { Json } from "@/types/database"
import {
  EHANEUL_ORIGIN,
  ehaneulDetailUrl,
  evidenceFingerprint,
  judgeRegistryMatch,
  parseEhaneulDetail,
  placeFingerprint,
  REGISTRY_VERIFIED_BY,
  REGISTRY_VERIFY_POLICY_VERSION,
  registryAuditKey,
  roadKey,
  sameRegion,
  type RegistryEvidence,
  type RegistryMatchField,
  type RegistryPlace,
  type RegistryVerifyStep,
} from "./registry-verify"

export type RegistryVerifyBlock =
  | "place-not-found"
  | "not-funeral"
  | "not-draft"
  | "already-verified-other"
  | "excluded"
  | "has-pipeline-state"
  | "facility-name-blocked"
  | "place-changed"
  | "evidence-changed"
  | "not-funeral-group"
  | "no-rooms"
  | "missing-address"
  | "region-mismatch"
  | "road-mismatch"
  | "weak-match"
  | "sub-facility-name"
  | "address-detail"
  | "published-duplicate"
  // 갱신 조건이 맞지 않아 0행 — 그 사이 다른 경로가 장소를 바꿨다. 아무것도 쓰지 않았다.
  | "write-conflict"

export type RegistryVerifyResult =
  | { readonly kind: "verified"; readonly matched: readonly RegistryMatchField[]; readonly sourceUrl: string; readonly resumed: boolean }
  | { readonly kind: "blocked"; readonly reason: RegistryVerifyBlock }
  // fetch·parse: 근거를 읽지 못했다(아무것도 쓰지 않음, 다시 실행 가능). write: 갱신 오류. audit: 확인은 기록됐고 감사만 못 남겼다(다시 실행하면 이어서 남긴다).
  | { readonly kind: "failed"; readonly step: "fetch" | "parse" | "write" | "audit" }

export type RegistryVerifyDeps = {
  readonly fetchImpl?: typeof fetch
  readonly now?: () => Date
  readonly timeoutMs?: number
}

const PLACE_COLUMNS = "id,name,status,category,official_verification_status,exclusion_reason,address,phone,verified_by,verification_source_urls"
const DEFAULT_TIMEOUT_MS = 10_000

export async function runRegistryVerify(step: RegistryVerifyStep, actor: string, deps: RegistryVerifyDeps = {}): Promise<RegistryVerifyResult> {
  const client = createSupabaseServiceRoleClient()
  const now = deps.now ?? (() => new Date())
  const sourceUrl = ehaneulDetailUrl(step.facilitycd)

  const placeRead = await client.from("places").select(PLACE_COLUMNS).eq("id", step.placeId).maybeSingle()
  if (placeRead.error !== null) {
    throw new Error("Failed to load registry-verify target")
  }
  const place = placeRead.data as (RegistryPlace & { verified_by: string | null; verification_source_urls: Json | null }) | null
  if (place === null) {
    return { kind: "blocked", reason: "place-not-found" }
  }

  // 이미 같은 근거로 확인된 장소 — 이전 실행이 갱신 뒤 감사 기록에서 멈췄을 수 있다. 감사가 없으면 마저 남긴다.
  if (place.official_verification_status === "verified") {
    const sameSource = place.verified_by === REGISTRY_VERIFIED_BY && Array.isArray(place.verification_source_urls) && place.verification_source_urls.includes(sourceUrl)
    if (!sameSource) {
      return { kind: "blocked", reason: "already-verified-other" }
    }
    const existing = await client.from("settings").select("key").eq("key", registryAuditKey(step.placeId)).maybeSingle()
    if (existing.error !== null) {
      return { kind: "failed", step: "audit" }
    }
    if (existing.data !== null) {
      return { kind: "verified", matched: [], sourceUrl, resumed: true }
    }
    // 확인은 기록됐는데 감사가 없다 — 같은 근거를 다시 읽어 승인한 근거와 같을 때만 감사를 마저 남긴다.
    const again = await fetchEvidence(step.facilitycd, deps)
    if (again.kind !== "ok") {
      return { kind: "failed", step: again.kind }
    }
    if (evidenceFingerprint(again.value) !== step.expectedEvidenceHash) {
      return { kind: "blocked", reason: "evidence-changed" }
    }
    const rematch = judgeRegistryMatch(place, again.value)
    const audit = buildAudit(step, actor, { ...place, official_verification_status: null }, again.value, rematch.ok ? rematch.matched : [], sourceUrl, now().toISOString())
    const saved = await client.from("settings").insert({ key: registryAuditKey(step.placeId), value: { ...audit, resumed_audit: true } as unknown as Json })
    if (saved.error !== null && saved.error.code !== "23505") {
      return { kind: "failed", step: "audit" }
    }
    return { kind: "verified", matched: rematch.ok ? rematch.matched : [], sourceUrl, resumed: true }
  }

  if (place.category !== "funeral") {
    return { kind: "blocked", reason: "not-funeral" }
  }
  if (place.status !== "draft") {
    return { kind: "blocked", reason: "not-draft" }
  }
  if (place.official_verification_status === "excluded" || place.exclusion_reason !== null) {
    return { kind: "blocked", reason: "excluded" }
  }
  if (place.official_verification_status !== null) {
    return { kind: "blocked", reason: "already-verified-other" }
  }
  if (isMemorialFacilityName(place.name) || isLodgingFacilityName(place.name)) {
    return { kind: "blocked", reason: "facility-name-blocked" }
  }
  if (placeFingerprint(place) !== step.expectedPlaceHash) {
    return { kind: "blocked", reason: "place-changed" }
  }
  const [generations, items, seoPages] = await Promise.all([
    client.from("ai_generations").select("id", { count: "exact", head: true }).eq("place_id", step.placeId),
    client.from("batch_run_items").select("id", { count: "exact", head: true }).eq("place_id", step.placeId),
    client.from("seo_pages").select("id", { count: "exact", head: true }).eq("place_id", step.placeId),
  ])
  if (generations.error !== null || items.error !== null || seoPages.error !== null) {
    throw new Error("Failed to load registry-verify pipeline state")
  }
  if ((generations.count ?? 0) + (items.count ?? 0) + (seoPages.count ?? 0) > 0) {
    return { kind: "blocked", reason: "has-pipeline-state" }
  }

  // 근거는 정해진 공공 호스트의 한 주소에서만 읽는다.
  const evidence = await fetchEvidence(step.facilitycd, deps)
  if (evidence.kind !== "ok") {
    return { kind: "failed", step: evidence.kind }
  }
  if (evidenceFingerprint(evidence.value) !== step.expectedEvidenceHash) {
    return { kind: "blocked", reason: "evidence-changed" }
  }
  const match = judgeRegistryMatch(place, evidence.value)
  if (!match.ok) {
    return { kind: "blocked", reason: match.reason }
  }

  // 같은 시설이 이미 공개돼 있는가 — 시도·시군구 + 도로명·건물번호가 같은 게시 장례식장이 있으면 중복 의심으로 멈춘다.
  const published = await client.from("places").select("id,name,address").eq("category", "funeral").eq("status", "published")
  if (published.error !== null) {
    throw new Error("Failed to load published funeral places")
  }
  const registryRoad = roadKey(evidence.value.fulladdress)
  const duplicate = (published.data as { id: string; name: string; address: string | null }[]).some(
    (row) => row.address !== null && roadKey(row.address) === registryRoad && sameRegion(row.address, evidence.value.fulladdress),
  )
  if (duplicate) {
    return { kind: "blocked", reason: "published-duplicate" }
  }

  // 조건부 갱신 — 읽은 값이 그대로일 때만. 정확히 1행이 아니면 성공으로 세지 않는다.
  const verifiedAt = now().toISOString()
  let update = client
    .from("places")
    .update({ official_verification_status: "verified", verified_at: verifiedAt, verified_by: REGISTRY_VERIFIED_BY, verification_source_urls: [sourceUrl] })
    .eq("id", step.placeId)
    .eq("status", "draft")
    .eq("category", "funeral")
    .eq("name", place.name)
    .is("official_verification_status", null)
    .is("exclusion_reason", null)
  update = place.address === null ? update.is("address", null) : update.eq("address", place.address)
  update = place.phone === null ? update.is("phone", null) : update.eq("phone", place.phone)
  const written = await update.select("id")
  if (written.error !== null) {
    return { kind: "failed", step: "write" }
  }
  if (written.data.length !== 1) {
    return { kind: "blocked", reason: "write-conflict" }
  }

  const audit = buildAudit(step, actor, place, evidence.value, match.matched, sourceUrl, verifiedAt)
  const saved = await client.from("settings").insert({ key: registryAuditKey(step.placeId), value: audit as unknown as Json })
  if (saved.error !== null && saved.error.code !== "23505") {
    return { kind: "failed", step: "audit" }
  }
  return { kind: "verified", matched: match.matched, sourceUrl, resumed: false }
}

type EvidenceRead = { readonly kind: "ok"; readonly value: RegistryEvidence } | { readonly kind: "fetch" | "parse" }

async function fetchEvidence(facilitycd: string, deps: RegistryVerifyDeps): Promise<EvidenceRead> {
  const url = ehaneulDetailUrl(facilitycd)
  if (!url.startsWith(`${EHANEUL_ORIGIN}/`)) {
    return { kind: "fetch" }
  }
  const fetchImpl = deps.fetchImpl ?? fetch
  let body: unknown
  try {
    const response = await fetchImpl(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS), headers: { Accept: "application/json" } })
    if (!response.ok) {
      return { kind: "fetch" }
    }
    body = await response.json()
  } catch {
    return { kind: "fetch" }
  }
  const parsed = parseEhaneulDetail(body, facilitycd)
  return parsed === null ? { kind: "parse" } : { kind: "ok", value: parsed }
}

function buildAudit(
  step: RegistryVerifyStep,
  actor: string,
  place: RegistryPlace,
  evidence: RegistryEvidence,
  matched: readonly RegistryMatchField[],
  sourceUrl: string,
  verifiedAt: string,
): Record<string, unknown> {
  return {
    policy_version: REGISTRY_VERIFY_POLICY_VERSION,
    tier: "public-registry",
    // 이 등급이 확인하지 않은 것 — 생성·공개에서 단정하지 않는다.
    not_confirmed: ["current-operation", "wreath-policy"],
    actor,
    reason: step.reason,
    verified_at: verifiedAt,
    source_url: sourceUrl,
    facilitycd: step.facilitycd,
    evidence,
    evidence_hash: step.expectedEvidenceHash,
    place_hash: step.expectedPlaceHash,
    matched,
    before: { status: place.status, official_verification_status: place.official_verification_status, name: place.name, address: place.address, phone: place.phone },
    after: { official_verification_status: "verified", verified_by: REGISTRY_VERIFIED_BY, verified_at: verifiedAt, verification_source_urls: [sourceUrl] },
  }
}
