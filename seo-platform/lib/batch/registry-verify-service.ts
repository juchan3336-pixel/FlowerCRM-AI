import "server-only"

// 공공등록(e하늘) 근거로 장례식장 한 곳을 확인 완료(verified)로 기록한다 — ops 작업 step 하나가 장소 하나를 다룬다.
//
// 쓰는 것: places의 확인 상태·확인 주체·확인 시각·출처 URL, 그리고 settings의 감사 기록 한 행. 수집 원문(이름·주소·전화)과
// 공개 콘텐츠는 건드리지 않는다. 확인 완료는 생성 후보가 된다는 뜻일 뿐 게시가 아니다.
//
// 순서:
//  1) 장소와 기존 감사 기록을 읽는다. 감사 기록이 있으면 이 step과 같은 원본(정책·장소·시설·지문)인지 내용으로 확인한다.
//  2) 대상 조건 — 장례식장·draft·확인 전·제외 없음·생성/배치/SEO 이력 없음·추모/숙박 이름 아님, 장소 지문이 승인 지문과 같음
//  3) 현행 목록(작업당 한 번 조회)에 있고 가격정보 수정일이 365일 이내, 상세를 정해진 주소에서 읽어 근거 지문이 승인 지문과 같음
//  4) 본체 일치 판정(judgeRegistryMatch)과 같은 시설의 다른 행(게시·확인·후보)·다른 장소의 같은 시설 감사 기록 확인
//  5) 감사 의도(pending)를 먼저 남긴다 — 쓰기 전에 무엇을 근거로 쓰는지를 보존한다
//  6) 조건부 갱신(CAS) — 읽은 이름·주소·전화·업종·상태·확인 전 상태가 그대로일 때만, 정확히 1행
//  7) 감사 확정(done) — 실제 확인 시각과 목록 조회 기록을 붙인다
// 다시 실행: 의도만 있고 갱신 전이면 2)부터 전부 다시 본다. 갱신 뒤 확정에서 멈췄으면 장소를 다시 읽어
// (확인 상태만 되돌린) 지문이 승인 지문과 같을 때만 장소에 기록된 확인 시각으로 확정한다. 확정된 감사는 장소가 그대로일 때만 성공으로 센다.
import { isLodgingFacilityName, isMemorialFacilityName } from "@/lib/domain/facility-type"
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { Json } from "@/types/database"
import {
  combineEvidence,
  EHANEUL_LIST_URL,
  EHANEUL_ORIGIN,
  ehaneulDetailUrl,
  evidenceFingerprint,
  judgeRegistryMatch,
  listAgeDays,
  parseEhaneulDetail,
  parseEhaneulList,
  parseRoadAddress,
  placeFingerprint,
  placeFingerprintBeforeVerification,
  REGISTRY_LIST_MAX_AGE_DAYS,
  REGISTRY_VERIFIED_BY,
  REGISTRY_VERIFY_AUDIT_PREFIX,
  REGISTRY_VERIFY_POLICY_VERSION,
  registryAuditKey,
  sameRegion,
  SUB_FACILITY_PATTERN,
  type RegistryEvidence,
  type RegistryListRow,
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
  | "not-in-current-list"
  | "registry-stale"
  | "not-funeral-group"
  | "no-rooms"
  | "missing-address"
  | "region-mismatch"
  | "road-mismatch"
  | "weak-match"
  | "sub-facility-name"
  | "address-detail"
  | "published-duplicate"
  | "verified-duplicate"
  | "candidate-duplicate"
  | "facility-claimed"
  // 감사 기록이 이 step과 다른 원본을 가리킨다(정책·시설·지문·확인 시각) — 덮어쓰지도 성공으로 세지도 않는다.
  | "audit-mismatch"
  // 이 경로의 확인 상태가 있는데 감사 기록이 없다 — 원본을 증명할 수 없어 복구하지 않는다.
  | "audit-missing"
  // 갱신 조건이 맞지 않아 0행 — 그 사이 다른 경로가 장소를 바꿨다. 장소는 쓰지 않았다(감사 의도만 남음).
  | "write-conflict"

export type RegistryVerifyResult =
  | { readonly kind: "verified"; readonly matched: readonly RegistryMatchField[]; readonly sourceUrl: string; readonly resumed: boolean }
  | { readonly kind: "blocked"; readonly reason: RegistryVerifyBlock }
  // list·fetch·parse: 근거를 읽지 못했다(장소는 쓰지 않음, 다시 실행 가능). write: 갱신 오류. audit: 감사 기록 저장 실패(다시 실행하면 이어서 확정).
  | { readonly kind: "failed"; readonly step: "list" | "fetch" | "parse" | "write" | "audit" }

export type RegistryListRead =
  | { readonly kind: "ok"; readonly fetchedAt: string; readonly rows: ReadonlyMap<string, RegistryListRow> }
  | { readonly kind: "fetch" | "parse" }

export type RegistryVerifyDeps = {
  readonly fetchImpl?: typeof fetch
  readonly now?: () => Date
  readonly timeoutMs?: number
  // 현행 목록 — 한 작업의 step들이 같은 조회 결과를 쓰도록 호출자가 넘긴다. 없으면 이 step에서 한 번 읽는다.
  readonly loadList?: () => Promise<RegistryListRead>
}

const PLACE_COLUMNS = "id,name,status,category,official_verification_status,exclusion_reason,address,phone,verified_by,verified_at,verification_source_urls"
const DEFAULT_TIMEOUT_MS = 10_000

type LoadedPlace = RegistryPlace & { verified_by: string | null; verified_at: string | null; verification_source_urls: Json | null }

type AuditValue = Record<string, unknown>

export async function runRegistryVerify(step: RegistryVerifyStep, actor: string, deps: RegistryVerifyDeps = {}): Promise<RegistryVerifyResult> {
  const client = createSupabaseServiceRoleClient()
  const now = deps.now ?? (() => new Date())
  const sourceUrl = ehaneulDetailUrl(step.facilitycd)
  const auditKey = registryAuditKey(step.placeId)

  const placeRead = await client.from("places").select(PLACE_COLUMNS).eq("id", step.placeId).maybeSingle()
  if (placeRead.error !== null) {
    throw new Error("Failed to load registry-verify target")
  }
  const place = placeRead.data as LoadedPlace | null
  if (place === null) {
    return { kind: "blocked", reason: "place-not-found" }
  }
  const auditRead = await client.from("settings").select("key,value").eq("key", auditKey).maybeSingle()
  if (auditRead.error !== null) {
    return { kind: "failed", step: "audit" }
  }
  const audit = auditRead.data?.value ?? null
  const auditValue = audit === null ? null : asRecord(audit)
  if (audit !== null && (auditValue === null || !auditMatchesStep(auditValue, step, sourceUrl))) {
    return { kind: "blocked", reason: "audit-mismatch" }
  }
  const verifiedByThisPath = place.official_verification_status === "verified" && place.verified_by === REGISTRY_VERIFIED_BY && sameSources(place.verification_source_urls, sourceUrl)

  // 이미 확인된 장소 — 확정된 감사가 있으면 장소가 그대로인지, 의도만 있으면 확인 시각을 붙여 확정할 수 있는지 본다.
  if (place.official_verification_status === "verified") {
    if (!verifiedByThisPath) {
      return { kind: "blocked", reason: place.verified_by === REGISTRY_VERIFIED_BY ? "audit-mismatch" : "already-verified-other" }
    }
    if (auditValue === null) {
      return { kind: "blocked", reason: "audit-missing" }
    }
    const targetIssue = checkTarget(place, step, placeFingerprintBeforeVerification(place))
    if (targetIssue !== null) {
      return { kind: "blocked", reason: targetIssue }
    }
    const matched = auditMatched(auditValue)
    if (auditValue["state"] === "done") {
      const recorded = asRecord(auditValue["after"])?.["verified_at"]
      return recorded === place.verified_at ? { kind: "verified", matched, sourceUrl, resumed: true } : { kind: "blocked", reason: "audit-mismatch" }
    }
    // 의도(pending)만 있고 장소는 이미 갱신됨 — 갱신 뒤 확정에서 멈춘 것. 장소에 기록된 실제 확인 시각으로 확정한다.
    if (place.verified_at === null) {
      return { kind: "blocked", reason: "audit-mismatch" }
    }
    const finalized = await finalizeAudit(client, auditKey, auditValue, place.verified_at, { resumed_finalize: true })
    return finalized ? { kind: "verified", matched, sourceUrl, resumed: true } : { kind: "failed", step: "audit" }
  }
  // 확인 전 장소인데 감사가 확정돼 있다 — 확인 뒤 다른 경로가 확인 상태를 되돌렸다. 다시 쓰지 않는다.
  if (auditValue !== null && auditValue["state"] !== "pending") {
    return { kind: "blocked", reason: "audit-mismatch" }
  }

  const targetIssue = checkTarget(place, step, placeFingerprint(place))
  if (targetIssue !== null) {
    return { kind: "blocked", reason: targetIssue }
  }
  if (place.official_verification_status !== null) {
    return { kind: "blocked", reason: "already-verified-other" }
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

  // 현행 목록 — 목록에 있고, 가격정보 수정일이 기한 안이어야 한다(선별 기준; 운영 확인이 아니다).
  const list = await (deps.loadList ?? (() => loadEhaneulList(deps)))()
  if (list.kind !== "ok") {
    return { kind: "failed", step: list.kind === "fetch" ? "list" : "parse" }
  }
  const listed = list.rows.get(step.facilitycd)
  if (listed === undefined) {
    return { kind: "blocked", reason: "not-in-current-list" }
  }
  const age = listAgeDays(listed.listUpdatedDate, new Date(list.fetchedAt))
  // 수정일이 조회일보다 미래면 목록 값이나 시각이 어긋난 것이다 — 최신으로 치지 않고 멈춘다.
  if (age === null || age < 0) {
    return { kind: "failed", step: "parse" }
  }
  if (age > REGISTRY_LIST_MAX_AGE_DAYS) {
    return { kind: "blocked", reason: "registry-stale" }
  }

  // 상세는 정해진 공공 호스트의 한 주소에서만 읽는다.
  const detail = await fetchDetail(step.facilitycd, deps)
  if (detail.kind !== "ok") {
    return { kind: "failed", step: detail.kind }
  }
  const evidence = combineEvidence(detail.value, listed)
  if (evidence === null) {
    return { kind: "blocked", reason: "evidence-changed" }
  }
  if (evidenceFingerprint(evidence) !== step.expectedEvidenceHash) {
    return { kind: "blocked", reason: "evidence-changed" }
  }
  const match = judgeRegistryMatch(place, evidence)
  if (!match.ok) {
    return { kind: "blocked", reason: match.reason }
  }

  const duplicate = await findFacilityConflict(client, step, evidence)
  if (duplicate !== null) {
    return { kind: "blocked", reason: duplicate }
  }

  // 감사 의도를 먼저 남긴다. 이미 있으면(앞선 실행이 남긴 의도) 위에서 이 step과 같은 원본임을 확인했다.
  // 의도 내용은 step·장소·근거 지문에서 결정되므로 같은 원본이면 같은 내용이다.
  // 목록 조회 시각·경과일도 의도에 함께 남긴다 — 장소 갱신 뒤 확정에서 멈춰도 재개가 그 근거를 잃지 않는다.
  const intent = buildIntent(step, actor, place, evidence, match.matched, sourceUrl, { checkedAt: list.fetchedAt, ageDays: age })
  if (auditValue === null) {
    const saved = await client.from("settings").insert({ key: auditKey, value: intent as unknown as Json })
    if (saved.error !== null) {
      // 23505(동시에 같은 키) 포함 — 충돌 행 내용을 확인하지 않고 진행하지 않는다. 다시 실행하면 그 행을 읽어 판단한다.
      return { kind: "failed", step: "audit" }
    }
  } else if (JSON.stringify(auditMatched(auditValue)) !== JSON.stringify(match.matched)) {
    return { kind: "blocked", reason: "audit-mismatch" }
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

  // 앞선 실행이 남긴 의도가 있으면 그때 기록한 조회 근거를 그대로 둔다(근거가 없는 옛 의도만 이번 값으로 채운다).
  const listExtra = auditValue !== null && auditValue["list_checked_at"] === undefined ? { list_checked_at: list.fetchedAt, list_age_days: age } : {}
  const finalized = await finalizeAudit(client, auditKey, auditValue ?? intent, verifiedAt, listExtra)
  if (!finalized) {
    return { kind: "failed", step: "audit" }
  }
  return { kind: "verified", matched: match.matched, sourceUrl, resumed: auditValue !== null }
}

type Client = ReturnType<typeof createSupabaseServiceRoleClient>

// 대상 조건 — fingerprint는 호출자가 고른 비교값(확인 전: 그대로, 확인 뒤: 확인 상태만 되돌린 값).
function checkTarget(place: LoadedPlace, step: RegistryVerifyStep, fingerprint: string): RegistryVerifyBlock | null {
  if (place.category !== "funeral") {
    return "not-funeral"
  }
  if (place.status !== "draft") {
    return "not-draft"
  }
  if (place.official_verification_status === "excluded" || place.exclusion_reason !== null) {
    return "excluded"
  }
  if (isMemorialFacilityName(place.name) || isLodgingFacilityName(place.name)) {
    return "facility-name-blocked"
  }
  if (fingerprint !== step.expectedPlaceHash) {
    return "place-changed"
  }
  return null
}

// 같은 시설로 보이는 다른 장례식장 행 — 게시됨·확인됨이면 중복, 아직 후보인 본체 행이 또 있으면 어느 쪽이 본체인지 정할 수 없어 보류한다.
// 다른 장소가 같은 시설 번호로 감사 기록을 남겼어도 보류한다.
async function findFacilityConflict(client: Client, step: RegistryVerifyStep, evidence: RegistryEvidence): Promise<RegistryVerifyBlock | null> {
  const registry = parseRoadAddress(evidence.fulladdress)
  if (registry === null) {
    return "region-mismatch"
  }
  const nearby = await client.from("places").select("id,name,status,official_verification_status,exclusion_reason,address").eq("category", "funeral").ilike("address", `%${registry.roadBase}%`)
  if (nearby.error !== null) {
    throw new Error("Failed to load same-road funeral places")
  }
  const sameFacility = (nearby.data as { id: string; name: string; status: string; official_verification_status: string | null; exclusion_reason: string | null; address: string | null }[]).filter((row) => {
    if (row.id === step.placeId || row.address === null) {
      return false
    }
    const parsed = parseRoadAddress(row.address)
    return parsed !== null && parsed.road === registry.road && parsed.number === registry.number && sameRegion(row.address, evidence.fulladdress)
  })
  if (sameFacility.some((row) => row.status === "published")) {
    return "published-duplicate"
  }
  if (sameFacility.some((row) => row.official_verification_status === "verified")) {
    return "verified-duplicate"
  }
  const candidate = sameFacility.some(
    (row) => row.exclusion_reason === null && row.official_verification_status !== "excluded" && !SUB_FACILITY_PATTERN.test(row.name) && !isMemorialFacilityName(row.name) && !isLodgingFacilityName(row.name),
  )
  if (candidate) {
    return "candidate-duplicate"
  }
  const claims = await client.from("settings").select("key").like("key", `${REGISTRY_VERIFY_AUDIT_PREFIX}%`).eq("value->>facilitycd", step.facilitycd)
  if (claims.error !== null) {
    throw new Error("Failed to load registry-verify claims")
  }
  return (claims.data as { key: string }[]).some((row) => row.key !== registryAuditKey(step.placeId)) ? "facility-claimed" : null
}

export async function loadEhaneulList(deps: Pick<RegistryVerifyDeps, "fetchImpl" | "now" | "timeoutMs">): Promise<RegistryListRead> {
  const body = await getJson(EHANEUL_LIST_URL, deps)
  if (body.kind !== "ok") {
    return { kind: "fetch" }
  }
  const rows = parseEhaneulList(body.value)
  return rows === null ? { kind: "parse" } : { kind: "ok", fetchedAt: (deps.now ?? (() => new Date()))().toISOString(), rows }
}

async function fetchDetail(facilitycd: string, deps: RegistryVerifyDeps) {
  const body = await getJson(ehaneulDetailUrl(facilitycd), deps)
  if (body.kind !== "ok") {
    return { kind: "fetch" as const }
  }
  const parsed = parseEhaneulDetail(body.value, facilitycd)
  return parsed === null ? { kind: "parse" as const } : { kind: "ok" as const, value: parsed }
}

async function getJson(url: string, deps: Pick<RegistryVerifyDeps, "fetchImpl" | "timeoutMs">): Promise<{ readonly kind: "ok"; readonly value: unknown } | { readonly kind: "fetch" }> {
  if (!url.startsWith(`${EHANEUL_ORIGIN}/`)) {
    return { kind: "fetch" }
  }
  const fetchImpl = deps.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS), headers: { Accept: "application/json" } })
    if (!response.ok) {
      return { kind: "fetch" }
    }
    return { kind: "ok", value: await response.json() }
  } catch {
    return { kind: "fetch" }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function sameSources(value: Json | null, sourceUrl: string): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === sourceUrl
}

