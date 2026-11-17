// 공공등록(e하늘 장사정보시스템) 기반 장례식장 확인 — 순수 판정.
//
// 홈페이지 3항목 자동 확인(auto-verify)은 업체 자체 사이트가 없으면 아무것도 확인하지 못한다. 장례식장은 보건복지부가
// e하늘에 시설 고유 번호(facilitycd)·주소·전화·빈소 수를 공개하므로, 그 공공 기록으로 "이 DB 행이 그 시설 본체다"를 확인한다.
//
// 이 확인이 말해 주는 것과 말해 주지 않는 것:
//  - 확인함: 시설 식별(I)·도로명 주소(C)·장례식장 기능(빈소 수 > 0, B)
//  - 확인하지 않음: 현재 영업(A) — e하늘의 갱신일은 '가격정보 수정일'이지 운영 점검일이 아니다. 목록에서 빠진 것도 폐업 확정이 아니다.
//  - 확인하지 않음: 화환 반입 정책(D)
// 그래서 이 경로로 확인된 장소는 '공공등록 기반, 영업 미확인·화환 정책 미상' 등급이다. 생성·공개 문구에 현재 영업·수령 가능·
// 공인/제휴·화환 허용을 넣지 않는다 (기존 시설 직접 확인 안내 유지).
//
// 대상 고정: 무엇을 확인할지는 ops 작업 설정에 placeId·facilitycd와 '읽었을 때의 장소 지문'·'승인한 근거 지문'으로 고정한다.
// 실행할 때 서버가 정해진 공공 호스트에서 근거를 다시 읽어 지문을 대조한다 — 설정에 적힌 '일치함'을 믿지 않는다.
import { createHash } from "node:crypto"

export const REGISTRY_VERIFY_POLICY_VERSION = "ehaneul-funeral-v1"
export const REGISTRY_VERIFIED_BY = "registry:ehaneul"
export const EHANEUL_ORIGIN = "https://www.15774129.go.kr"
export const EHANEUL_FUNERAL_GROUP = "TBC0700001"
export const REGISTRY_VERIFY_AUDIT_PREFIX = "registry-verify:"
export const REGISTRY_REASON_MAX_LENGTH = 300

// 근거를 읽는 곳은 이 한 곳뿐이다 — 설정에서 URL을 받지 않는다.
export function ehaneulDetailUrl(facilitycd: string): string {
  return `${EHANEUL_ORIGIN}/portal/fnlfac/price_info.ajax?facilitycd=${facilitycd}&sanbundiv=N`
}

export function registryAuditKey(placeId: string): string {
  return `${REGISTRY_VERIFY_AUDIT_PREFIX}${placeId}`
}

export type RegistryVerifyStep = {
  readonly kind: "registry-verify"
  readonly placeId: string
  readonly facilitycd: string
  // 조사할 때 읽은 장소(이름·주소·전화·업종·상태·확인 상태·제외 사유)의 지문 — 그 사이 수집 동기화 등으로 바뀌었으면 쓰지 않는다.
  readonly expectedPlaceHash: string
  // 사람이 검토한 e하늘 근거(시설 번호·그룹·이름·주소·전화·빈소 수)의 지문 — 실행 때 다시 읽은 근거와 같아야 한다.
  readonly expectedEvidenceHash: string
  readonly reason: string
}

const STEP_KEYS = ["kind", "placeId", "facilitycd", "expectedPlaceHash", "expectedEvidenceHash", "reason"] as const
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const FACILITYCD_PATTERN = /^\d{10}$/

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

export type RegistryEvidence = {
  readonly facilitycd: string
  readonly facilitygroupcd: string
  readonly companyname: string
  readonly fulladdress: string
  readonly telephone: string | null
  readonly mortuaycnt: number
}

