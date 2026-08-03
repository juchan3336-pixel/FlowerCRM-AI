// 생성 콘텐츠에서 '사용자에게 노출되는 문구'만 필드 단위로 뽑는다.
// 금지 표현 검사(content-quality)와 업종 어휘 검사(mode-vocabulary)가 같은 목록을 봐야
// "어느 필드에서 걸렸다"는 보고가 두 규칙에서 같은 의미를 갖는다.
//
// internal_links.href(경로)와 출처·검증 URL은 제외한다 — 문구가 아니라 주소이고,
// URL에 우연히 들어간 문자열로 생성·게시가 막히면 안 된다.
import type { AiGeneratedSeoContent } from "./types"

export type InspectableField = {
  readonly field: string
  readonly text: string
}

export function inspectableContentFields(content: AiGeneratedSeoContent): readonly InspectableField[] {
  const fields: InspectableField[] = [
    { field: "meta_title", text: content.meta_title },
    { field: "meta_description", text: content.meta_description },
    { field: "description", text: content.description },
  ]
  content.faq.forEach((entry, index) => {
    fields.push({ field: `faq[${String(index)}].question`, text: entry.question })
    fields.push({ field: `faq[${String(index)}].answer`, text: entry.answer })
  })
  content.keywords.forEach((keyword, index) => {
    fields.push({ field: `keywords[${String(index)}]`, text: keyword })
  })
  content.internal_links.forEach((link, index) => {
    fields.push({ field: `internal_links[${String(index)}].label`, text: link.label })
  })
  return fields.filter((entry) => typeof entry.text === "string" && entry.text.trim().length > 0)
}
