// 공공등록(e하늘 장사정보시스템) 기반 장례식장 확인 — 순수 판정.
//
// 홈페이지 3항목 자동 확인(auto-verify)은 업체 자체 사이트가 없으면 아무것도 확인하지 못한다. 장례식장은 보건복지부가
// e하늘에 시설 고유 번호(facilitycd)·주소·전화·빈소 수를 공개하므로, 그 공공 기록으로 "이 DB 행이 그 시설 본체다"를 확인한다.
//
// 이 확인이 말해 주는 것과 말해 주지 않는 것:
//  - 확인함: 시설 식별(I)·도로명 주소(C)·장례식장 기능(빈소 수 > 0, B)
//  - 확인하지 않음: 현재 영업(A) — e하늘 목록의 갱신일(lastUpdateDate)은 '가격정보 수정일'이지 운영 점검일이 아니다.
//    목록에서 빠진 것도 폐업 확정이 아니다(이 확인 작업만 보류한다).
//  - 확인하지 않음: 화환 반입 정책(D)
// 그래서 이 경로로 확인된 장소는 '공공등록 기반, 영업 미확인·화환 정책 미상' 등급이다. 생성·공개 문구에 현재 영업·수령 가능·
// 공인/제휴·화환 허용을 넣지 않는다 (기존 시설 직접 확인 안내 유지).
//
// 대상 고정: 무엇을 확인할지는 ops 작업 설정에 placeId·facilitycd와 '읽었을 때의 장소 지문'·'승인한 근거 지문'으로 고정한다.
// 실행할 때 서버가 정해진 공공 호스트에서 현행 목록과 상세를 다시 읽어 지문을 대조한다 — 설정에 적힌 '일치함'을 믿지 않는다.
import { createHash } from "node:crypto"

export const REGISTRY_VERIFY_POLICY_VERSION = "ehaneul-funeral-v2"
export const REGISTRY_VERIFIED_BY = "registry:ehaneul"
export const EHANEUL_ORIGIN = "https://www.15774129.go.kr"
export const EHANEUL_FUNERAL_GROUP = "TBC0700001"
export const REGISTRY_VERIFY_AUDIT_PREFIX = "registry-verify:"
export const REGISTRY_REASON_MAX_LENGTH = 300
// 선별 기준(합의): 현행 목록에 있고, 목록의 가격정보 수정일이 목록 조회일 기준 365일 이내. 운영 확인 기준이 아니다.
export const REGISTRY_LIST_MAX_AGE_DAYS = 365
// 장례식장 전체 목록을 한 번에 받는 크기 — 현재 1,083곳. 응답의 전체 건수가 이보다 많으면 목록이 잘린 것이므로 확인하지 않는다.
const EHANEUL_LIST_PAGE_SIZE = 1200

// 근거를 읽는 곳은 이 두 주소뿐이다 — 설정에서 URL을 받지 않는다.
export function ehaneulDetailUrl(facilitycd: string): string {
  return `${EHANEUL_ORIGIN}/portal/fnlfac/price_info.ajax?facilitycd=${facilitycd}&sanbundiv=N`
}

export const EHANEUL_LIST_URL = `${EHANEUL_ORIGIN}/portal/fnlfac/fac_list.ajax?pageInqCnt=${String(EHANEUL_LIST_PAGE_SIZE)}&curPageNo=1&facilitygroupcd=${EHANEUL_FUNERAL_GROUP}`

export function registryAuditKey(placeId: string): string {
  return `${REGISTRY_VERIFY_AUDIT_PREFIX}${placeId}`
}

export type RegistryVerifyStep = {
  readonly kind: "registry-verify"
  readonly placeId: string
  readonly facilitycd: string
  // 조사할 때 읽은 장소(이름·주소·전화·업종·상태·확인 상태·제외 사유)의 지문 — 그 사이 수집 동기화 등으로 바뀌었으면 쓰지 않는다.
  readonly expectedPlaceHash: string
  // 사람이 검토한 e하늘 근거(시설 번호·그룹·이름·주소·전화·빈소 수·가격정보 수정일)의 지문 — 실행 때 다시 읽은 근거와 같아야 한다.
  readonly expectedEvidenceHash: string
  readonly reason: string
}

