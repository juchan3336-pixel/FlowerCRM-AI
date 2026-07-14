// 서버 인스턴스 내 동일 장소 동시 생성 차단.
// 서버리스 다중 인스턴스에는 미치지 않으므로 DB 최근-preview 검사(최종 안전장치)와 함께 사용한다.
const inFlightPlaceIds = new Set<string>()

export function tryBeginAiGeneration(placeId: string): boolean {
  if (inFlightPlaceIds.has(placeId)) {
    return false
  }
  inFlightPlaceIds.add(placeId)
  return true
}

export function endAiGeneration(placeId: string): void {
  inFlightPlaceIds.delete(placeId)
}
