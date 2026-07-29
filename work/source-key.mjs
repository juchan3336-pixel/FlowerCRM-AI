// seo-platform/lib/domain/normalize.ts 의 이식본.
//
// 저장소 루트의 도구는 plain .mjs라 seo-platform의 TypeScript를 직접 import할 수 없다.
// 정규화가 한 글자라도 어긋나면 시트↔DB의 source_key 매칭이 통째로 틀어지므로,
// seo-platform/tests/sync-row-remap-parity.test.ts 가 이 파일과 원본이 같은 결과를 내는지 고정한다.
// 원본을 고치면 이 파일도 함께 고쳐야 하고, 안 고치면 그 테스트가 실패한다.
//
// 부수효과 없는 순수 모듈이다 — env도 네트워크도 건드리지 않는다 (테스트가 그냥 import할 수 있게).

const COMPANY_PREFIXES = [/\(주\)/gi, /㈜/g, /주식회사/g, /\(유\)/g, /유한회사/g]

export function normalizeCompanyName(value) {
  const withoutPrefixes = COMPANY_PREFIXES.reduce((current, pattern) => current.replace(pattern, ""), value)
  return withoutPrefixes.toLocaleLowerCase("ko-KR").replace(/\s+/g, "").trim()
}

export function normalizePhone(value) {
  return value.replace(/\D+/g, "")
}

export function normalizeAddress(value) {
  return value.toLocaleLowerCase("ko-KR").replace(/\s+/g, "").trim()
}

export function createSourceKey({ name, phone, address }) {
  const normalizedName = normalizeCompanyName(name)
  const normalizedPhone = phone === undefined ? "" : normalizePhone(phone)
  if (normalizedPhone.length > 0) {
    return `${normalizedName}|${normalizedPhone}`
  }
  const normalizedAddress = address === undefined ? "" : normalizeAddress(address)
  return `${normalizedName}|${normalizedAddress}`
}
