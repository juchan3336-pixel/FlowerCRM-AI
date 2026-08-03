// 생성 콘텐츠 품질 검사 — 금지 표현, 내부 링크 실존 검증, 최근 공개 페이지 대비 반복도.
// 게시 준비 게이트와 관리자 미리보기 성적표가 함께 사용한다.
import { inspectableContentFields } from "./content-fields"
import type { ContentMode } from "./content-mode"
import { findForbiddenModeVocabulary, forbiddenVocabularyCode } from "./mode-vocabulary"
import { maskPlaceTokens } from "./text-masking"
import { detectTitlePatternId, titleSuffixKeyOf } from "./title-variation"
import type { AiGeneratedSeoContent } from "./types"

export type QualityIssueLevel = "fail" | "warn"

export type QualityIssue = {
  readonly level: QualityIssueLevel
  readonly code: string
  readonly message: string
}

export type QualityStatus = "pass" | "warn" | "fail"

export type QualityReport = {
  readonly status: QualityStatus
  readonly issues: readonly QualityIssue[]
}

export type RecentContentSnapshot = {
  readonly placeName: string
  readonly region: string | null
  readonly title: string | null
  readonly description: string | null
  readonly faqQuestions: readonly string[]
  readonly keywords: readonly string[]
}

export type QualityEvaluationInput = {
  readonly content: AiGeneratedSeoContent
  readonly placeName: string
  // 순서 계약: [city, district]
  readonly regionTokens: readonly (string | null)[]
  readonly verifiedInternalPaths: ReadonlySet<string>
  readonly recentPages: readonly RecentContentSnapshot[]
  // 콘텐츠 모드 — 제목 패턴 비교를 같은 모드 세트로 제한한다.
  // 모드를 복원할 수 없는 구 레코드는 null이며, 이때 제목 패턴·접미사 비교를 건너뛴다
  // (임의로 condolence로 가정하지 않는다 — 다른 모드 페이지와 잘못 묶이는 것을 막기 위해).
  readonly mode: ContentMode | null
  // FAQ 다양화 v1 선택 경로 (content_plan.faq_selection) — "exhausted-min-overlap"이면 WARN으로 표시한다.
  readonly faqSelection?: string | null
}

// 절대 금지 표현 — 프롬프트에도 명시되지만 생성 결과에서 이중으로 차단한다.
const BANNED_PATTERNS: readonly { readonly code: string; readonly pattern: RegExp; readonly message: string }[] = [
  { code: "official-order", pattern: /공식 ?주문|공식 ?CTA/i, message: "'공식 주문/공식 CTA' 표현 금지" },
  { code: "cta-term", pattern: /CTA/i, message: "내부 용어 'CTA' 사용 금지 — '화환 주문하기 버튼'으로 표현" },
  { code: "designated", pattern: /지정 ?꽃배달|지정 ?업체|협력 ?업체|제휴 ?업체|제휴/, message: "제휴·지정·협력 업체 표현 금지" },
  { code: "delivery-guarantee", pattern: /배송이 가능합니다|배송이 ?가능한|배송해 ?드립니다|당일 ?배송|빠른 ?배송|즉시 ?배송|배송을 ?보장/, message: "배송 확정·보장 표현 금지 — 주문 과정에서 확인으로 안내" },
  { code: "facility-claim", pattern: /편리한 ?시설|편의 ?시설|조용하고|엄숙한|쾌적|깨끗한|최상의 ?서비스|최고의 ?서비스|넓은 ?주차|현대적|시설을 ?제공|서비스를 ?제공|절차를 ?지원/, message: "시설·분위기·서비스 수준 추정 금지" },
  // 금액은 '숫자 + (만/천/억) + 원' 형태로만 판정한다. 예전 규칙 `[0-9,]+\s*원`은 숫자 없이
  // 쉼표 하나만으로도 성립해서, "…제공되며, 원하는 문구를" 의 ", 원"이 금액으로 잡혔다
  // (2026-08-03 라마다 Dry-run run-1 실패의 실제 원인). 그래서 숫자를 필수로 두고,
  // '원하다'로 이어지는 경우를 제외한다.
  {
    code: "price",
    pattern: /\d[\d,]*\s*(?:만|천|억)?\s*원(?!하)|가격|요금|금액|비용|배송비|할인|최저가|무료/,
    message: "가격·요금 표현 금지",
  },
  { code: "phone", pattern: /0\d{1,2}-\d{3,4}-\d{4}|1\d{3}-\d{4}/, message: "전화번호 금지" },
  { code: "review", pattern: /후기|별점|리뷰|만족도/, message: "후기·별점 표현 금지" },
  { code: "raw-enum", pattern: /\bfuneral\b|\bhospital\b/i, message: "내부 카테고리 원어(funeral/hospital) 노출 금지" },
]