export function evidenceFingerprint(evidence: RegistryEvidence): string {
  return sha256([evidence.facilitycd, evidence.facilitygroupcd, evidence.companyname, evidence.fulladdress, evidence.telephone, evidence.mortuaycnt])
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

// e하늘 상세 응답에서 필요한 필드만 꺼낸다. 형식이 기대와 다르면 null — 내부 호출이 바뀌면 확인하지 않는다(fail-closed).
// 빈소 수는 응답에서 mortuaycnt 필드다(필드 이름이 뒤바뀌어 있음: 안치 능력은 charnelabilitycnt). 대표자·담당자 같은 개인 필드는 읽지 않는다.
export function parseEhaneulDetail(json: unknown, facilitycd: string): RegistryEvidence | null {
  const root = asRecord(json)
  if (root?.["isSuccess"] !== true) {
    return null
  }
  const detail = asRecord(root["detail"])
  const list = Array.isArray(root["facilityList"]) ? root["facilityList"] : []
  const listed = list.map(asRecord).find((row) => row?.["facilitycd"] === facilitycd) ?? null
  if (detail === null || listed === null) {
    return null
  }
  const group = detail["facilitygroupcd"]
  const fulladdress = detail["fulladdress"]
  const companyname = listed["companyname"]
  const telephone = detail["telephone"]
  const rooms = detail["mortuaycnt"]
  const roomCount = typeof rooms === "number" ? rooms : typeof rooms === "string" && /^\d+$/.test(rooms) ? Number(rooms) : NaN
  if (detail["facilitycd"] !== facilitycd || typeof group !== "string" || typeof fulladdress !== "string" || typeof companyname !== "string" || !Number.isInteger(roomCount)) {
    return null
  }
  return { facilitycd, facilitygroupcd: group, companyname: companyname.trim(), fulladdress: fulladdress.trim(), telephone: typeof telephone === "string" && telephone.trim().length > 0 ? telephone.trim() : null, mortuaycnt: roomCount }
}

// ── 대조 ──────────────────────────────────────────────

const SIDO_FULL: Readonly<Record<string, string>> = {
  서울: "서울특별시",
  부산: "부산광역시",
  대구: "대구광역시",
  인천: "인천광역시",
  광주: "광주광역시",
  대전: "대전광역시",
  울산: "울산광역시",
  세종: "세종특별자치시",
  경기: "경기도",
  강원: "강원",
  충북: "충청북도",
  충남: "충청남도",
  전북: "전북",
  전남: "전라남도",
  경북: "경상북도",
  경남: "경상남도",
  제주: "제주특별자치도",
}

function stripTail(address: string): string {
  return address.replace(/\s*\((지번|우)\).*$/, "").trim()
}

// 시도·시군구 — DB는 '경기 의정부시', e하늘은 '경기도 의정부시' 형식이다.
export function sameRegion(dbAddress: string, registryAddress: string): boolean {
  const a = stripTail(dbAddress).split(/\s+/)
  const b = registryAddress.trim().split(/\s+/)
  const dbSido = a[0] ?? ""
  const full = SIDO_FULL[dbSido] ?? dbSido
  const registrySido = b[0] ?? ""
  return dbSido.length > 0 && (registrySido === full || registrySido.startsWith(full) || registrySido.startsWith(dbSido)) && (a[1] ?? "") === (b[1] ?? "") && (a[1] ?? "").length > 0
}

// 도로명 + 건물번호 — "평화로 650", "낙동대로249번길 11". 괄호 안(동·건물명)은 보지 않는다.
export function roadKey(address: string): string | null {
  const plain = stripTail(address).replace(/\(.*?\)/g, " ").replace(/(로|길)\s+(\d+번?길)/, "$1$2")
  const match = /([가-힣0-9]+(?:로|길))\s*(\d+(?:-\d+)?)(?![0-9가-힣])/.exec(plain)
  return match === null ? null : `${match[1] ?? ""} ${match[2] ?? ""}`
}

// DB 주소의 도로명·건물번호 뒤에 붙은 층·호·동·별관 같은 상세 — 공공 기록은 이를 확인하지 않는다.
export function addressDetailAfterRoad(address: string): string {
  const plain = stripTail(address)
  const key = roadKey(plain)
  if (key === null) {
    return ""
  }
  const [road = "", number = ""] = key.split(" ")
  const at = plain.indexOf(number, plain.indexOf(road.replace(/\d+번?길$/, "")))
  return at < 0 ? "" : plain.slice(at + number.length).trim()
}

const DETAIL_PATTERN = /(\d+\s*층|지하|\d+\s*호|[A-Za-z가-힣]동(\s|$|,)|별관|본관)/

export function phoneDigits(phone: string | null): string {
  return (phone ?? "").replace(/\D/g, "")
}

function nameCore(name: string): string {
  return name.replace(/장례식장|장례문화원|장례예식장|장례원|\s|\(.*?\)/g, "")
}

// 같은 단지·같은 전화를 쓰는 부속 시설 행(주차장·식당·매점·봉안당 등) — 공공 기록의 장례식장 본체와 다른 행이다.
const SUB_FACILITY_PATTERN = /주차|식당|매점|화장실|납골|봉안|승화원|화장장|추모|공원묘|묘원|안치실|꽃집|화원|편의점|카페|사무실|휴게/

export type RegistryMatchField = "address" | "phone" | "name"

export type RegistryMatch =
  | { readonly ok: true; readonly matched: readonly RegistryMatchField[] }
  | {
      readonly ok: false
      readonly reason: "not-funeral-group" | "no-rooms" | "missing-address" | "region-mismatch" | "road-mismatch" | "weak-match" | "sub-facility-name" | "address-detail"
    }

// 장소가 그 공공 기록의 장례식장 본체인가. 시도·시군구 + 도로명·건물번호가 같고, 전화나 핵심 이름 중 하나가 더 맞아야 한다.
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
  const address = place.address ?? ""
  const dbRoad = roadKey(address)
  if (dbRoad === null) {
    return { ok: false, reason: "missing-address" }
  }
  if (!sameRegion(address, evidence.fulladdress)) {
    return { ok: false, reason: "region-mismatch" }
  }
  if (roadKey(evidence.fulladdress) !== dbRoad) {
    return { ok: false, reason: "road-mismatch" }
  }
  if (DETAIL_PATTERN.test(addressDetailAfterRoad(address))) {
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
