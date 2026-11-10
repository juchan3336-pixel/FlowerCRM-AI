// 광고 문안 품질 검사 — SEO 콘텐츠와 같은 금지 규칙·모드 어휘표를 광고 소재에 적용하는 어댑터.
//
// 규칙 자체는 lib/ai가 소유한다(금지 표현: content-quality, 모드 어휘: mode-vocabulary). 여기서 완화하지 않는다.
// FAQ 개수·장소명 필수 같은 SEO 구조 검사는 광고 문안에 해당하지 않으므로 가져오지 않는다.
// 제목·본문뿐 아니라 캡션과 이미지 위 문구까지 전부 검사한다 — 이미지에 박힌 문구는 게시 후 고칠 수 없다.
import type { InspectableField } from "@/lib/ai/content-fields"
import type { ContentMode } from "@/lib/ai/content-mode"
import { scanBannedExpressionsInFields, tokenJaccardSimilarity, type QualityIssue, type QualityReport, type QualityStatus } from "@/lib/ai/content-quality"
import { findForbiddenModeVocabularyInFields, forbiddenVocabularyCode } from "@/lib/ai/mode-vocabulary"
import { maskPlaceAndRegionNames } from "@/lib/ai/text-masking"

import type { AdCopy } from "./types"

// 같은 채널에 최근 나간 본문과 이 이상 겹치면 복제 게시로 본다(블로그 중복·스팸 제재 방지).
export const AD_BODY_SIMILARITY_FAIL = 0.8

// 근조 소재에 섞이면 안 되는 축하 어휘 — 광고 계층 전용 규칙.
// SEO 모드 어휘표(mode-vocabulary)의 condolence 금지어는 기업 축하(개업·준공 등)만 다루고 예식 축하는 없다.
// 그 표는 공개 페이지 판정에 쓰이므로 건드리지 않고, 광고 소재에만 더 넓게 막는다.
const CONDOLENCE_AD_FORBIDDEN_TERMS: readonly string[] = ["결혼", "예식", "웨딩", "화혼", "경축", "축하"]

// 문안 밖에서 주어지는 검사 맥락
export type AdQualityContext = {
  // 같은 채널에 최근 게시한 본문들
  readonly recentBodies?: readonly string[]
  // 문안에 등장하는 장소명·지역명 — 고유명사가 금지어와 겹치는 오탐(예: 경북 상주시)을 막는다
  readonly placeName?: string
  readonly regionTokens?: readonly (string | null)[]
}

export type AdQualityInput = AdQualityContext & {
  readonly mode: ContentMode
  readonly copy: AdCopy
}

export function adCopyFields(copy: AdCopy): readonly InspectableField[] {
  const fields: InspectableField[] = [
    { field: "title", text: copy.title },
    { field: "body", text: copy.body },
  ]
  if (copy.caption !== undefined) {
    fields.push({ field: "caption", text: copy.caption })
  }
  ;(copy.imageTexts ?? []).forEach((text, index) => {
    fields.push({ field: `image_text[${String(index)}]`, text })
  })
  return fields.filter((entry) => entry.text.trim().length > 0)
}

export function evaluateAdCopy(input: AdQualityInput): QualityReport {
  const fields = adCopyFields(input.copy)
  const issues: QualityIssue[] = []

  if (input.copy.title.trim().length === 0) {
    issues.push({ level: "fail", code: "structure:title-empty", message: "제목이 비어 있습니다" })
  }
  if (input.copy.body.trim().length === 0) {
    issues.push({ level: "fail", code: "structure:body-empty", message: "본문이 비어 있습니다" })
  }

  issues.push(...scanBannedExpressionsInFields(fields))

  const findings = findForbiddenModeVocabularyInFields({ fields, mode: input.mode, placeName: input.placeName ?? "", regionTokens: input.regionTokens ?? [] })
  for (const finding of findings) {
    issues.push({ level: "fail", code: forbiddenVocabularyCode(finding), message: `${finding.mode} 소재에 쓸 수 없는 표현 '${finding.term}' (${finding.field})` })
  }

  if (input.mode === "condolence") {
    const seen = new Set(findings.map((finding) => `${finding.field}:${finding.term}`))
    for (const { field, text } of fields) {
      const masked = maskPlaceAndRegionNames(text, input.placeName ?? "", input.regionTokens ?? [])
      for (const term of CONDOLENCE_AD_FORBIDDEN_TERMS) {
        // '개업 축하'처럼 모드 어휘표가 이미 잡은 구문 안의 '축하'는 다시 세지 않는다.
        const alreadyCovered = [...seen].some((key) => key.startsWith(`${field}:`) && key.includes(term))
        if (masked.includes(term) && !alreadyCovered) {
          issues.push({ level: "fail", code: `ad-mode-mix:${field}:${term}`, message: `근조 소재에 쓸 수 없는 축하 표현 '${term}' (${field})` })
        }
      }
    }
  }

  const highest = Math.max(0, ...(input.recentBodies ?? []).map((recent) => tokenJaccardSimilarity(input.copy.body, recent)))
  if (highest >= AD_BODY_SIMILARITY_FAIL) {
    issues.push({ level: "fail", code: "repetition:body", message: `최근 게시 본문과 유사도 ${highest.toFixed(2)} — 같은 글의 복제 게시는 금지 (기준 ${String(AD_BODY_SIMILARITY_FAIL)})` })
  }

  const status: QualityStatus = issues.some((issue) => issue.level === "fail") ? "fail" : issues.length > 0 ? "warn" : "pass"
  return { status, issues }
}
