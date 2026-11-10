// 광고 문안 자동 생성 — 광고 전용 AI 설정과 호출.
//
// 장소 페이지 생성(lib/ai, AI_PROVIDER)과는 스위치가 다르다. MARKETING_AI_PROVIDER=openai일 때만 실제 호출하고,
// 설정이 없으면 "꺼짐"이다 — 꺼진 상태에서 견본 문안을 운영 소재로 저장하지 않는다.
// 프롬프트와 출력 형식도 광고 전용이다(SEO용 FAQ·키워드 구조를 쓰지 않는다).
import type { ContentMode } from "@/lib/ai/content-mode"

import type { MarketingChannelCode } from "../types"

export type MarketingAiEnvironment = {
  readonly MARKETING_AI_PROVIDER?: string | undefined
  readonly OPENAI_API_KEY?: string | undefined
  readonly OPENAI_MODEL?: string | undefined
}

export type MarketingAiSelection =
  // 설정하지 않았다 — 자동 생성 기능 꺼짐
  | { readonly kind: "disabled" }
  | { readonly kind: "openai"; readonly apiKey: string; readonly model: string }
  // 켜려고 했지만 값이 빠졌거나, 비용을 계산할 수 없는 모델이다
  | { readonly kind: "misconfigured"; readonly reason: "api-key-missing" | "model-missing" | "model-price-unknown" }

// 모델 단가 (USD, 100만 토큰당). 여기에 없는 모델은 비용 상한을 계산할 수 없으므로 호출하지 않는다.
const PRICING_PER_MILLION_TOKENS_USD: Readonly<Record<string, { readonly input: number; readonly output: number }>> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
}

// 한 번의 호출에 허용하는 최대 크기 — 최악 비용 계산의 근거
// 입력 상한은 "요청 메시지의 UTF-8 바이트 수"로 강제한다. 토큰 하나는 최소 1바이트이므로
// 바이트 수가 이 값 이하면 입력 토큰도 이 값을 넘지 못한다 — 실제 토큰 수를 세지 않고도 최악 비용이 보장된다.
export const MAX_INPUT_TOKENS = 12_000
// 메시지 구조(role 등)에 붙는 토큰 여유분
const MESSAGE_OVERHEAD_TOKENS = 100
// 요청에 싣는 가변 값의 길이 제한 — 지역 이름·기존 제목·반려 사유·이전 초안이 아무리 길어도 요청 크기가 정해진 범위에 머문다
const LIMITS = { topic: 200, region: 40, title: 60, titles: 10, issue: 100, issues: 6, previousTitle: 80, previousBody: 1000 } as const

function clip(value: string, maxChars: number): string {
  // 코드 포인트 단위로 자른다(문자 중간이 잘리지 않게)
  return Array.from(value.trim()).slice(0, maxChars).join("")
}

export function messagesByteLength(messages: readonly { readonly content: string }[]): number {
  return messages.reduce((total, message) => total + new TextEncoder().encode(message.content).length, 0)
}
export const MAX_OUTPUT_TOKENS = 900
// 초안 한 편에 최대 몇 번 호출하는가 (최초 1회 + 품질 보정 1회)
export const MAX_CALLS_PER_DRAFT = 2

function pricingOf(model: string): { readonly input: number; readonly output: number } | null {
  return Object.hasOwn(PRICING_PER_MILLION_TOKENS_USD, model) ? (PRICING_PER_MILLION_TOKENS_USD[model] ?? null) : null
}

export function resolveMarketingAiSelection(env: MarketingAiEnvironment): MarketingAiSelection {
  if (env.MARKETING_AI_PROVIDER?.trim().toLowerCase() !== "openai") {
    return { kind: "disabled" }
  }
  const apiKey = env.OPENAI_API_KEY?.trim() ?? ""
  if (apiKey.length === 0) {
    return { kind: "misconfigured", reason: "api-key-missing" }
  }
  const model = env.OPENAI_MODEL?.trim() ?? ""
  if (model.length === 0) {
    return { kind: "misconfigured", reason: "model-missing" }
  }
  if (pricingOf(model) === null) {
    return { kind: "misconfigured", reason: "model-price-unknown" }
  }
  return { kind: "openai", apiKey, model }
}

function round6(value: number): number {
  return Math.ceil(value * 1_000_000) / 1_000_000
}

// 초안 한 편의 최악 비용 — 예약할 금액. 단가를 모르는 모델이면 null(호출 금지).
export function worstCaseDraftCostUsd(model: string): number | null {
  const pricing = pricingOf(model)
  if (pricing === null) {
    return null
  }
  return round6((MAX_CALLS_PER_DRAFT * (MAX_INPUT_TOKENS * pricing.input + MAX_OUTPUT_TOKENS * pricing.output)) / 1_000_000)
}

export type TokenUsage = { readonly inputTokens: number; readonly outputTokens: number }

