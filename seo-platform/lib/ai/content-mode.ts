// 업종별 화환 콘텐츠 모드 — 프롬프트·제목·키워드·FAQ가 모두 이 한 곳의 판정을 참조한다.
//
// 2026-08-01 실측에서 호텔 1곳·공장 2곳이 근조화환 파이프라인을 그대로 통과해
// "KCC 울산공장 빈소 화환 주문 가이드" 같은 결과가 나왔다. 원인은 생성 계층 어디에도
// 업종 분기가 없었던 것이라, 업종→모드 매핑을 여기 한 곳에만 두고 나머지는 모드만 받는다.
//
// 후보 자격(candidate-policy)과는 별개다. 이 파일에 모드가 있다고 해서 승인 대상이 되지는 않는다 —
// eligibility는 여전히 funeral만 허용한다.

export type ContentMode =
  | "condolence" // 근조화환·조문 — 장례식장
  | "celebration" // 축하화환·행사화환 — 호텔·연회장·공연장·웨딩홀
  | "corporate-celebration" // 개업·이전·준공·창립·취임 축하화환 — 기업·공장·사업장

// 시트 category 원문 → 모드. 키는 소문자·trim 후 비교한다.
// 매핑에 없는 업종은 모드가 없고(null), 생성 경로에서 명시적 오류가 된다.
//
// 'hospital'은 일부러 비워 둔다 — 병원 본체는 개업·이전 축하와 병문안이 섞여 목적이 하나로 정해지지 않는다.
// (병원 장례식장은 시트에서 'funeral'로 들어오므로 여기 없어도 condolence로 처리된다.)
const CATEGORY_CONTENT_MODE: Readonly<Record<string, ContentMode>> = {
  // 장례
  funeral: "condolence",

  // 숙박·행사 — 실제 시트 값
  "숙박/행사": "celebration",
  호텔: "celebration",
  // 향후 정규화된 값이 들어올 때를 위한 별칭
  hotel: "celebration",
  event: "celebration",
  wedding: "celebration",
  venue: "celebration",

  // 기업·사업장 — 실제 시트 값
  제조: "corporate-celebration",
  제조업: "corporate-celebration",
  제조업체: "corporate-celebration",
  "건설/부동산": "corporate-celebration",
  건설회사: "corporate-celebration",
  종합건설: "corporate-celebration",
  시행사: "corporate-celebration",
  // 향후 정규화된 값을 위한 별칭
  manufacturing: "corporate-celebration",
  company: "corporate-celebration",
  construction: "corporate-celebration",
  institution: "corporate-celebration",
}

export function contentModeForCategory(category: string | null | undefined): ContentMode | null {
  if (typeof category !== "string") {
    return null
  }
  return CATEGORY_CONTENT_MODE[category.trim().toLowerCase()] ?? null
}

// 생성 경로 전용 — 모드를 정할 수 없으면 조용히 condolence로 떨어뜨리지 않고 던진다.
export function requireContentMode(category: string | null | undefined): ContentMode {
  const mode = contentModeForCategory(category)
  if (mode === null) {
    throw new UnsupportedContentCategoryError(category ?? null)
  }
  return mode
}

export class UnsupportedContentCategoryError extends Error {
  readonly name = "UnsupportedContentCategoryError"

  constructor(readonly category: string | null) {
    super(`Unsupported content category: ${category ?? "(none)"}`)
  }
}

// 매핑된 업종 목록 — 관리·테스트용. 후보 자격과 무관하다.
export function mappedCategories(): readonly string[] {
  return Object.keys(CATEGORY_CONTENT_MODE)
}
