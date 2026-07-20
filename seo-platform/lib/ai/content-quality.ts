// 생성 콘텐츠 품질 검사 — 금지 표현, 내부 링크 실존 검증, 최근 공개 페이지 대비 반복도.
// 게시 준비 게이트와 관리자 미리보기 성적표가 함께 사용한다.
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
  readonly regionTokens: readonly (string | null)[]
  readonly verifiedInternalPaths: ReadonlySet<string>
  readonly recentPages: readonly RecentContentSnapshot[]
}

// 절대 금지 표현 — 프롬프트에도 명시되지만 생성 결과에서 이중으로 차단한다.
const BANNED_PATTERNS: readonly { readonly code: string; readonly pattern: RegExp; readonly message: string }[] = [
  { code: "official-order", pattern: /공식 ?주문|공식 ?CTA/i, message: "'공식 주문/공식 CTA' 표현 금지" },
  { code: "cta-term", pattern: /CTA/i, message: "내부 용어 'CTA' 사용 금지 — '화환 주문하기 버튼'으로 표현" },
  { code: "designated", pattern: /지정 ?꽃배달|지정 ?업체|협력 ?업체|제휴 ?업체|제휴/, message: "제휴·지정·협력 업체 표현 금지" },
  { code: "delivery-guarantee", pattern: /배송이 가능합니다|배송이 ?가능한|배송해 ?드립니다|당일 ?배송|빠른 ?배송|즉시 ?배송|배송을 ?보장/, message: "배송 확정·보장 표현 금지 — 주문 과정에서 확인으로 안내" },
  { code: "facility-claim", pattern: /편리한 ?시설|편의 ?시설|조용하고|엄숙한|쾌적|깨끗한|최상의 ?서비스|최고의 ?서비스|넓은 ?주차|현대적|시설을 ?제공|서비스를 ?제공|절차를 ?지원/, message: "시설·분위기·서비스 수준 추정 금지" },
  { code: "price", pattern: /[0-9,]+\s*원|가격|요금|비용 ?안내/, message: "가격·요금 표현 금지" },
  { code: "phone", pattern: /0\d{1,2}-\d{3,4}-\d{4}|1\d{3}-\d{4}/, message: "전화번호 금지" },
  { code: "review", pattern: /후기|별점|리뷰|만족도/, message: "후기·별점 표현 금지" },
  { code: "raw-enum", pattern: /\bfuneral\b|\bhospital\b/i, message: "내부 카테고리 원어(funeral/hospital) 노출 금지" },
]

function collectContentText(content: AiGeneratedSeoContent): string {
  return [content.meta_title, content.meta_description, content.description, ...content.faq.flatMap((entry) => [entry.question, entry.answer]), ...content.keywords].join("\n")
}

export function scanBannedExpressions(content: AiGeneratedSeoContent): QualityIssue[] {
  const text = collectContentText(content)
  const issues: QualityIssue[] = []
  for (const banned of BANNED_PATTERNS) {
    if (banned.pattern.test(text)) {
      issues.push({ level: "fail", code: `banned:${banned.code}`, message: banned.message })
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

// 장소명·지역명·주소 토큰을 마스킹해 '치환 템플릿' 여부를 판정 가능하게 한다.
// (장소명/지역명 → 〈장소〉, 숫자 포함 토큰 → 〈숫자〉, 도로·행정구역 지명 → 〈지명〉)
export function maskPlaceTokens(text: string, placeName: string, regionTokens: readonly (string | null)[]): string {
  let masked = text
  const tokens = [placeName, ...placeName.split(/\s+/), ...regionTokens.filter((token): token is string => token !== null && token.length > 0)]
  for (const token of tokens.filter((token) => token.length >= 2).sort((a, b) => b.length - a.length)) {
    masked = masked.split(token).join("〈장소〉")
  }
  masked = masked.replace(/〈장소〉(〈장소〉)+/g, "〈장소〉")
  return masked
    .split(/\s+/)
    .map((token) => {
      if (token.includes("〈장소〉")) {
        return token
      }
      if (/\d/.test(token)) {
        return "〈숫자〉"
      }
      if (/(?:대로|[가-힣]로|[가-힣]길|[가-힣]읍|[가-힣]면|[가-힣]동|[가-힣]리)(?:에|에서)?$/.test(token) && !/(?:으로|스로|대로는|려면|으면|다면|이면|하면|보면)$/.test(token)) {
        return "〈지명〉"
      }
      return token
    })
    .join(" ")
}

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

export function evaluateGeneratedContent(input: QualityEvaluationInput): QualityReport {
  const issues: QualityIssue[] = [
    ...scanBannedExpressions(input.content),
    ...validateInternalLinks(input.content, input.verifiedInternalPaths),
    ...checkRepetition(input),
  ]
  if (input.content.faq.length !== 2) {
    issues.push({ level: "fail", code: "structure:faq-count", message: `FAQ는 정확히 2개여야 합니다 (현재 ${String(input.content.faq.length)}개)` })
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
