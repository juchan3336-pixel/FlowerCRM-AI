import "server-only"

// Dry-run 실행에 필요한 실제 의존성 조립 — 조회는 전부 읽기 전용이다.
// 순수 로직(content-dry-run.ts)과 분리해 두어야 테스트가 Supabase·OpenAI 없이 계약만 검증할 수 있다.
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server"
import type { ContentDryRunDependencies, DryRunPlace } from "./content-dry-run"
import { OpenAiSeoContentProvider } from "./openai-provider"
import { resolveAiProviderSelection } from "./provider-selection"
import { estimateUsageCostUsd } from "./usage-cost"

export class DryRunProviderUnavailableError extends Error {
  readonly name = "DryRunProviderUnavailableError"

  constructor(readonly errorCode: string) {
    super(`Dry-run provider unavailable: ${errorCode}`)
  }
}

export async function createDryRunDependencies(): Promise<ContentDryRunDependencies> {
  const selection = resolveAiProviderSelection({
    AI_PROVIDER: process.env["AI_PROVIDER"],
    OPENAI_API_KEY: process.env["OPENAI_API_KEY"],
    OPENAI_MODEL: process.env["OPENAI_MODEL"],
  })
  // fake provider로는 실측 의미가 없다 — 환경 게이트가 이미 막지만 여기서도 확정적으로 거부한다.
  if (selection.kind !== "openai") {
    throw new DryRunProviderUnavailableError(selection.kind === "fake" ? "provider-not-openai" : selection.errorCode)
  }
  const provider = new OpenAiSeoContentProvider({ apiKey: selection.apiKey, model: selection.model })
  const { listRecentPublishedContentSnapshots, listVerifiedInternalPaths } = await import("./supabase-repository")

  return {
    provider,
    model: selection.model,
    loadPlace: async (placeId: string): Promise<DryRunPlace | null> => {
      const client = createSupabaseServiceRoleClient()
      const { data } = await client.from("places").select("*").eq("id", placeId).maybeSingle()
      if (data === null) {
        return null
      }
      const rawUrls = data.verification_source_urls
      return {
        id: data.id,
        name: data.name,
        category: data.category,
        city: data.city,
        district: data.district,
        address: data.address,
        homepage: data.homepage,
        status: data.status,
        slug: data.slug ?? "",
        official_verification_status: data.official_verification_status ?? null,
        exclusion_reason: data.exclusion_reason ?? null,
        verification_source_urls: Array.isArray(rawUrls) ? rawUrls.filter((url): url is string => typeof url === "string") : [],
      }
    },
    loadRecentContent: () => listRecentPublishedContentSnapshots().catch(() => []),
    loadVerifiedInternalPaths: () => listVerifiedInternalPaths().catch(() => new Set<string>()),
    usage: () => provider.lastUsage,
    estimateCostUsd: (usage) => (usage === null ? null : estimateUsageCostUsd(selection.model, { ...usage, total_tokens: null })),
  }
}
