import { pickContentVariation } from "./content-variation"
import { faqTopicByKey } from "./faq-variation"
import type { AiGenerationInput, AiGenerationUsage, AiProvider } from "./types"

export const AI_PROVIDER_ERROR_CODES = [
  "api_key_missing",
  "provider_config",
  "timeout",
  "rate_limit",
  "invalid_response",
  "json_parse",
  "network",
  "provider_error",
] as const

export type AiProviderErrorCode = (typeof AI_PROVIDER_ERROR_CODES)[number]

// 오류 메시지에는 코드와 HTTP 상태만 담는다. 응답 본문·API 키·헤더는 절대 포함하지 않는다.
export class AiProviderRequestError extends Error {
  readonly name = "AiProviderRequestError"

  constructor(readonly code: AiProviderErrorCode, safeDetail: string) {
    super(`AI provider request failed (${code}): ${safeDetail}`)
  }
}

export type OpenAiProviderOptions = {
  readonly apiKey: string
  readonly model: string
  readonly timeoutMs?: number
  readonly endpoint?: string
  readonly fetchImpl?: typeof fetch
}

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/chat/completions"
const DEFAULT_TIMEOUT_MS = 30_000

// 콘텐츠 품질 v1 프롬프트 — 금지 표현을 명시하고, 장소별 다양화 지시(user 메시지의 variation)를 따르게 한다.
const SYSTEM_PROMPT = [
  "당신은 대한민국 근조화환 배송 서비스 '전국팔도플라워'의 SEO 콘텐츠 작성자입니다.",
  "이 페이지는 해당 장소로 근조화환을 '보내려는 사람'을 위한 주문 안내입니다. 장소 자체를 소개하거나 장소가 서비스를 제공하는 것처럼 쓰지 마세요.",
  "절대 금지 표현 (하나라도 사용하면 실패):",
  "- '공식 주문', '공식 CTA', 'CTA'(내부 용어), '지정 꽃배달', '협력업체', '제휴업체', '제휴'",
  "- '배송이 가능합니다' 등 배송 확정·보장 표현, '당일 배송', '빠른 배송'",
  "- 가격·금액·요금, 전화번호, 이메일, 후기·별점·리뷰",
  "- '편리한 시설', '조용하고 엄숙한 분위기', '최상의 서비스' 등 시설·분위기·서비스 수준 추정 전반",
  "- funeral, hospital 같은 내부 분류 원어",
  "표현 규칙:",
  "- 주문·배송 안내는 \"페이지의 '화환 주문하기' 버튼\"으로만 표현하세요.",
  "- 배송 가능 여부와 세부 조건은 '주문 과정에서 확인된다'고만 안내하세요.",
  "- 주소는 제공된 address 값을 그대로만 사용할 수 있습니다. 그 외 숫자·연락처는 쓰지 마세요.",
  "- 제공된 장소 정보에 없는 사실을 만들거나 단정하지 마세요. 장례 관련 표현은 사실적이고 절제된 어조로 작성하세요.",
  "- 문장 구성은 user 메시지의 variation 지시(도입문 유형, 본문 구성, FAQ 주제 2개)를 따르세요. 다른 페이지와 같은 문장을 장소명만 바꿔 재사용하지 마세요.",
  "- user 메시지에 content_plan이 있으면 meta_title은 content_plan.title 문자열을 그대로, keywords는 content_plan.keywords 배열을 순서 그대로 사용하세요. 임의로 바꾸지 마세요.",
  "출력은 아래 구조와 정확히 일치하는 JSON 객체 하나만 반환하세요 (추가 키 금지):",
  '{"description": string, "meta_title": string, "meta_description": string, "faq": [{"question": string, "answer": string}], "keywords": [string], "internal_links": []}',
  "- description은 2~3문장, meta_title은 40자 이내, meta_description은 90자 이내로 작성하세요.",
  "- faq는 정확히 2개(variation의 FAQ 주제 2개를 각각 하나씩), keywords는 3~5개로 작성하세요.",
  "- internal_links는 반드시 빈 배열 []로 두세요. 경로를 임의로 만들지 마세요.",
].join("\n")