const STEP_KEYS = ["kind", "placeId", "facilitycd", "expectedPlaceHash", "expectedEvidenceHash", "reason"] as const
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256_PATTERN = /^[0-9a-f]{64}$/
// 시설 번호는 9~10자리다 — 현행 목록에 9자리(예: 700002700)가 섞여 있다.
const FACILITYCD_PATTERN = /^\d{9,10}$/

export function parseRegistryVerifyStep(raw: Readonly<Record<string, unknown>>): RegistryVerifyStep | null {
  if (raw["kind"] !== "registry-verify") {
    return null
  }
  const keys = Object.keys(raw)
  if (keys.length !== STEP_KEYS.length || !keys.every((key) => (STEP_KEYS as readonly string[]).includes(key))) {
    return null
  }
  const { placeId, facilitycd, expectedPlaceHash, expectedEvidenceHash, reason } = raw
  if (typeof placeId !== "string" || !UUID_PATTERN.test(placeId)) {
    return null
  }
  if (typeof facilitycd !== "string" || !FACILITYCD_PATTERN.test(facilitycd)) {
    return null
  }
  if (typeof expectedPlaceHash !== "string" || !SHA256_PATTERN.test(expectedPlaceHash) || typeof expectedEvidenceHash !== "string" || !SHA256_PATTERN.test(expectedEvidenceHash)) {
    return null
  }
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > REGISTRY_REASON_MAX_LENGTH) {
    return null
  }
  return { kind: "registry-verify", placeId, facilitycd, expectedPlaceHash, expectedEvidenceHash, reason }
}

// 한 작업 안에서 같은 장소·같은 시설을 두 번 다루지 않는다 — 같은 시설의 두 행을 순서대로 확인해 둘 다 생성 후보가 되는 것을 막는다.
export function hasDuplicateRegistryTargets(steps: readonly RegistryVerifyStep[]): boolean {
  return new Set(steps.map((step) => step.placeId)).size !== steps.length || new Set(steps.map((step) => step.facilitycd)).size !== steps.length
}

export type RegistryPlace = {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly category: string | null
  readonly official_verification_status: string | null
  readonly exclusion_reason: string | null
  readonly address: string | null
  readonly phone: string | null
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")
}

export function placeFingerprint(place: RegistryPlace): string {
  return sha256([place.id, place.name, place.address ?? null, place.phone ?? null, place.category ?? null, place.status, place.official_verification_status ?? null, place.exclusion_reason ?? null])
}

// 이 경로가 확인 상태를 기록한 뒤의 장소를, 확인 상태만 원래(null)로 되돌려 승인 때의 지문과 비교한다.
// 확인 뒤 이름·주소·전화·업종·상태·제외 사유가 바뀌었으면 다르다.
export function placeFingerprintBeforeVerification(place: RegistryPlace): string {
  return placeFingerprint({ ...place, official_verification_status: null })
}

export type RegistryEvidence = {
  readonly facilitycd: string
  readonly facilitygroupcd: string
  readonly companyname: string
  readonly fulladdress: string
  readonly telephone: string | null
  readonly mortuaycnt: number
  // 현행 목록의 lastUpdateDate(YYYY-MM-DD) — '가격정보 수정일'. 운영 확인일로 해석하지 않는다.
  readonly listUpdatedDate: string
}