// 실제 사용량의 비용. 사용량이나 단가를 모르면 null — 그때는 예약 금액(최악 비용)을 그대로 쓴 것으로 친다.
export function actualCostUsd(model: string, usage: TokenUsage | null): number | null {
  const pricing = pricingOf(model)
  if (pricing === null || usage === null) {
    return null
  }
  return round6((usage.inputTokens * pricing.input + usage.outputTokens * pricing.output) / 1_000_000)
}

export type CopyRequest = {
  readonly mode: ContentMode
  readonly channel: MarketingChannelCode
  // 이번 글의 주제 한 줄
  readonly topic: string
  readonly region: string | null
  // 이미 쓴 제목들 — 같은 글을 반복하지 않게 한다
  readonly avoidTitles: readonly string[]
  // 품질 검사에서 걸린 사유 — 보정 호출일 때만
  readonly fixIssues?: readonly string[]
  readonly previous?: GeneratedCopy
}

export type GeneratedCopy = {
  readonly title: string
  readonly body: string
  readonly caption: string
}

export type CopyResponse = {
  readonly copy: GeneratedCopy
  readonly usage: TokenUsage | null
}

// too-large — 요청이 입력 상한을 넘는다. 호출하지 않았으므로 비용이 없다.
// timeout  — 응답을 끝까지 받지 못했다. 요청이 처리됐는지 알 수 없으므로 자동으로 다시 부르지 않는다.
// http     — 제공자가 오류를 돌려줬다(인증 실패·한도 초과 등)
// parse    — 응답은 왔지만 약속한 형식이 아니다
export type MarketingAiErrorCode = "too-large" | "timeout" | "http" | "parse"

export class MarketingAiError extends Error {
  readonly name = "MarketingAiError"

  constructor(
    readonly code: MarketingAiErrorCode,
    detail: string,
    readonly usage: TokenUsage | null = null,
  ) {
    super(`Marketing AI request failed (${code}): ${detail}`)
  }
}

export type MarketingCopyProvider = {
  readonly model: string
  generate(request: CopyRequest): Promise<CopyResponse>
}

const MODE_BRIEF: Readonly<Record<ContentMode, string>> = {
  condolence:
    "근조화환(장례식장으로 보내는 조의 화환) 주문을 준비하는 사람을 돕는 안내 글이다. 차분하고 정중하게 쓴다. 축하·경사 표현(축하, 결혼, 예식, 개업 등)은 한 글자도 쓰지 않는다. 슬픔을 과장하거나 불안을 자극하지 않는다.",
  celebration:
    "결혼식·행사에 보내는 축하화환 주문을 준비하는 사람을 돕는 안내 글이다. 밝고 담백하게 쓴다. 장례 관련 표현(근조, 조문, 빈소, 장례, 상주, 부고, 고인 등)은 한 글자도 쓰지 않는다.",
  "corporate-celebration":
    "개업·이전·취임·창립 등 기업 행사에 보내는 축하화환 주문을 준비하는 담당자를 돕는 안내 글이다. 실무적으로 쓴다. 장례 관련 표현(근조, 조문, 빈소, 장례, 상주, 부고, 고인 등)은 한 글자도 쓰지 않는다.",
}

const COMMON_RULES = [
  "사실만 쓴다. 꾸며낸 통계·사례·후기를 넣지 않는다.",
  "가격·요금·비용·할인·무료·최저가 등 금액과 관련된 표현을 쓰지 않는다.",
  "배송 시간을 약속하지 않는다('당일 배송', '빠른 배송', '배송해 드립니다', '배송이 가능합니다' 금지). 도착 시점은 '주문 과정에서 확인할 수 있다'고만 안내한다.",
  "후기·별점·리뷰·만족도, 제휴·지정·협력 업체, '공식 주문'이라는 표현을 쓰지 않는다.",
  "전화번호와 웹 주소를 쓰지 않는다. 주문 링크는 시스템이 따로 붙인다.",
  "특정 장례식장·예식장·회사의 시설이나 분위기를 추정해 묘사하지 않는다.",
  "제목은 40자 이내. 본문은 500~900자, 3~5개 문단, 문단 사이는 빈 줄 하나. 마크다운 기호(#, *, -)를 쓰지 않는다.",
  "caption은 본문과 별도로 쓰는 한 줄 요약으로 40자 이내.",
].join("\n- ")

