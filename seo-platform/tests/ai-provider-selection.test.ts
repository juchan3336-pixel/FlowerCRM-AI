import { describe, expect, it } from "vitest"

import { resolveAiProviderSelection } from "@/lib/ai/provider-selection"

describe("ai provider selection", () => {
  it("defaults to the fake provider when AI_PROVIDER is missing or unknown", () => {
    // Given / When / Then: anything except "openai" stays on the safe fake provider.
    expect(resolveAiProviderSelection({})).toEqual({ kind: "fake" })
    expect(resolveAiProviderSelection({ AI_PROVIDER: "fake" })).toEqual({ kind: "fake" })
    expect(resolveAiProviderSelection({ AI_PROVIDER: "gpt" })).toEqual({ kind: "fake" })
    expect(resolveAiProviderSelection({ AI_PROVIDER: "" })).toEqual({ kind: "fake" })
  })

  it("selects openai only when key and model are both present", () => {
    // Given / When: openai with full configuration.
    const selection = resolveAiProviderSelection({ AI_PROVIDER: "openai", OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "gpt-4o-mini" })

    // Then: the real provider is selected with its configuration.
    expect(selection).toEqual({ kind: "openai", apiKey: "sk-test", model: "gpt-4o-mini" })
  })

  it("reports api_key_missing when openai is selected without a key", () => {
    // Given / When / Then: missing or blank key blocks the call before any request.
    expect(resolveAiProviderSelection({ AI_PROVIDER: "openai", OPENAI_MODEL: "gpt-4o-mini" })).toEqual({ kind: "misconfigured", errorCode: "api_key_missing" })
    expect(resolveAiProviderSelection({ AI_PROVIDER: "openai", OPENAI_API_KEY: "  ", OPENAI_MODEL: "gpt-4o-mini" })).toEqual({ kind: "misconfigured", errorCode: "api_key_missing" })
  })

  it("reports provider_config when openai is selected without a model", () => {
    // Given / When / Then: the model must come from the environment, never from code.
    expect(resolveAiProviderSelection({ AI_PROVIDER: "openai", OPENAI_API_KEY: "sk-test" })).toEqual({ kind: "misconfigured", errorCode: "provider_config" })
  })
})