export class OpenAiSeoContentProvider implements AiProvider {
  #lastUsage: AiGenerationUsage | null = null

  constructor(private readonly options: OpenAiProviderOptions) {}

  get lastUsage(): AiGenerationUsage | null {
    return this.#lastUsage
  }

  async generateSeoContent(input: AiGenerationInput): Promise<unknown> {
    this.#lastUsage = null
    const fetchImpl = this.options.fetchImpl ?? fetch
    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => {
      controller.abort()
    }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    let response: Response
    try {
      response = await fetchImpl(this.options.endpoint ?? DEFAULT_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify(buildRequestBody(this.options.model, input)),
        signal: controller.signal,
      })
    } catch (error) {
      throw classifyTransportError(error)
    } finally {
      clearTimeout(timeoutHandle)
    }

    if (response.status === 429) {
      throw new AiProviderRequestError("rate_limit", "HTTP 429")
    }
    if (response.status === 401 || response.status === 403) {
      throw new AiProviderRequestError("provider_config", `HTTP ${String(response.status)}`)
    }
    if (!response.ok) {
      throw new AiProviderRequestError("provider_error", `HTTP ${String(response.status)}`)
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new AiProviderRequestError("invalid_response", "response body is not JSON")
    }

    this.#lastUsage = extractUsage(payload)
    const content = extractMessageContent(payload)

    try {
      return JSON.parse(content) as unknown
    } catch {
      throw new AiProviderRequestError("json_parse", "model output is not valid JSON")
    }
  }
}

function buildRequestBody(model: string, input: AiGenerationInput): Record<string, unknown> {
  const variation = pickContentVariation(`${input.place.id}:${input.place.name}`)
  // FAQ 주제는 content_plan이 확정한 pair를 우선 사용한다 (FAQ 다양화 v1 — 회피 반영). 계획이 없거나 키가 유효하지 않으면 기존 해시 선택 유지.
  const plannedKeys = input.content_plan?.faq_topic_keys ?? []
  const plannedFaqTopics = plannedKeys.flatMap((key) => {
    const topic = faqTopicByKey(key)
    return topic === null ? [] : [topic]
  })
  const faqInstructions =
    plannedKeys.length === 2 && plannedFaqTopics.length === 2
      ? plannedFaqTopics.map((topic) => topic.instruction)
      : variation.faqTopics.map((topic) => topic.instruction)
  return {
    model,
    temperature: 0.3,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          place: input.place,
          guardrails: input.guardrails,
          ...(input.content_plan === undefined ? {} : { content_plan: input.content_plan }),
          variation: {
            intro: variation.intro.instruction,
            structure: variation.structure.instruction,
            faq_topics: faqInstructions,
          },
        }),
      },
    ],
  }
}

function classifyTransportError(error: unknown): AiProviderRequestError {
  if (typeof error === "object" && error !== null && "name" in error && (error).name === "AbortError") {
    return new AiProviderRequestError("timeout", "request timed out")
  }
  return new AiProviderRequestError("network", "network request failed")
}

function extractMessageContent(payload: unknown): string {
  const record = asRecord(payload)
  const choices = record?.["choices"]
  const firstChoice = Array.isArray(choices) ? asRecord(choices[0]) : null
  const message = asRecord(firstChoice?.["message"])
  const content = message?.["content"]
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new AiProviderRequestError("invalid_response", "response has no message content")
  }
  return content
}

function extractUsage(payload: unknown): AiGenerationUsage | null {
  const usage = asRecord(asRecord(payload)?.["usage"])
  if (usage === null) {
    return null
  }
  return {
    input_tokens: numberOrNull(usage["prompt_tokens"]),
    output_tokens: numberOrNull(usage["completion_tokens"]),
    total_tokens: numberOrNull(usage["total_tokens"]),
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}