// 금지 표현은 필드 단위로 찾고, 어떤 문자열이 걸렸는지 코드에 남긴다:
//   banned:<규칙>:<필드>:<매칭 문자열>
// 예전에는 전체 텍스트를 합쳐 검사하고 규칙 코드만 남겨서, 오탐이 나도 어느 문장의 어떤 표현이
// 걸린 것인지 알 수 없었다 (라마다 run-1의 banned:price가 정확히 그 사례였다).
export function scanBannedExpressions(content: AiGeneratedSeoContent): QualityIssue[] {
  const issues: QualityIssue[] = []
  const seen = new Set<string>()
  for (const { field, text } of inspectableContentFields(content)) {
    for (const banned of BANNED_PATTERNS) {
      const match = banned.pattern.exec(text)
      if (match === null) {
        continue
      }
      const matched = match[0].trim()
      const code = `banned:${banned.code}:${field}:${matched}`
      if (!seen.has(code)) {
        seen.add(code)
        issues.push({ level: "fail", code, message: `${banned.message} — ${field}: '${matched}'` })
      }
    }
  }
  return issues
}

export function validateInternalLinks(content: AiGeneratedSeoContent, verifiedPaths: ReadonlySet<string>): QualityIssue[] {
  const issues: QualityIssue[] = []
  for (const link of content.internal_links) {
    if (!verifiedPaths.has(link.href)) {
      issues.push({ level: "fail", code: "link:unverified", message: `실존 검증되지 않은 내부 링크: ${link.href} — internal_links는 검증 경로만 허용 (없으면 [])` })
    }
  }
  return issues
}

export { maskPlaceTokens } from "./text-masking"

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .replace(/[.,·—‘’"'()[\]?!:;]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 0),
  )
}

export function tokenJaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a)
  const setB = tokenize(b)
  if (setA.size === 0 || setB.size === 0) {
    return 0
  }
  let intersection = 0
  for (const token of setA) {
    if (setB.has(token)) {
      intersection += 1
    }
  }
  return intersection / (setA.size + setB.size - intersection)
}

function firstSentence(text: string | null): string {
  if (text === null || text.length === 0) {
    return ""
  }
  const match = /^[^.!?]*[.!?]?/.exec(text)
  return (match?.[0] ?? text).trim()
}

function splitSentences(text: string | null): string[] {
  if (text === null) {
    return []
  }
  return text
    .split(/(?<=[.!?다])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 8)
}

// 반복도 임계값 — 제안값이며 확정 전 조정 가능 (테스트로 근거 고정).
export const REPETITION_THRESHOLDS = {
  firstSentenceFail: 0.85,
  keywordOverlapWarnCount: 4,
} as const

export function checkRepetition(input: QualityEvaluationInput): QualityIssue[] {
  const issues: QualityIssue[] = []
  const mask = (text: string, snapshot?: RecentContentSnapshot): string =>
    snapshot === undefined
      ? maskPlaceTokens(text, input.placeName, input.regionTokens)
      : maskPlaceTokens(text, snapshot.placeName, [snapshot.region])

  const myTitle = mask(input.content.meta_title)
  const myFirstSentence = mask(firstSentence(input.content.description))
  const mySentences = splitSentences(input.content.description).map((sentence) => mask(sentence))
  const myQuestions = input.content.faq.map((entry) => mask(entry.question))
  const myKeywords = input.content.keywords.map((keyword) => mask(keyword))

  for (const page of input.recentPages) {
    const pageTitle = mask(page.title ?? "", page)
    if (myTitle.length > 0 && myTitle === pageTitle) {
      issues.push({ level: "warn", code: "repeat:title", message: `제목이 기존 페이지(${page.placeName})와 동일 구조` })
    }

    const pageFirst = mask(firstSentence(page.description), page)
    const similarity = tokenJaccardSimilarity(myFirstSentence, pageFirst)
    if (similarity >= REPETITION_THRESHOLDS.firstSentenceFail) {
      issues.push({ level: "fail", code: "repeat:first-sentence", message: `본문 첫 문장이 기존 페이지(${page.placeName})와 유사도 ${similarity.toFixed(2)} (기준 ${String(REPETITION_THRESHOLDS.firstSentenceFail)})` })
    }

    const pageSentences = splitSentences(page.description).map((sentence) => mask(sentence, page))
    const identicalSentences = mySentences.filter((sentence) => pageSentences.includes(sentence))
    if (identicalSentences.length >= 2) {
      issues.push({ level: "fail", code: "repeat:sentences", message: `기존 페이지(${page.placeName})와 동일 문장 ${String(identicalSentences.length)}개` })
    }

    const pageQuestions = page.faqQuestions.map((question) => mask(question, page))
    const identicalQuestions = myQuestions.filter((question) => pageQuestions.includes(question))
    if (myQuestions.length >= 2 && identicalQuestions.length >= 2) {
      issues.push({ level: "fail", code: "repeat:faq", message: `FAQ 질문 2개가 모두 기존 페이지(${page.placeName})와 동일` })
    }

    const pageKeywords = new Set(page.keywords.map((keyword) => mask(keyword, page)))
    const overlap = myKeywords.filter((keyword) => pageKeywords.has(keyword)).length
    if (overlap >= REPETITION_THRESHOLDS.keywordOverlapWarnCount) {
      issues.push({ level: "warn", code: "repeat:keywords", message: `키워드 ${String(overlap)}/5개가 기존 페이지(${page.placeName})와 구조 중복` })
    }
  }
  return dedupeIssues(issues)
}