export function evidenceFingerprint(evidence: RegistryEvidence): string {
  return sha256([evidence.facilitycd, evidence.facilitygroupcd, evidence.companyname, evidence.fulladdress, evidence.telephone, evidence.mortuaycnt, evidence.listUpdatedDate])
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

// ── 현행 목록 ──────────────────────────────────────────

export type RegistryListRow = {
  readonly facilitycd: string
  readonly facilitygroupcd: string
  readonly companyname: string
  readonly listUpdatedDate: string
}

// 장례식장 전체 목록. 전체 건수와 받은 행 수가 다르거나(잘림), 시설 번호가 겹치거나, 필드 형식이 다르면 null(fail-closed).
export function parseEhaneulList(json: unknown): ReadonlyMap<string, RegistryListRow> | null {
  const root = asRecord(json)
  if (root?.["isSuccess"] !== true || !Array.isArray(root["list"]) || typeof root["cnt"] !== "number") {
    return null
  }
  const list = root["list"] as unknown[]
  if (root["cnt"] !== list.length || list.length === 0) {
    return null
  }
  const rows = new Map<string, RegistryListRow>()
  for (const entry of list) {
    const row = asRecord(entry)
    const facilitycd = row?.["facilitycd"]
    const group = row?.["facilitygroupcd"]
    const name = row?.["companyname"]
    const updated = row?.["lastUpdateDate"]
    if (typeof facilitycd !== "string" || !FACILITYCD_PATTERN.test(facilitycd) || typeof group !== "string" || typeof name !== "string" || typeof updated !== "string") {
      return null
    }
    const date = /^(\d{4})[/-](\d{2})[/-](\d{2})$/.exec(updated.trim())
    if (date === null || rows.has(facilitycd)) {
      return null
    }
    rows.set(facilitycd, { facilitycd, facilitygroupcd: group, companyname: name.trim(), listUpdatedDate: `${date[1] ?? ""}-${date[2] ?? ""}-${date[3] ?? ""}` })
  }
  return rows
}

// 목록 조회 시각(KST 날짜) 기준 가격정보 수정일 경과 일수. 날짜가 실재하지 않으면 null.
export function listAgeDays(listUpdatedDate: string, fetchedAt: Date): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(listUpdatedDate)) {
    return null
  }
  const [y, m, d] = listUpdatedDate.split("-").map(Number)
  const check = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 0))
  if (check.getUTCFullYear() !== y || check.getUTCMonth() + 1 !== m || check.getUTCDate() !== d) {
    return null
  }
  const kstToday = new Date(fetchedAt.getTime() + 9 * 3_600_000).toISOString().slice(0, 10)
  return Math.round((Date.parse(`${kstToday}T00:00:00Z`) - check.getTime()) / 86_400_000)
}

// ── 상세 ──────────────────────────────────────────────

export type RegistryDetail = Omit<RegistryEvidence, "listUpdatedDate" | "companyname">

// e하늘 상세 응답에서 필요한 필드만 꺼낸다. 형식이 기대와 다르면 null — 내부 호출이 바뀌면 확인하지 않는다(fail-closed).
// 빈소 수는 응답에서 mortuaycnt 필드다(필드 이름이 뒤바뀌어 있음: 안치 능력은 charnelabilitycnt). 대표자·담당자 같은 개인 필드는 읽지 않는다.
// 상세의 facilityList 한 행은 현행 목록 조회를 대신하지 않는다 — 시설 이름·갱신일은 현행 목록에서 가져온다.
export function parseEhaneulDetail(json: unknown, facilitycd: string): RegistryDetail | null {
  const root = asRecord(json)
  if (root?.["isSuccess"] !== true) {
    return null
  }
  const detail = asRecord(root["detail"])
  if (detail === null) {
    return null
  }
  const group = detail["facilitygroupcd"]
  const fulladdress = detail["fulladdress"]
  const telephone = detail["telephone"]
  const rooms = detail["mortuaycnt"]
  const roomCount = typeof rooms === "number" ? rooms : typeof rooms === "string" && /^\d+$/.test(rooms) ? Number(rooms) : NaN
  if (detail["facilitycd"] !== facilitycd || typeof group !== "string" || typeof fulladdress !== "string" || fulladdress.trim().length === 0 || !Number.isInteger(roomCount)) {
    return null
  }
  return { facilitycd, facilitygroupcd: group, fulladdress: fulladdress.trim(), telephone: typeof telephone === "string" && telephone.trim().length > 0 ? telephone.trim() : null, mortuaycnt: roomCount }
}

// 현행 목록 행과 상세를 합친 근거. 시설 그룹이 서로 다르면 근거로 쓰지 않는다.
export function combineEvidence(detail: RegistryDetail, listed: RegistryListRow): RegistryEvidence | null {
  if (listed.facilitycd !== detail.facilitycd || listed.facilitygroupcd !== detail.facilitygroupcd) {
    return null
  }
  return { ...detail, companyname: listed.companyname, listUpdatedDate: listed.listUpdatedDate }
}

// ── 주소 분해 ─────────────────────────────────────────

