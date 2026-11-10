// AI 초안 만들기 — 버튼 한 번으로 주제 선택 → 글 생성 → 품질 검사(필요하면 1회 보정) → 소재 저장 → 검수 대기까지.
//
// 순서가 중요하다:
//   1) 호출 전에 최악 비용을 예약한다. 일·월 상한을 넘으면 호출하지 않는다.
//   2) 응답을 받지 못한 호출(timeout)은 결과 불명으로 닫고 다시 부르지 않는다 — 요금이 이미 나갔을 수 있다.
//   3) 품질 검사에 걸리면 사유를 넘겨 한 번만 다시 쓰게 한다. 그래도 걸리면 작성 중(draft)으로 저장해 사람이 고친다.
//   4) 통과한 초안도 승인은 사람이 한다. 여기서는 검수 대기까지만 간다.
import { getMarketingChannel, isMarketingChannelCode } from "../channel-policy"
import type { MarketingService } from "../marketing-service"
import type { GenerationCapKind, GenerationCaps, MarketingRepository } from "../repository"
import type { MarketingVariantRow } from "@/types/database"

import { actualCostUsd, MarketingAiError, worstCaseDraftCostUsd, type GeneratedCopy, type MarketingCopyProvider, type TokenUsage } from "./provider"
import { pickDraftTopic } from "./topics"

// 초기 상한 — 하루 10편, 하루 0.5달러, 월 5달러. 초안 한 편의 예약 금액은 최대 0.05달러.
export const GENERATION_CAPS: GenerationCaps = { dailyCount: 10, dailyUsd: 0.5, monthlyUsd: 5 }
export const MAX_RESERVE_PER_DRAFT_USD = 0.05

// 이미 쓴 제목을 몇 개까지 넘겨 중복을 피하게 할지
const AVOID_TITLES = 10
const TOPIC_HISTORY = 50

export type DraftFailure =
  // 자동 생성이 꺼져 있다(환경 변수 미설정)
  | "ai-disabled"
  | "not-found"
  | "channel-unknown"
  | "channel-disabled"
  // 이 모델로는 초안 한 편의 최악 비용이 허용 범위를 넘는다
  | "ai-cost-too-high"
  // 같은 요청을 이미 받았다
  | "duplicate"
  | `cap-${GenerationCapKind}`
  // 응답을 받지 못했다 — 결과 불명, 자동 재시도 없음
  | "ai-unknown"
  // 제공자 오류 또는 형식이 맞지 않는 응답
  | "ai-failed"
  // 글은 받았지만 소재로 저장하지 못했다
  | "save-failed"

export type DraftResult =
  | { readonly ok: true; readonly variant: MarketingVariantRow; readonly qualityStatus: "pass" | "warn" | "fail"; readonly repaired: boolean }
  | { readonly ok: false; readonly reason: DraftFailure }

export type GenerateDraftInput = {
  readonly campaignId: string
  readonly channel: string
  // 화면이 폼마다 발급하는 키 — 같은 키는 한 번만 처리한다
  readonly requestKey: string
  readonly actor: string
}

function addUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (a === null || b === null) {
    // 한 번이라도 사용량을 모르면 합계도 모른다 — 정산은 예약 금액(최악 비용)으로 남는다
    return null
  }
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens }
}

// 소재 코드 — 추적 링크에 들어간다. 날짜와 요청 키 앞부분으로 만든다(영문/숫자/-).
function variantCodeFor(requestKey: string, nowIso: string): string {
  const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date(nowIso)).replaceAll("-", "").slice(2)
  return `ai-${day}-${requestKey.replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toLowerCase()}`
}

