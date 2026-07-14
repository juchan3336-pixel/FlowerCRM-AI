export type AiProviderEnvironment = {
  readonly AI_PROVIDER?: string | undefined
  readonly OPENAI_API_KEY?: string | undefined
  readonly OPENAI_MODEL?: string | undefined
}

export type AiProviderSelection =
  | { readonly kind: "fake" }
  | { readonly kind: "openai"; readonly apiKey: string; readonly model: string }
  | { readonly kind: "misconfigured"; readonly errorCode: "api_key_missing" | "provider_config" }

export function resolveAiProviderSelection(env: AiProviderEnvironment): AiProviderSelection {
  if (env.AI_PROVIDER?.trim().toLowerCase() !== "openai") {
    return { kind: "fake" }
  }

  const apiKey = env.OPENAI_API_KEY?.trim() ?? ""
  if (apiKey.length === 0) {
    return { kind: "misconfigured", errorCode: "api_key_missing" }
  }

  const model = env.OPENAI_MODEL?.trim() ?? ""
  if (model.length === 0) {
    return { kind: "misconfigured", errorCode: "provider_config" }
  }

  return { kind: "openai", apiKey, model }
}
