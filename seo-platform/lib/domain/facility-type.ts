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
const MEMORIAL_FACILITY_PATTERN = /(추모공원|추모관|추모누리|추모의집|봉안|수목장|수림장|납골|묘원|묘지|공원묘|자연장|장사시설)/

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
  return "funeral-parlor"
}

export function isMemorialFacilityName(name: string): boolean {
  return classifyFuneralFacility(name) === "memorial-facility"
}

// DB exclusion_reason에 기록하는 사유 코드 — 운영자가 목록에서 이 값으로 걸러볼 수 있다.
export const MEMORIAL_FACILITY_EXCLUSION_REASON = "memorial-facility" as const
