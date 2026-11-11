// AI 초안 문장 검사 — 금지 규칙(ad-quality)과 별개로 "읽을 가치가 있는 글인가"를 본다.
//
// 2026-11-11 운영 첫 초안은 금지 규칙을 모두 지켰지만 승인하지 않았다: 누구나 아는 단어를 풀어 쓰고,
// "정확히"를 반복하고, 마지막 문단에서 앞 내용을 다시 요약했다. 이 검사는 그런 글을 찾아 한 번 다시 쓰게 한다.
// 승인을 막지는 않는다(판단은 사람이 한다) — 생성 직후 보정의 근거로만 쓴다.
import type { DraftTopic } from "./topics"

export type StyleIssue = {
  readonly code: string
  // 보정 요청에 그대로 넘기는 문장 — 모델이 무엇을 고쳐야 하는지 알 수 있게 쓴다
  readonly message: string
}

type StyleInput = {
  readonly title: string
  readonly body: string
}

// 강조어 — 글 전체에서 각각 이 횟수를 넘으면 반복으로 본다
const INTENSIFIERS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "정확", pattern: /정확/g },
  { label: "반드시", pattern: /반드시/g },
  { label: "꼭", pattern: /(?:^|[\s,])꼭(?=[\s,])/g },
  { label: "중요", pattern: /중요/g },
]
const INTENSIFIER_LIMIT = 2

// 빈말 — 정보 없이 문장을 끝내거나 꾸미는 표현
const CLICHES: readonly string[] = ["참고하시기 바랍니다", "참고해 주시기 바랍니다", "도움이 됩니다", "도움이 될 것입니다", "원활한", "원활하게"]

// 누구나 아는 단어를 풀어 설명하는 문장
const DEFINITION_PATTERN = /의미(?:합니다|하며|하고|하는데)|(?:을|를) 말합니다|(?:이|가) 위치한 (?:곳|구역|장소)/

// 마지막 문단에서 앞 내용을 다시 정리하는 시작말
const SUMMARY_OPENER = /^(?:이처럼|이와 같이|이렇게|정리하면|요약하면|결론적으로|종합하면)/

// 첫 문장을 예고로 시작하는 경우 ("~할 때는 몇 가지 정보가 필요합니다")
const VAGUE_OPENER = /몇 가지|여러 가지/

// 작은따옴표 인용 — 리본 문구 등 그대로 옮겨 쓸 수 있는 예시
const QUOTED_EXAMPLE = /['‘][^'’\n]{2,60}['’]/g
const MIN_QUOTED_EXAMPLES = 2

function paragraphs(body: string): readonly string[] {
  return body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
}

function firstSentence(body: string): string {
  const first = paragraphs(body)[0] ?? ""
  return (/^[^.!?。]*[.!?。]?/.exec(first)?.[0] ?? first).trim()
}

function requiresQuotedExamples(topic: DraftTopic): boolean {
  return topic.must.some((item) => item.includes("작은따옴표"))
}

export function checkDraftStyle(copy: StyleInput, topic: DraftTopic): readonly StyleIssue[] {
  const issues: StyleIssue[] = []
  const text = `${copy.title}\n${copy.body}`

  for (const { label, pattern } of INTENSIFIERS) {
    const count = text.match(pattern)?.length ?? 0
    if (count > INTENSIFIER_LIMIT) {
      issues.push({ code: `style:repeat:${label}`, message: `'${label}'을(를) ${String(count)}번 썼다 — 두 번까지만 쓰고 나머지는 구체적인 내용으로 바꿔라` })
    }
  }

  const cliches = CLICHES.filter((phrase) => text.includes(phrase))
  if (cliches.length > 0) {
    issues.push({ code: "style:cliche", message: `빈말을 지워라: ${cliches.map((phrase) => `'${phrase}'`).join(", ")}` })
  }

  const definition = DEFINITION_PATTERN.exec(copy.body)
  if (definition !== null) {
    issues.push({ code: "style:definition", message: `누구나 아는 단어를 풀어 설명하는 문장을 지워라('${definition[0]}'가 들어간 문장)` })
  }

  const last = paragraphs(copy.body).at(-1) ?? ""
  if (SUMMARY_OPENER.test(last)) {
    issues.push({ code: "style:summary-ending", message: "마지막 문단이 앞 내용을 다시 요약한다 — 요약 대신 주문할 때 바로 할 행동 하나를 안내하라" })
  }

  if (VAGUE_OPENER.test(firstSentence(copy.body))) {
    issues.push({ code: "style:vague-opener", message: "첫 문장이 '몇 가지 정보가 필요하다'는 예고다 — 첫 문장부터 구체적인 정보로 시작하라" })
  }

  if (requiresQuotedExamples(topic)) {
    const quoted = copy.body.match(QUOTED_EXAMPLE)?.length ?? 0
    if (quoted < MIN_QUOTED_EXAMPLES) {
      issues.push({ code: "style:missing-examples", message: `그대로 옮겨 쓸 수 있는 예시를 작은따옴표로 ${String(MIN_QUOTED_EXAMPLES)}개 이상 넣어라(현재 ${String(quoted)}개)` })
    }
  }

  return issues
}
