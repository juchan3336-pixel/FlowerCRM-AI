// 표시용 주소 표기 — 시트 원문의 꼬리 표기를 뗀다. 생성 입력(문장 인용)과 공개 표면(랜딩 주소·JSON-LD)이 함께 쓴다.
//
// 수도권 수집분은 주소가 "서울 송파구 올림픽로43길 88 (지번) 풍납동 388-1", "경기 안성시 남파로 169 (우)17584"
// 형태로 들어온다. 모델이 이를 그대로 인용해 "…88 (지번) 풍납동 388-1입니다" 같은 문장이 나왔다 (2026-11-10 파일럿).
// 원본(places.address)은 건드리지 않는다 — 검증 대조와 승인 스냅샷이 원문을 쓴다.
//
// 지번 꼬리는 "앞부분만으로 이미 찾아갈 수 있는 주소일 때"만 뗀다. 앞부분이 시·군·구나 동 이름까지뿐이면
// ("서울 송파구 (지번) 풍납동 388-1") 지번이 유일한 상세 주소이므로 표식만 지우고 지번을 남긴다.
// 우편번호 꼬리("(우) 17584")는 위치 정보가 아니므로 언제나 뗀다.
const TRAILING_MARKER = /\s*\((지번|우)\)\s*/

// 앞부분만으로 찾아갈 수 있는 주소인가 — "도로명 + 건물번호" 또는 "동·리·가 + 번지"가 실제로 이어져 있을 때만 그렇다.
// 숫자가 들어 있다는 것만으로는 판단하지 않는다: "역삼1동", "을지로3가", "올림픽로43길"의 숫자는 이름의 일부이지
// 건물번호·번지가 아니다. 확신할 수 없으면 완결되지 않은 것으로 보고 지번을 남긴다.
const NUMBER_TOKEN = /^\d+(-\d+)?(번지)?$/
const ROAD_NAME_TOKEN = /[가-힣0-9](로|길)$/
const LOT_AREA_TOKEN = /[가-힣0-9](동|리|가)$/

function hasStreetLevelDetail(head: string): boolean {
  const tokens = head.split(/\s+/)
  return tokens.some((token, index) => {
    const next = tokens[index + 1]
    return next !== undefined && NUMBER_TOKEN.test(next) && (ROAD_NAME_TOKEN.test(token) || LOT_AREA_TOKEN.test(token))
  })
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