export function buildCopyMessages(request: CopyRequest): readonly { readonly role: "system" | "user"; readonly content: string }[] {
  const system = [
    "너는 화환 배송 업체 '팔도플라워'의 네이버 블로그 글을 쓰는 한국어 작가다.",
    MODE_BRIEF[request.mode],
    `규칙:\n- ${COMMON_RULES}`,
    '출력은 JSON 객체 하나만: {"title": string, "body": string, "caption": string}',
  ].join("\n\n")
  const lines = [`주제: ${clip(request.topic, LIMITS.topic)}`]
  const region = request.region === null ? "" : clip(request.region, LIMITS.region)
  if (region.length > 0) {
    lines.push(`지역: ${region} (지역 이름은 제목이나 첫 문단에 자연스럽게 한두 번만 쓴다)`)
  }
  const titles = request.avoidTitles.slice(0, LIMITS.titles).map((title) => clip(title, LIMITS.title)).filter((title) => title.length > 0)
  if (titles.length > 0) {
    lines.push(`이미 쓴 제목(같은 제목·같은 구성 금지):\n${titles.map((title) => `- ${title}`).join("\n")}`)
  }
  if (request.fixIssues !== undefined && request.previous !== undefined) {
    const issues = request.fixIssues.slice(0, LIMITS.issues).map((issue) => clip(issue, LIMITS.issue))
    lines.push(`아래 초안은 검수에서 다음 사유로 반려됐다. 사유를 모두 고쳐 다시 써라.\n반려 사유:\n${issues.map((issue) => `- ${issue}`).join("\n")}`)
    lines.push(`반려된 초안:\n제목: ${clip(request.previous.title, LIMITS.previousTitle)}\n본문:\n${clip(request.previous.body, LIMITS.previousBody)}`)
  }
  return [
    { role: "system", content: system },
    { role: "user", content: lines.join("\n\n") },
  ]
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function usageOf(payload: unknown): TokenUsage | null {
  const usage = isRecord(payload) ? payload["usage"] : null
  if (!isRecord(usage)) {
    return null
  }
  const inputTokens = numberOrNull(usage["prompt_tokens"])
  const outputTokens = numberOrNull(usage["completion_tokens"])
  return inputTokens === null || outputTokens === null ? null : { inputTokens, outputTokens }
}

export function parseCopyContent(content: string): GeneratedCopy | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (!isRecord(parsed)) {
    return null
  }
  const { title, body, caption } = parsed
  if (typeof title !== "string" || typeof body !== "string" || title.trim().length === 0 || body.trim().length === 0) {
    return null
  }
  return { title: title.trim(), body: body.trim(), caption: typeof caption === "string" ? caption.trim() : "" }
}

// 신호가 끊기면 거부되는 약속 — 본문 읽기가 신호를 따르지 않는 환경에서도 시간 초과가 확실히 걸리게 한다
function abortedPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () => {
      reject(new DOMException("aborted", "AbortError"))
    }
    if (signal.aborted) {
      fail()
    } else {
      signal.addEventListener("abort", fail, { once: true })
    }
  })
}

const DEFAULT_TIMEOUT_MS = 40_000
const ENDPOINT = "https://api.openai.com/v1/chat/completions"

export type OpenAiProviderOptions = {
  readonly apiKey: string
  readonly model: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

export function createOpenAiMarketingProvider(options: OpenAiProviderOptions): MarketingCopyProvider {
  const fetchImpl = options.fetchImpl ?? fetch
  return {
    model: options.model,
    async generate(request) {
      const messages = buildCopyMessages(request)
      // 예약한 최악 비용의 전제(입력 상한)를 호출 전에 확인한다. 넘으면 부르지 않는다.
      if (messagesByteLength(messages) + MESSAGE_OVERHEAD_TOKENS > MAX_INPUT_TOKENS) {
        throw new MarketingAiError("too-large", "request exceeds input limit")
      }
      const controller = new AbortController()
      // 타이머는 응답 본문을 끝까지 읽을 때까지 유지한다 — 헤더만 오고 본문이 멈추는 경우에도 끊는다.
      const timer = setTimeout(() => {
        controller.abort()
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      let status: number
      let text: string
      try {
        const response = await fetchImpl(ENDPOINT, {
          method: "POST",
          headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: options.model, messages, temperature: 0.6, max_tokens: MAX_OUTPUT_TOKENS, response_format: { type: "json_object" } }),
          signal: controller.signal,
        })
        status = response.status
        // 거절 응답은 본문을 읽지 않는다(요청 내용·키가 섞여 올 수 있다)
        text = response.ok ? await Promise.race([response.text(), abortedPromise(controller.signal)]) : ""
      } catch (error) {
        // 네트워크 단절·시간 초과 — 요청이 처리됐는지 알 수 없다
        throw new MarketingAiError("timeout", error instanceof Error ? error.name : "request did not complete")
      } finally {
        clearTimeout(timer)
      }
      if (status < 200 || status >= 300) {
        throw new MarketingAiError("http", `status ${String(status)}`)
      }
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        throw new MarketingAiError("parse", "response is not json")
      }
      const usage = usageOf(payload)
      const choices = isRecord(payload) ? payload["choices"] : null
      const first: unknown = Array.isArray(choices) ? choices[0] : null
      const message = isRecord(first) ? first["message"] : null
      const content = isRecord(message) ? message["content"] : null
      const copy = typeof content === "string" ? parseCopyContent(content) : null
      if (copy === null) {
        throw new MarketingAiError("parse", "missing title/body", usage)
      }
      return { copy, usage }
    },
  }
}