const SIDO_ALIASES: Readonly<Record<string, string>> = {
  서울: "서울",
  서울특별시: "서울",
  서울시: "서울",
  부산: "부산",
  부산광역시: "부산",
  대구: "대구",
  대구광역시: "대구",
  인천: "인천",
  인천광역시: "인천",
  광주: "광주",
  광주광역시: "광주",
  대전: "대전",
  대전광역시: "대전",
  울산: "울산",
  울산광역시: "울산",
  세종: "세종",
  세종특별자치시: "세종",
  경기: "경기",
  경기도: "경기",
  강원: "강원",
  강원도: "강원",
  강원특별자치도: "강원",
  충북: "충북",
  충청북도: "충북",
  충남: "충남",
  충청남도: "충남",
  전북: "전북",
  전라북도: "전북",
  전북특별자치도: "전북",
  전남: "전남",
  전라남도: "전남",
  경북: "경북",
  경상북도: "경북",
  경남: "경남",
  경상남도: "경남",
  제주: "제주",
  제주도: "제주",
  제주특별자치도: "제주",
}

export type ParsedRoadAddress = {
  readonly sido: string
  // 시·군·구 — 구가 있는 시는 ["성남시", "분당구"]처럼 둘. 세종만 비어 있을 수 있다.
  readonly sigungu: readonly string[]
  readonly eupmyeon: string | null
  // 도로명(번길 포함, 공백 없음) — "평화로", "낙동대로249번길"
  readonly road: string
  // 조회용 기본 도로명 — "낙동대로249번길"이면 "낙동대로"
  readonly roadBase: string
  readonly number: string
  // 도로명·건물번호 뒤에 남은 원문(괄호의 법정동만 있는 경우 제외) — 층·호·동·관·건물명 등
  readonly detail: string
}

function stripTail(address: string): string {
  return address.replace(/\s*\((지번|우)\).*$/, "").trim()
}

const SIGUNGU_TOKEN = /^[가-힣]+(시|군|구)$/
const EUPMYEON_TOKEN = /^[가-힣0-9]+(읍|면)$/
// 도로명(+번길) + 건물번호. 원문 위치에서 바로 시작해야 한다 — 문자열 안을 다시 찾지 않는다.
const ROAD_PATTERN = /^([가-힣A-Za-z0-9·]+?(?:로|길))(\s*\d+번?길)?\s*(\d+(?:-\d+)?)(?![0-9])/
// 괄호 안이 법정동·리 이름만이면 상세로 보지 않는다 ("(의정부동)", "(용암리)").
const LEGAL_DONG_PAREN = /^\(\s*[가-힣0-9]+(?:동|리|가)\s*\)$/

// 도로명 주소를 시도·시군구(구 포함)·읍면·도로명·건물번호·상세로 나눈다. 형식이 맞지 않으면 null — 대조하지 않는다.
export function parseRoadAddress(address: string): ParsedRoadAddress | null {
  const plain = stripTail(address)
  let rest = plain
  const take = (): string | null => {
    const match = /^\s*(\S+)/.exec(rest)
    return match === null ? null : (match[1] ?? null)
  }
  const advance = (token: string): void => {
    rest = rest.replace(/^\s*/, "").slice(token.length)
  }
  const first = take()
  const sido = first === null ? undefined : SIDO_ALIASES[first]
  if (first === null || sido === undefined) {
    return null
  }
  advance(first)
  const sigungu: string[] = []
  for (let token = take(); token !== null && SIGUNGU_TOKEN.test(token) && sigungu.length < 2; token = take()) {
    sigungu.push(token)
    advance(token)
  }
  if (sigungu.length === 0 && sido !== "세종") {
    return null
  }
  let eupmyeon: string | null = null
  const maybeEup = take()
  if (maybeEup !== null && EUPMYEON_TOKEN.test(maybeEup)) {
    eupmyeon = maybeEup
    advance(maybeEup)
  }
  const road = ROAD_PATTERN.exec(rest.replace(/^\s*/, ""))
  if (road === null) {
    return null
  }
  const roadBase = road[1] ?? ""
  const roadName = `${roadBase}${(road[2] ?? "").replace(/\s+/g, "")}`
  const after = rest.replace(/^\s*/, "").slice(road[0].length).trim()
  const detail = LEGAL_DONG_PAREN.test(after) ? "" : after
  return { sido, sigungu, eupmyeon, road: roadName, roadBase, number: road[3] ?? "", detail }
}

