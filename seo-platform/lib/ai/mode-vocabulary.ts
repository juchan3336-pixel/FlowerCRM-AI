// 업종 모드별 금지 어휘 — 생성 프롬프트와 독립된 품질 계층의 규칙이다.
//
// 프롬프트가 아무리 잘 쓰여 있어도 모델은 틀릴 수 있다. 2026-08-01 실측에서 호텔·공장 페이지에
// "빈소"·"장례식장"이 박힌 채 ready로 넘어갔고, 그때 이를 잡아낼 계층이 없었다.
// 규칙을 프롬프트가 아니라 여기 한 곳에만 두는 이유도 같다 — 실패가 어느 계층에서 났는지
// (생성이 잘못했는지, 검사가 못 잡았는지) 구분되어야 한다.
//
// 이 파일은 검사만 한다. 판정(fail 등급)·재시도·게시 차단은 각각 content-quality, quality-policy,
// publish-runner가 이 결과를 받아 결정한다.
import type { ContentMode } from "./content-mode"
import { maskPlaceAndRegionNames } from "./text-masking"
import type { AiGeneratedSeoContent } from "./types"

export type ContentModeVocabularyPolicy = {
  // 반드시 등장해야 하는 표현 (현재 모드별로 강제하지 않는다 — 구조만 마련)
  readonly requiredTerms?: readonly string[]
  // 단일 단어 금지어
  readonly forbiddenTerms: readonly string[]
  // 띄어쓰기를 포함한 구문 금지어 — 단어 단위로는 정상인데 조합이 문제인 경우
  readonly forbiddenPhrases?: readonly string[]
}

// 장례 어휘 — celebration·corporate-celebration에서 공통으로 막는다.
const FUNERAL_TERMS: readonly string[] = ["근조", "조문", "빈소", "장례식장", "장례", "상주", "유가족", "부고", "고인", "발인"]

export const MODE_VOCABULARY: Readonly<Record<ContentMode, ContentModeVocabularyPolicy>> = {
  // 장례식장 페이지에 축하 목적 표현이 섞이면 조문객에게 그대로 노출된다.
  condolence: {
    forbiddenTerms: ["개업", "준공", "취임", "승진", "창립"],
    forbiddenPhrases: ["오픈 축하", "개업 축하", "준공 축하", "창립 축하", "취임 축하"],
  },
  celebration: {
    forbiddenTerms: FUNERAL_TERMS,
  },
  "corporate-celebration": {
    forbiddenTerms: FUNERAL_TERMS,
  },
}

export type ForbiddenVocabularyKind = "term" | "phrase"

export type ForbiddenVocabularyFinding = {
  readonly mode: ContentMode
  readonly field: string
  readonly term: string
  readonly kind: ForbiddenVocabularyKind
}

export type ForbiddenVocabularyInput = {
  readonly content: AiGeneratedSeoContent
  readonly mode: ContentMode
  readonly placeName: string
  // 순서 계약: [city, district] — content-quality와 동일
  readonly regionTokens: readonly (string | null)[]
}

// 검사 대상은 '사용자에게 노출되는 최종 문구'뿐이다.
// internal_links.href(경로)와 출처·검증 URL은 문구가 아니므로 제외한다 — URL에 우연히 들어간
// 문자열로 게시가 막히면 안 된다.
function inspectableFields(content: AiGeneratedSeoContent): readonly { readonly field: string; readonly text: string }[] {
  const fields: { field: string; text: string }[] = [
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

// 대소문자·공백 폭을 정규화한다. 한국어에는 단어 경계가 없어 부분 문자열로 볼 수밖에 없고,
// 그래서 오탐 방어는 '장소명·지역명 마스킹'이 담당한다 (아래 참고).
function normalize(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()
}

export function findForbiddenModeVocabulary(input: ForbiddenVocabularyInput): readonly ForbiddenVocabularyFinding[] {
  const policy = MODE_VOCABULARY[input.mode]
  const findings: ForbiddenVocabularyFinding[] = []
  const seen = new Set<string>()

  for (const { field, text } of inspectableFields(input.content)) {
    // 오탐 방어: 업체 공식명과 지역명은 먼저 지운다.
    // 경북 '상주시'의 호텔, 이름에 '장례'가 든 업체처럼 고유명사가 금지어와 겹치는 경우를 걸러낸다.
    // 마스킹 후에도 남아 있으면 생성된 문구가 스스로 쓴 표현이다.
    const masked = normalize(maskPlaceAndRegionNames(text, input.placeName, input.regionTokens))

    for (const phrase of policy.forbiddenPhrases ?? []) {
      if (masked.includes(normalize(phrase))) {
        push(findings, seen, { mode: input.mode, field, term: phrase, kind: "phrase" })
      }
    }
    for (const term of policy.forbiddenTerms) {
      if (masked.includes(normalize(term))) {
        push(findings, seen, { mode: input.mode, field, term, kind: "term" })
      }
    }
  }
  return findings
}

function push(findings: ForbiddenVocabularyFinding[], seen: Set<string>, finding: ForbiddenVocabularyFinding): void {
  const key = `${finding.field}:${finding.term}`
  if (!seen.has(key)) {
    seen.add(key)
    findings.push(finding)
  }
}

export const FORBIDDEN_VOCABULARY_CODE_PREFIX = "forbidden-mode-"

// 감사·UI가 파싱할 수 있는 코드: forbidden-mode-term:<field>:<term>
export function forbiddenVocabularyCode(finding: ForbiddenVocabularyFinding): string {
  return `${FORBIDDEN_VOCABULARY_CODE_PREFIX}${finding.kind}:${finding.field}:${finding.term}`
}

export function isForbiddenVocabularyCode(code: string): boolean {
  return code.startsWith(FORBIDDEN_VOCABULARY_CODE_PREFIX)
}

export function parseForbiddenVocabularyCode(code: string): { readonly kind: ForbiddenVocabularyKind; readonly field: string; readonly term: string } | null {
  if (!isForbiddenVocabularyCode(code)) {
    return null
  }
  const [kind, field, ...rest] = code.slice(FORBIDDEN_VOCABULARY_CODE_PREFIX.length).split(":")
  const term = rest.join(":")
  if ((kind !== "term" && kind !== "phrase") || field === undefined || field.length === 0 || term.length === 0) {
    return null
  }
  return { kind, field, term }
}

// 재시도 프롬프트·오류 메시지에 넣을 요약 (같은 표현을 다시 쓰지 못하게 근거를 남긴다).
export function describeForbiddenFindings(findings: readonly ForbiddenVocabularyFinding[]): string {
  return findings.map((finding) => `${finding.field}: '${finding.term}'`).join(", ")
}

export function forbiddenTermsOf(findings: readonly ForbiddenVocabularyFinding[]): readonly string[] {
  return [...new Set(findings.map((finding) => finding.term))]
}
