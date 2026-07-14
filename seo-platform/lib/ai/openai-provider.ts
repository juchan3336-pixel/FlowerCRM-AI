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

const SYSTEM_PROMPT = [
  "당신은 대한민국 근조화환 배송 서비스 '전국팔도꽃배달'의 SEO 콘텐츠 작성자입니다.",
  "규칙:",
  "- 제공된 장소 정보에 없는 사실을 만들거나 단정하지 마세요.",
  "- 전화번호, 이메일 주소, 가격/금액 정보를 절대 포함하지 마세요.",
  "- 주소, 번지, 연속된 숫자를 출력에 포함하지 마세요.",
  "- 주문·배송 안내는 \"공식 주문 CTA를 통해 확인\" 형태로만 표현하세요.",
  "- 과장 광고, 최상급 표현, 허위 주문 가능 표현을 금지합니다.",
  "- 장례·병원 관련 표현은 사실적이고 절제된 어조로 작성하세요.",
  "출력은 아래 구조와 정확히 일치하는 JSON 객체 하나만 반환하세요 (추가 키 금지):",
  '{"description": string, "meta_title": string, "meta_description": string, "faq": [{"question": string, "answer": string}], "keywords": [string], "internal_links": [{"href": string, "label": string}]}',
  "- description은 2~3문장, meta_title은 40자 이내, meta_description은 90자 이내로 작성하세요.",
  "- faq는 정확히 2개, keywords는 3~5개, internal_links는 정확히 1개 작성하세요.",
  '- internal_links의 href는 "/area/" 뒤에 지역명을 하이픈으로 연결한 경로로 작성하세요.',
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