// 감사 기록이 이 step과 같은 원본인가 — 정책·장소·시설·출처·두 지문.
function auditMatchesStep(value: AuditValue, step: RegistryVerifyStep, sourceUrl: string): boolean {
  return (
    value["policy_version"] === REGISTRY_VERIFY_POLICY_VERSION &&
    value["place_id"] === step.placeId &&
    value["facilitycd"] === step.facilitycd &&
    value["source_url"] === sourceUrl &&
    value["place_hash"] === step.expectedPlaceHash &&
    value["evidence_hash"] === step.expectedEvidenceHash &&
    (value["state"] === "pending" || value["state"] === "done")
  )
}

function auditMatched(value: AuditValue): readonly RegistryMatchField[] {
  const matched = value["matched"]
  return Array.isArray(matched) ? (matched.filter((field) => field === "address" || field === "phone" || field === "name") as RegistryMatchField[]) : []
}

function buildIntent(
  step: RegistryVerifyStep,
  actor: string,
  place: RegistryPlace,
  evidence: RegistryEvidence,
  matched: readonly RegistryMatchField[],
  sourceUrl: string,
  list: Readonly<{ checkedAt: string; ageDays: number }>,
): AuditValue {
  return {
    state: "pending",
    policy_version: REGISTRY_VERIFY_POLICY_VERSION,
    tier: "public-registry",
    // 이 등급이 확인하지 않은 것 — 생성·공개에서 단정하지 않는다.
    not_confirmed: ["current-operation", "wreath-policy"],
    // 목록의 lastUpdateDate는 가격정보 수정일이다 — 운영 확인일이 아니다.
    list_date_meaning: "price-info-updated",
    actor,
    reason: step.reason,
    place_id: step.placeId,
    source_url: sourceUrl,
    list_url: EHANEUL_LIST_URL,
    list_checked_at: list.checkedAt,
    list_age_days: list.ageDays,
    facilitycd: step.facilitycd,
    evidence,
    evidence_hash: step.expectedEvidenceHash,
    place_hash: step.expectedPlaceHash,
    matched,
    before: { status: place.status, official_verification_status: place.official_verification_status, name: place.name, address: place.address, phone: place.phone },
  }
}

// 의도(pending) → 확정(done). 의도 상태일 때만 바뀐다(정확히 1행).
async function finalizeAudit(client: Client, auditKey: string, intent: AuditValue, verifiedAt: string, extra: Record<string, unknown>): Promise<boolean> {
  const done = {
    ...intent,
    ...extra,
    state: "done",
    after: { official_verification_status: "verified", verified_by: REGISTRY_VERIFIED_BY, verified_at: verifiedAt, verification_source_urls: [intent["source_url"]] },
  }
  const result = await client.from("settings").update({ value: done as unknown as Json }).eq("key", auditKey).eq("value->>state", "pending").select("key")
  return result.error === null && result.data.length === 1
}
