// 시설 유형 판정 — 빈소를 운영하는 장례식장과 안치·봉안 시설을 구분한다.
//
// 2026-08-06 사고: 추모공원·봉안당·수목장 7곳이 category=funeral로 수집돼 근조화환 문맥
// ("빈소명을 확인하세요")으로 공개됐다. 이 시설들은 빈소가 없어 조문 화환 배송 대상이 아니다.
// 시트 category만으로는 구분되지 않으므로 명칭 기준 판정을 한 곳에 두고, 후보·생성·게시
// 전 계층이 같은 판정을 참조한다 (DB의 excluded 표시와 이중 방어).
//
// 판정은 보수적이다 — 애매하면 "장례식장 아님"으로 본다. 잘못 제외된 시설은 운영자가
// exclusion_reason을 지워 되살릴 수 있지만, 잘못 공개된 페이지는 되돌리기 어렵다.

// 상조·반려동물 장례는 명칭에 '장례식장'이 있어도 빈소 운영 시설이 아니다.
const ALWAYS_NON_PARLOR_PATTERN = /(상조|반려동물|펫\s?장례|동물장례)/

// 안치·봉안·자연장 계열 — 아래 '빈소 운영' 표현이 함께 없으면 장례식장이 아니다.
const MEMORIAL_FACILITY_PATTERN = /(추모공원|추모관|추모누리|추모의집|봉안|수목장|수림장|납골|묘원|묘지|공원묘|자연장|장사시설|메모리얼\s?파크)/

// 명칭에 안치·봉안 표현이 전혀 없어 위 패턴을 통과하는 안치 전용 시설 — 공식 홈페이지에서 빈소가 없음을
// 확인한 곳만 이름으로 적는다 (2026-11-10 확인: 봉안당·납골당·수목장·기독교 추모관).
// '공원·정원·파크·낙원' 같은 일반 단어를 패턴에 넣지 않는 이유: 정상 장례식장·행사장 명칭까지 잘려 나간다.
// 비교는 공백과 선행 법인 표기를 지운 이름의 완전 일치다.
const KNOWN_MEMORIAL_FACILITY_NAMES: ReadonlySet<string> = new Set([
  "청아공원",
  "해인사미타원",
  "용인로뎀파크",
  "마라나타하늘정원",
  "에덴낙원",
  "송파공원",
  "청련사극락원",
  "사랑메모리얼파크",
])

function normalizeFacilityName(name: string): string {
  return name.replace(/\s+/g, "").replace(/^(재단법인|사단법인|\(재\)|\(사\))/, "")
}

// 실제 빈소를 함께 운영하는 명칭 (예: 합천추모공원 장례식장, 함안하늘공원 장례식장).
const PARLOR_PATTERN = /(장례식장|장례예식장|장례문화원|장례타운)/

export type FacilityTypeVerdict = "funeral-parlor" | "memorial-facility"

// 장례(condolence) 콘텐츠를 붙여도 되는 시설인지 판정한다.
export function classifyFuneralFacility(name: string): FacilityTypeVerdict {
  if (ALWAYS_NON_PARLOR_PATTERN.test(name)) {
    return "memorial-facility"
  }
  if (MEMORIAL_FACILITY_PATTERN.test(name) && !PARLOR_PATTERN.test(name)) {
    return "memorial-facility"
  }
  if (KNOWN_MEMORIAL_FACILITY_NAMES.has(normalizeFacilityName(name))) {
    return "memorial-facility"
  }
  return "funeral-parlor"
}

export function isMemorialFacilityName(name: string): boolean {
  return classifyFuneralFacility(name) === "memorial-facility"
}

// DB exclusion_reason에 기록하는 사유 코드 — 운영자가 목록에서 이 값으로 걸러볼 수 있다.
export const MEMORIAL_FACILITY_EXCLUSION_REASON = "memorial-facility" as const

// ── 숙박 시설 판정 (celebration 모드 전용) ─────────────────────────
//
// 2026-08-07: 축하(celebration) 후보에 펜션·모텔 등 순수 숙박 시설이 대량 혼입돼 있었다
// (숙박/행사+호텔 1,848곳 중 명칭 기준 749곳, verified 234곳 중 121곳). 시트 category
// "숙박/행사"가 통째로 celebration으로 매핑되기 때문 — 행사장(호텔·웨딩홀·컨벤션)과 달리
// 순수 숙박 시설은 축하화환·행사화환 배송 문맥이 성립하지 않아 명칭 기준으로 제외한다.
//
// 리조트·콘도는 패턴에 넣지 않는다 — 연회장·웨딩홀을 함께 운영하는 곳이 많아(소노캄·아난티 등)
// 일괄 제외하면 정상 행사장이 잘려 나간다. 애매한 명칭은 celebration에 남고, 콘텐츠 생성 전
// 공식 검증(사람 확인)이 마지막 방어선이다.
const LODGING_FACILITY_PATTERN = /(펜션|팬션|모텔|민박|게스트\s?하우스|게스트룸|찜질방|캠핑|글램핑|카라반|풀빌라|호스텔|야영장|민숙)/

// 축하(celebration) 콘텐츠를 붙여도 되는 시설인지 판정한다 — 순수 숙박 시설이면 true.
export function isLodgingFacilityName(name: string): boolean {
  return LODGING_FACILITY_PATTERN.test(name)
}

export const LODGING_FACILITY_EXCLUSION_REASON = "lodging-facility" as const
