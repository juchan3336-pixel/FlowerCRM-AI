// 생성 입력용 주소 표기 — 시트 원문의 꼬리 표기를 떼어 문장에 인용하기 좋은 형태로 만든다.
//
// 수도권 수집분은 주소가 "서울 송파구 올림픽로43길 88 (지번) 풍납동 388-1", "경기 안성시 남파로 169 (우)17584"
// 형태로 들어온다. 모델이 이를 그대로 인용해 "…88 (지번) 풍납동 388-1입니다" 같은 문장이 나왔다 (2026-11-10 파일럿).
// 원본(places.address)은 건드리지 않는다 — 검증 대조와 승인 스냅샷이 원문을 쓴다.
const TRAILING_MARKER = /\s*\((지번|우)\)\s*/

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
  if (head.length > 0) {
    return head
  }
  // 도로명 없이 "(지번) …"만 있는 주소 — 꼬리를 지우면 빈 값이 되므로 표식만 떼고 지번 주소를 남긴다.
  const tail = trimmed.slice(match.index + match[0].length).trim()
  return tail.length === 0 ? null : tail
}
