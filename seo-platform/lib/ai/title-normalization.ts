// content_plan 제목 후처리 정규화 v1 — 11·12호점에서 모델이 계획 제목을 2/2회 미준수
// (11호: '안내' 접미사 추가, 12호: '체크사항'→'안내' 치환)하여 도입.
// 계획 제목이 유효하면 최종 제목의 기준은 항상 계획 제목이다. 메타·본문·FAQ·키워드는 건드리지 않는다.

export type TitleNormalizationReason =
  | "plan-match" // 모델 제목 = 계획 제목 → 변경 없음
  | "suffix-appended" // 모델이 계획 제목 뒤에 접미사를 덧붙임 → 계획 제목으로 정규화
  | "plan-restored" // 모델이 계획 제목의 구조를 바꿈 → 계획 제목으로 정규화
  | "no-plan" // content_plan.title 없음 → 모델 제목 유지

export type TitleNormalization = {
  readonly model_title: string
  readonly final_title: string
  readonly normalized: boolean
  readonly reason: TitleNormalizationReason
}

export function normalizeGeneratedTitle(modelTitle: string, planTitle: string | null | undefined): TitleNormalization {
  const plan = planTitle?.trim() ?? ""
  const model = modelTitle.trim()

  if (plan.length === 0) {
    return { model_title: model, final_title: model, normalized: false, reason: "no-plan" }
  }
  if (model === plan) {
    return { model_title: model, final_title: plan, normalized: false, reason: "plan-match" }
  }
  if (model.startsWith(`${plan} `)) {
    return { model_title: model, final_title: plan, normalized: true, reason: "suffix-appended" }
  }
  return { model_title: model, final_title: plan, normalized: true, reason: "plan-restored" }
}
