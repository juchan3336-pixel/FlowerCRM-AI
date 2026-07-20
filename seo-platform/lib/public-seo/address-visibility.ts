// 공개 주소 축약 정책 — 장례식장 자체 번지의 1차 공식 출처를 확인하지 못한 장소는
// 공개 표면(랜딩 배송지 정보·JSON-LD LocalBusiness)에서 상세 도로명·번지·우편번호를 노출하지 않는다.
// DB places.address는 변경하지 않으며, 승인된 slug만 명시적으로 등록한다 (장소명 문자열 판별 금지).

// 남해병원 장례식장 (place id 2d99f527-a4da-4955-bfec-c281871122cc, 2026-07-20 승인)
export const COARSE_ADDRESS_ONLY_SLUGS: ReadonlySet<string> = new Set(["funeral-gyeongnam-namhaegun-namhaebyeongwon-jangryesikjang"])

export const COARSE_ADDRESS_OFFICIAL_SITE_NOTICE = "자세한 위치는 해당 장소의 공식 사이트에서 확인할 수 있습니다."

export function isCoarseAddressOnlySlug(slug: string): boolean {
  return COARSE_ADDRESS_ONLY_SLUGS.has(slug)
}

// 검증된 DB 주소에서 시·군·읍(면·동) 토큰까지만 남긴다. 도로명(…로/…길)·숫자·우편번호부터는 제외.
export function coarsePublicAddress(address: string | null): string | null {
  if (address === null) {
    return null
  }
  const kept: string[] = []
  for (const token of address.split(/\s+/)) {
    if (/\d/.test(token) || /[가-힣](로|길)$/.test(token) || token.startsWith("(")) {
      break
    }
    kept.push(token)
  }
  return kept.length > 0 ? kept.join(" ") : null
}

export function resolvePublicAddress(slug: string, address: string | null): string | null {
  return isCoarseAddressOnlySlug(slug) ? coarsePublicAddress(address) : address
}