// 제목 패턴·접미사·고정 키워드 세트 검사 (title/keyword variation v1) — 선택 계층이 회피에 실패한 경우를 잡는 이중 안전망.
export function checkTitleKeywordPatterns(input: QualityEvaluationInput): QualityIssue[] {
  const issues: QualityIssue[] = []
  const regionLabels = input.regionTokens
  const mode = input.mode
  // 모드를 모르면 어느 세트와 대조해야 할지 알 수 없다 — 패턴 검사만 건너뛰고 키워드 검사는 그대로 수행한다.
  if (mode !== null) {
    const myPattern = detectTitlePatternId(input.content.meta_title, input.placeName, regionLabels, mode)
    const mySuffix = titleSuffixKeyOf(input.content.meta_title, input.placeName, regionLabels, mode)

    const recentFive = input.recentPages.slice(0, 5)
    const recentPatterns = recentFive.map((page) => detectTitlePatternId(page.title, page.placeName, [page.region], mode))
    const recentSuffixes = recentFive.map((page) => titleSuffixKeyOf(page.title, page.placeName, [page.region], mode))

    if (myPattern !== null && recentPatterns.includes(myPattern)) {
      issues.push({ level: "warn", code: "repeat:title-pattern", message: `제목 유형(${myPattern})이 최근 공개 5건과 중복` })
    }
    if (mySuffix !== null && recentSuffixes.slice(0, 2).length === 2 && recentSuffixes.slice(0, 2).every((suffix) => suffix === mySuffix)) {
      issues.push({ level: "warn", code: "repeat:title-suffix", message: `제목 접미사('${mySuffix}')가 3회 연속` })
    }
  }

  const stockHits = ["근조화환 주문", "장례식장 화환", "화환 주문 안내"].filter((keyword) => input.content.keywords.includes(keyword))
  if (stockHits.length >= 3) {
    issues.push({ level: "warn", code: "keywords:stock-set", message: "고정 3종 키워드 세트(근조화환 주문/장례식장 화환/화환 주문 안내) 반복" })
  }
  return issues
}

// 업종 모드에 맞지 않는 어휘 — 규칙은 mode-vocabulary가 소유하고 여기서는 등급만 매긴다.
// 모드를 모르면(구 레코드) 어떤 어휘표를 적용할지 알 수 없으므로 검사하지 않는다.
export function checkModeVocabulary(input: QualityEvaluationInput): QualityIssue[] {
  if (input.mode === null) {
    return []
  }
  const findings = findForbiddenModeVocabulary({ content: input.content, mode: input.mode, placeName: input.placeName, regionTokens: input.regionTokens })
  return findings.map((finding) => ({
    level: "fail" as const,
    code: forbiddenVocabularyCode(finding),
    message: `${finding.mode} 콘텐츠에 쓸 수 없는 표현 '${finding.term}' (${finding.field})`,
  }))
}

export function evaluateGeneratedContent(input: QualityEvaluationInput): QualityReport {
  const issues: QualityIssue[] = [
    ...scanBannedExpressions(input.content),
    ...validateInternalLinks(input.content, input.verifiedInternalPaths),
    ...checkRepetition(input),
    ...checkTitleKeywordPatterns(input),
    ...checkModeVocabulary(input),
  ]
  if (input.content.faq.length !== 2) {
    issues.push({ level: "fail", code: "structure:faq-count", message: `FAQ는 정확히 2개여야 합니다 (현재 ${String(input.content.faq.length)}개)` })
  }
  if (input.faqSelection === "exhausted-min-overlap") {
    issues.push({ level: "warn", code: "faq:pool-exhausted", message: "FAQ 조합 후보가 모두 최근 공개 페이지와 충돌하여 최소 중복 조합으로 선택됨 — FAQ 주제 pool 확장 검토 필요" })
  }
  const nameText = [input.content.meta_title, input.content.description].join(" ")
  const nameCore = input.placeName.split(/\s+/).at(-1) ?? input.placeName
  if (!nameText.includes(nameCore)) {
    issues.push({ level: "fail", code: "structure:place-name", message: "제목·본문에 장소명이 포함되어야 합니다" })
  }

  const status: QualityStatus = issues.some((issue) => issue.level === "fail") ? "fail" : issues.length > 0 ? "warn" : "pass"
  return { status, issues }
}

function dedupeIssues(issues: readonly QualityIssue[]): QualityIssue[] {
  const seen = new Set<string>()
  const result: QualityIssue[] = []
  for (const issue of issues) {
    const key = `${issue.code}:${issue.message}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push(issue)
    }
  }
  return result
}
