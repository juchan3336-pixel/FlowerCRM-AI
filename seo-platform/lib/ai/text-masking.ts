// 장소명·지역명·주소 토큰 마스킹 — 반복도 판정(content-quality)과 금지어 오탐 방어(mode-vocabulary)가
// 같은 규칙을 써야 해서 별도 모듈로 둔다 (두 모듈이 서로를 import하는 순환을 피하는 목적도 겸한다).

// 고유명사(업체 공식명·지역명)만 지운다. 뒤따르는 조사·도로명 추정은 건드리지 않는다 —
// 금지어 검사에서는 "빈소로"처럼 조사가 붙은 형태까지 지워버리면 검출이 새어나간다.
export function maskPlaceAndRegionNames(text: string, placeName: string, regionTokens: readonly (string | null)[]): string {
  let masked = text
  const tokens = [placeName, ...placeName.split(/\s+/), ...regionTokens.filter((token): token is string => token !== null && token.length > 0)]
  for (const token of tokens.filter((token) => token.length >= 2).sort((a, b) => b.length - a.length)) {
    masked = masked.split(token).join("〈장소〉")
  }
  return masked.replace(/〈장소〉(〈장소〉)+/g, "〈장소〉")
}

// 장소명·지역명·주소 토큰을 마스킹해 '치환 템플릿' 여부를 판정 가능하게 한다.
// (장소명/지역명 → 〈장소〉, 숫자 포함 토큰 → 〈숫자〉, 도로·행정구역 지명 → 〈지명〉)
export function maskPlaceTokens(text: string, placeName: string, regionTokens: readonly (string | null)[]): string {
  return maskPlaceAndRegionNames(text, placeName, regionTokens)
    .split(/\s+/)
    .map((token) => {
      if (token.includes("〈장소〉")) {
        return token
      }
      if (/\d/.test(token)) {
        return "〈숫자〉"
      }
      if (/(?:대로|[가-힣]로|[가-힣]길|[가-힣]읍|[가-힣]면|[가-힣]동|[가-힣]리)(?:에|에서)?$/.test(token) && !/(?:으로|스로|대로는|려면|으면|다면|이면|하면|보면)$/.test(token)) {
        return "〈지명〉"
      }
      return token
    })
    .join(" ")
}