// 시도 + 시·군·구 전체(구 포함)가 같은가. 한쪽에만 구가 있거나 읍·면이 서로 다르면 같다고 보지 않는다(확인 불가로 닫음).
export function sameRegion(left: string, right: string): boolean {
  const a = parseRoadAddress(left)
  const b = parseRoadAddress(right)
  if (a === null || b === null) {
    return false
  }
  if (a.sido !== b.sido || a.sigungu.length !== b.sigungu.length || a.sigungu.some((token, index) => token !== b.sigungu[index])) {
    return false
  }
  return a.eupmyeon === null || b.eupmyeon === null || a.eupmyeon === b.eupmyeon
}

// 도로명 + 건물번호 — "평화로 650", "낙동대로249번길 11".
export function roadKey(address: string): string | null {
  const parsed = parseRoadAddress(address)
  return parsed === null ? null : `${parsed.road} ${parsed.number}`
}

export function phoneDigits(phone: string | null): string {
  return (phone ?? "").replace(/\D/g, "")
}

function nameCore(name: string): string {
  return name.replace(/장례식장|장례문화원|장례예식장|장례원|\s|\(.*?\)/g, "")
}

// 같은 단지·같은 전화를 쓰는 부속 시설 행(주차장·식당·매점·봉안당 등) — 공공 기록의 장례식장 본체와 다른 행이다.
export const SUB_FACILITY_PATTERN = /주차|식당|매점|화장실|납골|봉안|승화원|화장장|추모|공원묘|묘원|안치실|꽃집|화원|편의점|카페|사무실|휴게/

export type RegistryMatchField = "address" | "phone" | "name"

export type RegistryMatch =
  | { readonly ok: true; readonly matched: readonly RegistryMatchField[] }
  | {
      readonly ok: false
      readonly reason: "not-funeral-group" | "no-rooms" | "missing-address" | "region-mismatch" | "road-mismatch" | "weak-match" | "sub-facility-name" | "address-detail"
    }

// 장소가 그 공공 기록의 장례식장 본체인가. 시도·시군구(구 포함) + 도로명·건물번호가 같고, 전화나 핵심 이름 중 하나가 더 맞아야 한다.
// DB 주소에 도로명·건물번호 뒤 상세(층·호·동·관·건물명)가 있으면 공공 기록이 확인하지 않는 부분이므로 보류한다.
// 주소 접두 일치, 공유 대표전화, 이름 포함만으로는 통과시키지 않는다.
export function judgeRegistryMatch(place: Pick<RegistryPlace, "name" | "address" | "phone">, evidence: RegistryEvidence): RegistryMatch {
  if (evidence.facilitygroupcd !== EHANEUL_FUNERAL_GROUP) {
    return { ok: false, reason: "not-funeral-group" }
  }
  if (evidence.mortuaycnt <= 0) {
    return { ok: false, reason: "no-rooms" }
  }
  if (SUB_FACILITY_PATTERN.test(place.name)) {
    return { ok: false, reason: "sub-facility-name" }
  }
  const db = parseRoadAddress(place.address ?? "")
  if (db === null) {
    return { ok: false, reason: "missing-address" }
  }
  const registry = parseRoadAddress(evidence.fulladdress)
  if (registry === null || !sameRegion(place.address ?? "", evidence.fulladdress)) {
    return { ok: false, reason: "region-mismatch" }
  }
  if (db.road !== registry.road || db.number !== registry.number) {
    return { ok: false, reason: "road-mismatch" }
  }
  if (db.detail.length > 0) {
    return { ok: false, reason: "address-detail" }
  }
  const matched: RegistryMatchField[] = ["address"]
  const digits = phoneDigits(place.phone)
  if (digits.length >= 8 && digits === phoneDigits(evidence.telephone)) {
    matched.push("phone")
  }
  const a = nameCore(place.name)
  const b = nameCore(evidence.companyname)
  if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) {
    matched.push("name")
  }
  return matched.length >= 2 ? { ok: true, matched } : { ok: false, reason: "weak-match" }
}
