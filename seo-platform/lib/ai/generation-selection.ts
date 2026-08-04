// 대기 중(pending) preview 선택 — 적용·게시 준비의 대상이 되는 preview는
// "아직 적용되지 않은 가장 최근 초안"뿐이다.
//
// applied보다 오래된 preview는 이미 다른 generation으로 대체된 초안이라 적용 대상이 아니다.
// 2026-08-04 KCC 실측: 8/1 오생성 preview(빈소 가이드)가 preview 상태로 남은 채 8/4 정상
// corporate 생성이 적용됐는데, '게시 준비'가 "최신 preview"(=8/1 오생성)를 겨눠 품질 FAIL로
// 차단됐다 — 품질 카드(적용본 PASS)와 차단 배너(FAIL)가 동시에 보이는 운영자 혼동의 원인.
// 게이트가 막지 못했다면 오생성 초안이 정상 적용본을 덮어썼을 구조이기도 하다.
//
// 규칙: 최신순 목록에서 첫 preview/applied가 preview일 때만 그것이 '대기 중 preview'다.
// (rejected/failed는 건너뛴다 — 품질 패널의 대표 generation 선택과 같은 규칙.)
export function pickPendingPreview<T extends { readonly status: string }>(generationsDesc: readonly T[]): T | null {
  const representative = generationsDesc.find((generation) => generation.status === "preview" || generation.status === "applied")
  return representative?.status === "preview" ? representative : null
}
