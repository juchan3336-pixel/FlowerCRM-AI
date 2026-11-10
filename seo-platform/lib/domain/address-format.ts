// 표시용 주소 표기 — 시트 원문의 꼬리 표기를 뗀다. 생성 입력(문장 인용)과 공개 표면(랜딩 주소·JSON-LD)이 함께 쓴다.
//
// 수도권 수집분은 주소가 "서울 송파구 올림픽로43길 88 (지번) 풍납동 388-1", "경기 안성시 남파로 169 (우)17584"
// 형태로 들어온다. 모델이 이를 그대로 인용해 "…88 (지번) 풍납동 388-1입니다" 같은 문장이 나왔다 (2026-11-10 파일럿).
// 원본(places.address)은 건드리지 않는다 — 검증 대조와 승인 스냅샷이 원문을 쓴다.
//
// 지번 꼬리는 "앞부분만으로 이미 찾아갈 수 있는 주소일 때"만 뗀다. 앞부분이 시·군·구까지뿐이면
// ("서울 송파구 (지번) 풍납동 388-1") 지번이 유일한 상세 주소이므로 표식만 지우고 지번을 남긴다.
// 우편번호 꼬리("(우) 17584")는 위치 정보가 아니므로 언제나 뗀다.
const TRAILING_MARKER = /\s*\((지번|우)\)\s*/

// 도로명(…로·…길) 또는 건물번호가 들어 있으면 앞부분만으로 완결된 주소로 본다.
function hasStreetLevelDetail(head: string): boolean {
  return head.split(/\s+/).some((token) => /\d/.test(token) || /[가-힣](로|길)$/.test(token))
}

export function formatAddressForContent(address: string | null): string | null {
  if (address === null) {
    return null
  }
  const trimmed = address.trim()
  const match = TRAILING_MARKER.exec(trimmed)
  if (match === null) {
    return trimmed.length === 0 ? null : trimmed
  }
  const head = trimmed.slice(0, match.index).trim()
  const tail = trimmed.slice(match.index + match[0].length).trim()
  if (match[1] === "우") {
    return head.length === 0 ? null : head
  }
  if (head.length > 0 && hasStreetLevelDetail(head)) {
    return head
  }
  // 앞부분이 없거나 행정구역까지뿐이다 — 지번이 유일한 상세 주소이므로 표식만 떼고 이어 붙인다.
  const joined = [head, tail].filter((part) => part.length > 0).join(" ")
  return joined.length === 0 ? null : joined
}