export function createDraftGenerator(deps: {
  readonly repo: MarketingRepository
  readonly marketing: MarketingService
  // null = 자동 생성 꺼짐
  readonly provider: MarketingCopyProvider | null
  readonly now?: () => string
}) {
  const { repo, marketing, provider } = deps
  const now = deps.now ?? (() => new Date().toISOString())

  return {
    async generateDraft(input: GenerateDraftInput): Promise<DraftResult> {
      if (provider === null) {
        return { ok: false, reason: "ai-disabled" }
      }
      if (!isMarketingChannelCode(input.channel)) {
        return { ok: false, reason: "channel-unknown" }
      }
      const channel = getMarketingChannel(input.channel).code
      const campaign = await repo.findCampaign(input.campaignId)
      if (campaign === null) {
        return { ok: false, reason: "not-found" }
      }
      const channelRow = (await repo.listChannels()).find((row) => row.code === channel)
      if (channelRow === undefined || channelRow.publish_mode === "disabled") {
        return { ok: false, reason: "channel-disabled" }
      }
      const reserveUsd = worstCaseDraftCostUsd(provider.model)
      if (reserveUsd === null || reserveUsd > MAX_RESERVE_PER_DRAFT_USD) {
        return { ok: false, reason: "ai-cost-too-high" }
      }

      const history = await repo.listGenerations(campaign.id, TOPIC_HISTORY)
      const topic = pickDraftTopic(
        campaign.mode,
        history.filter((row) => row.channel_code === channel).map((row) => row.topic_key),
      )
      const reserved = await repo.reserveGeneration({
        campaignId: campaign.id,
        channelCode: channel,
        requestKey: input.requestKey,
        topicKey: topic.key,
        model: provider.model,
        reserveUsd,
        caps: GENERATION_CAPS,
        createdBy: input.actor,
      })
      if (reserved.kind === "duplicate") {
        return { ok: false, reason: "duplicate" }
      }
      if (reserved.kind === "cap") {
        return { ok: false, reason: `cap-${reserved.cap}` }
      }

      let usage: TokenUsage | null = { inputTokens: 0, outputTokens: 0 }
      let callCount = 0
      const settleFailure = async (error: unknown): Promise<DraftResult> => {
        const unknown = error instanceof MarketingAiError && error.code === "timeout"
        // 제공자가 오류로 거절한 호출(http)은 사용량이 없다. 형식 오류(parse)는 응답에 사용량이 실려 온다.
        // 그 밖에는 사용량을 모른다 — 합계를 null로 두어 예약 금액 전체가 예산에서 빠지게 한다.
        const extra = error instanceof MarketingAiError ? (error.code === "http" ? { inputTokens: 0, outputTokens: 0 } : error.usage) : null
        const partial = addUsage(usage, extra)
        await repo.settleGeneration(reserved.id, {
          status: unknown ? "unknown" : "failed",
          // 결과 불명이면 실제 비용을 알 수 없다 — null로 두어 예약 금액 전체가 예산에서 빠지게 한다
          actualUsd: unknown ? null : actualCostUsd(provider.model, partial),
          inputTokens: unknown ? null : (partial?.inputTokens ?? null),
          outputTokens: unknown ? null : (partial?.outputTokens ?? null),
          callCount,
          errorCode: error instanceof MarketingAiError ? `ai-${error.code}` : "ai-error",
        })
        return { ok: false, reason: unknown ? "ai-unknown" : "ai-failed" }
      }

      const existing = await repo.listVariants(campaign.id)
      const request = { mode: campaign.mode, channel, topic: topic.prompt, region: campaign.region, avoidTitles: existing.map((variant) => variant.title).slice(0, AVOID_TITLES) }

      let copy: GeneratedCopy
      try {
        callCount += 1
        const first = await provider.generate(request)
        usage = addUsage(usage, first.usage)
        copy = first.copy
      } catch (error) {
        return settleFailure(error)
      }

      const toAdCopy = (generated: GeneratedCopy) => ({ title: generated.title, body: generated.body, ...(generated.caption.length > 0 ? { caption: generated.caption } : {}) })
      let quality = await marketing.previewQuality({ campaign, channel, copy: toAdCopy(copy) })
      let repaired = false
      if (quality.status === "fail") {
        // 한 번만 보정 — 걸린 사유를 그대로 넘겨 다시 쓰게 한다
        try {
          callCount += 1
          const second = await provider.generate({ ...request, fixIssues: quality.issues.map((issue) => issue.message), previous: copy })
          usage = addUsage(usage, second.usage)
          copy = second.copy
          repaired = true
          quality = await marketing.previewQuality({ campaign, channel, copy: toAdCopy(copy) })
        } catch (error) {
          return settleFailure(error)
        }
      }

      const created = await marketing.createVariant({ campaignId: campaign.id, code: variantCodeFor(input.requestKey, now()), channel, copy: toAdCopy(copy), actor: input.actor })
      if (!created.ok) {
        await repo.settleGeneration(reserved.id, {
          status: "failed",
          actualUsd: actualCostUsd(provider.model, usage),
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          callCount,
          errorCode: `save-${created.reason}`,
        })
        return { ok: false, reason: "save-failed" }
      }
      // 저장된 소재에 품질 결과를 남기고, 통과했으면 검수 대기로 넘긴다(실패면 작성 중에 머문다)
      const reviewed = await marketing.requestReview({ campaignId: campaign.id, variantId: created.variant.id, expectedRevision: created.variant.revision, actor: input.actor })
      const qualityStatus = reviewed.ok ? reviewed.quality.status : (reviewed.quality?.status ?? quality.status)
      await repo.settleGeneration(reserved.id, {
        status: "succeeded",
        actualUsd: actualCostUsd(provider.model, usage),
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        callCount,
        variantId: created.variant.id,
        qualityStatus,
      })
      return { ok: true, variant: reviewed.ok ? reviewed.variant : created.variant, qualityStatus, repaired }
    },
  }
}

export type DraftGenerator = ReturnType<typeof createDraftGenerator>
