// 자동 업체 확인 판정 — "기계가 확실히 확인한 것만 통과, 나머지는 사람 몫으로 남긴다".
//
// 2026-08-06 실측 근거:
//  · 홈페이지 본문에서 업체명·주소·전화 3항목이 모두 잡히는 곳은 15곳 중 2곳뿐이다.
//    → 통과율이 낮은 것은 감수한다. 통과한 것만 자동 처리하고 나머지는 큐에 남겨 사람이 본다.
//  · 큐 대상 후보의 16%가 블로그·SNS·포털 URL, 24%가 3곳 이상 공유하는 호스트다.
//    → 이런 주소는 3항목이 다 나와도 "그 업체 공식 사이트"라는 근거가 되지 못한다 (디렉터리·지점 목록).
//      2026-07-31 enrich 1차 검증에서도 같은 유형(플랫폼 페이지를 공식 홈페이지로 오탐)이 문제였다.
//
// 판정은 순수 함수로 두고 수집·저장은 호출부가 한다.

import type { EvidenceField } from "./verification-evidence"

// 블로그·SNS·예약 포털·위키·업체 디렉터리 — 업체 고유 사이트가 아니다.
const NON_OFFICIAL_HOST_PATTERN =
  /(^|\.)(blog\.naver\.com|m\.blog\.naver\.com|cafe\.naver\.com|cafe\.daum\.net|blog\.daum\.net|tistory\.com|instagram\.com|facebook\.com|namu\.wiki|booking\.naver\.com|map\.naver\.com|place\.naver\.com|modoo\.at|iyp\.kr|ok114\.co\.kr|yeogi\.com|daangn\.com|hotelscombined\.co\.kr|agoda\.com|booking\.com|youtube\.com|linktr\.ee)$/i

// 같은 호스트를 이 수 이상의 장소가 공유하면 지점 목록·프랜차이즈 공용 사이트로 본다.
export const SHARED_HOST_THRESHOLD = 3

export type AutoVerifyDecision =
  | { readonly kind: "verified" }
  | { readonly kind: "manual"; readonly reason: AutoVerifyManualReason }

export type AutoVerifyManualReason =
  | "blocked-host"
  | "shared-host"
  | "unreachable"
  | "text-unavailable"
  | "insufficient-match"
  | "invalid-homepage"
  // 콘텐츠 모드가 없는 업종·추모시설 등 — 검증해도 생성 후보가 되지 못한다 (확인 자체가 무의미).
  | "not-eligible"

export const AUTO_VERIFY_MANUAL_LABELS: Readonly<Record<AutoVerifyManualReason, string>> = {
  "blocked-host": "블로그·SNS·포털 주소 (공식 사이트 아님)",
  "shared-host": "여러 장소가 함께 쓰는 주소 (지점 목록 등)",
  unreachable: "홈페이지 접속 실패",
  "text-unavailable": "본문을 읽지 못함 (스크립트·이미지)",
  "insufficient-match": "업체명·주소·전화가 모두 확인되지 않음",
  "invalid-homepage": "홈페이지 주소 형식 오류",
  "not-eligible": "지원하지 않는 업종·시설 (콘텐츠 생성 대상 아님)",
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase()
  } catch {
    return null
  }
}

export function isNonOfficialHost(host: string): boolean {
  return NON_OFFICIAL_HOST_PATTERN.test(host)
}

// 자동 통과 조건: 공식 사이트로 볼 수 있는 호스트 + 접속 성공 + 3항목 전부 확인.
// 하나라도 어긋나면 통과시키지 않고 사유를 남긴다 — 사유는 화면에서 사람이 볼 때 쓰인다.
export function decideAutoVerify(
  input: Readonly<{
    homepage: string
    httpStatus: number
    matched: readonly EvidenceField[]
    textUnavailable: boolean
    sameHostPlaceCount: number
  }>,
): AutoVerifyDecision {
  const host = hostOf(input.homepage)
  if (host === null) {
    return { kind: "manual", reason: "invalid-homepage" }
  }
  if (isNonOfficialHost(host)) {
    return { kind: "manual", reason: "blocked-host" }
  }
  if (input.sameHostPlaceCount >= SHARED_HOST_THRESHOLD) {
    return { kind: "manual", reason: "shared-host" }
  }
  if (input.httpStatus !== 200) {
    return { kind: "manual", reason: "unreachable" }
  }
  if (input.textUnavailable) {
    return { kind: "manual", reason: "text-unavailable" }
  }
  const complete = (["name", "address", "phone"] as const).every((field) => input.matched.includes(field))
  return complete ? { kind: "verified" } : { kind: "manual", reason: "insufficient-match" }
}
