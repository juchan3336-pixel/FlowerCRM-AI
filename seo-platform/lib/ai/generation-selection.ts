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

// 샘플(fake) provider preview는 정상 적용본이 있는 장소에서 현재 상태를 대표할 수 없다.
//
// Production은 AI_PROVIDER=fake라 운영자 클릭 사고로 샘플 초안이 만들어질 수 있었고
// (2026-08-04 KCC: fake 초안 2건이 applied 이후에 생겨 품질 카드가 샘플 FAIL로 뒤집힘),
// 그 초안이 최신 preview가 되면 품질 카드·대기 초안 선택을 전부 오염시킨다.
// applied가 하나라도 있으면 fake preview를 대표·대기 선택에서 제외한다 — 이력에는 그대로 남는다.
// applied가 없는 장소(로컬 개발의 fake 검토 흐름)는 기존 동작을 유지한다.
export function excludeSupersededFakePreviews<T extends { readonly status: string; readonly provider?: string | null }>(generationsDesc: readonly T[]): readonly T[] {
  const hasApplied = generationsDesc.some((generation) => generation.status === "applied")
  if (!hasApplied) {
    return generationsDesc
  }
  return generationsDesc.filter((generation) => !(generation.status === "preview" && generation.provider === "fake"))
}
