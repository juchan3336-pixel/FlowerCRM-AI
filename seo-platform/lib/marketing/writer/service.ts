// 광고 글쓰기 — 버튼 한 번으로 입력 확인 → 비용 예약 → 글 생성 → 검사(필요하면 1회 보정) → 주문 링크 → 결과 저장.
//
// 캠페인 초안(ai/draft-service.ts)과 같은 원칙을 지킨다:
//   1) 호출 전에 최악 비용을 예약한다. 캠페인 초안과 같은 원장·같은 상한(GENERATION_CAPS)을 쓴다.
//   2) 응답을 받지 못한 호출(timeout)은 결과 불명으로 닫고 다시 부르지 않는다.
//   3) 금지 규칙이나 문장 문제가 있으면 사유를 넘겨 한 번만 다시 쓰게 한다.
//   4) 승인·게시는 없다. 사람이 결과를 보고 복사해 쓴다. 금지 규칙이 남은 글은 화면에서 복사를 막는다.
// 주문 링크는 모델이 만들지 않는다 — 허용된 목적지 주소에 추적 빌더로 붙인다.
import type { MarketingWriterOutputRow } from "@/types/database"

import { actualCostUsd, MarketingAiError, type TokenUsage } from "../ai/provider"
import { GENERATION_CAPS, MAX_RESERVE_PER_DRAFT_USD } from "../ai/draft-service"
import { listDraftTopics } from "../ai/topics"
import { getOrderDestination } from "../order-destination"
import { WRITER_HARD_LIMITS, type CompleteWriterResult, type GenerationCapKind, type MarketingRepository } from "../repository"
import { buildTrackedOrderUrl } from "../tracking-url"
import type { OrderDestinationCode } from "../types"

import { checkWriterCopy, type WriterCheck } from "./check"
import { worstCaseWriterCostUsd, type WriterCopy, type WriterProvider, type WriterRequest } from "./prompt"
import { validateWriterInput, type WriterInput, type WriterInputError, type WriterRawInput } from "./spec"

// 추적 링크의 캠페인 자리에 넣는 값 — 쇼핑몰 보고서에서 광고 글쓰기로 만든 글의 주문을 따로 볼 수 있다
export const WRITER_CAMPAIGN_CODE = "writer"

const AVOID_TITLES = 10
const RECENT_FOR_TITLES = 30

export type WriterFailure =
  | WriterInputError
  | "ai-disabled"
  | "ai-cost-too-high"
  | "duplicate"
  | `cap-${GenerationCapKind}`
  | "ai-unknown"
  | "ai-failed"
  | "save-failed"

export type WriterResult =
  | { readonly ok: true; readonly outputId: string; readonly qualityStatus: "pass" | "warn" | "fail"; readonly repaired: boolean }
  | { readonly ok: false; readonly reason: WriterFailure }

export type GenerateWriterInput = WriterRawInput & {
  readonly requestKey: string
  readonly actor: string
}

function addUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (a === null || b === null) {
    return null
  }
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens }
}

// 링크의 소재 자리 값 — 날짜와 생성 기록 id로 만든다(영문/숫자/-). 같은 글의 두 목적지 링크는 같은 값을 쓴다.
export function writerVariantCode(generationId: string, nowIso: string): string {
  const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date(nowIso)).replaceAll("-", "").slice(2)
  return `w-${day}-${generationId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12).toLowerCase()}`
}

export function buildWriterOrderLinks(input: WriterInput, generationId: string, nowIso: string): readonly { readonly destination: OrderDestinationCode; readonly url: string }[] {
  if (input.channel === null) {
    return []
  }
  const channel = input.channel
  const variantCode = writerVariantCode(generationId, nowIso)
  return input.destinations.map((destination) => ({
    destination,
    url: buildTrackedOrderUrl({ channel, destination, baseUrl: getOrderDestination(destination).baseUrl, campaignCode: WRITER_CAMPAIGN_CODE, variantCode }).url,
  }))
}

// 주제가 미리 정한 주제와 같으면 그 주제의 "반드시 넣을 내용"을 함께 싣는다
function mustFor(input: WriterInput): readonly string[] {
  return listDraftTopics(input.mode).find((topic) => topic.prompt === input.topic)?.must ?? []
}

// 상품 사양의 근거는 사람이 확인해 입력한 상품명·구성/사양뿐이다(주제·강조할 점 제외)
export function productEvidenceOf(productName: string | null, productSpecs: string | null): string {
  return [productName ?? "", productSpecs ?? ""].join("\n")
}

// 저장 상한 안으로 자른다 — 상한을 넘는 글은 이미 금지(fail)로 판정돼 복사가 막히지만, 비용을 낸 기록은 남겨야 한다
function clipToHardLimits(copy: WriterCopy): WriterCopy {
  const cut = (value: string, max: number): string => Array.from(value).slice(0, max).join("")
  return { title: cut(copy.title, WRITER_HARD_LIMITS.title), body: cut(copy.body, WRITER_HARD_LIMITS.body), tags: copy.tags.slice(0, WRITER_HARD_LIMITS.tags), caption: cut(copy.caption, WRITER_HARD_LIMITS.caption) }
}

function issuesOf(check: WriterCheck): readonly string[] {
  return [...check.blocking, ...check.style.map((issue) => issue.message)]
}

export function createWriter(deps: { readonly repo: MarketingRepository; readonly provider: WriterProvider | null; readonly now?: () => string }) {
  const { repo, provider } = deps
  const now = deps.now ?? (() => new Date().toISOString())

  return {
    async generate(raw: GenerateWriterInput): Promise<WriterResult> {
      if (provider === null) {
        return { ok: false, reason: "ai-disabled" }
      }
      const validated = validateWriterInput(raw)
      if (!validated.ok) {
        return { ok: false, reason: validated.reason }
      }
      const input = validated.input
      const reserveUsd = worstCaseWriterCostUsd(provider.model, input.kind)
      if (reserveUsd === null || reserveUsd > MAX_RESERVE_PER_DRAFT_USD) {
        return { ok: false, reason: "ai-cost-too-high" }
      }

      const recent = await repo.listWriterOutputs(RECENT_FOR_TITLES)
      const reserved = await repo.reserveGeneration({
        campaignId: null,
        channelCode: input.channel,
        requestKey: raw.requestKey,
        topicKey: `writer-${input.kind}`,
        model: provider.model,
        reserveUsd,
        caps: GENERATION_CAPS,
        createdBy: raw.actor,
      })
      if (reserved.kind === "duplicate") {
        return { ok: false, reason: "duplicate" }
      }
      if (reserved.kind === "cap") {
        return { ok: false, reason: `cap-${reserved.cap}` }
      }

      let usage: TokenUsage | null = { inputTokens: 0, outputTokens: 0 }
      let callCount = 0
      const settleFailure = async (error: unknown): Promise<WriterResult> => {
        const unknown = error instanceof MarketingAiError && error.code === "timeout"
        const extra = error instanceof MarketingAiError ? (error.code === "http" || error.code === "too-large" ? { inputTokens: 0, outputTokens: 0 } : error.usage) : null
        const partial = addUsage(usage, extra)
        await repo.settleGeneration(reserved.id, {
          status: unknown ? "unknown" : "failed",
          actualUsd: unknown ? null : actualCostUsd(provider.model, partial),
          inputTokens: unknown ? null : (partial?.inputTokens ?? null),
          outputTokens: unknown ? null : (partial?.outputTokens ?? null),
          callCount,
          errorCode: error instanceof MarketingAiError ? `ai-${error.code}` : "ai-error",
        })
        return { ok: false, reason: unknown ? "ai-unknown" : "ai-failed" }
      }

      const request: WriterRequest = {
        mode: input.mode,
        kind: input.kind,
        channel: input.channel,
        region: input.region,
        topic: input.topic,
        must: mustFor(input),
        emphasis: input.emphasis,
        productName: input.productName,
        productSpecs: input.productSpecs,
        avoidTitles: recent
          .filter((row: MarketingWriterOutputRow) => row.output_kind === input.kind && row.mode === input.mode)
          .map((row) => row.title)
          .slice(0, AVOID_TITLES),
      }
      const context = { mode: input.mode, kind: input.kind, region: input.region, productEvidence: productEvidenceOf(input.productName, input.productSpecs) }

      let copy: WriterCopy
      try {
        callCount += 1
        const first = await provider.generate(request)
        usage = addUsage(usage, first.usage)
        copy = first.copy
      } catch (error) {
        return settleFailure(error)
      }

      let check = checkWriterCopy(copy, context)
      let repaired = false
      let repairError: string | null = null
      if (check.blocking.length > 0 || check.style.length > 0) {
        try {
          callCount += 1
          const second = await provider.generate({ ...request, fixIssues: issuesOf(check), previous: copy })
          usage = addUsage(usage, second.usage)
          copy = second.copy
          repaired = true
          check = checkWriterCopy(copy, context)
        } catch (error) {
          // 금지 규칙에 걸린 1차 글은 보정 없이 내보낼 수 없다 — 실패로 닫는다
          if (check.blocking.length > 0) {
            return settleFailure(error)
          }
          // 금지 규칙은 통과하고 문장만 다듬으려던 경우: 이미 비용을 낸 1차 글을 저장한다. 응답을 못 받았으면 사용량을 모른다(null).
          repairError = error instanceof MarketingAiError ? `repair-ai-${error.code}` : "repair-ai-error"
          usage = error instanceof MarketingAiError && error.code !== "timeout" ? addUsage(usage, error.code === "http" || error.code === "too-large" ? { inputTokens: 0, outputTokens: 0 } : error.usage) : null
        }
      }

      const saved = clipToHardLimits(copy)
      const settlement = {
        actualUsd: actualCostUsd(provider.model, usage),
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        callCount,
      }
      let completed: CompleteWriterResult
      try {
        completed = await repo.completeWriterGeneration(
        reserved.id,
        {
          mode: input.mode,
          outputKind: input.kind,
          channelCode: input.channel,
          region: input.region,
          topic: input.topic,
          productName: input.productName,
          productSpecs: input.productSpecs,
          title: saved.title,
          body: saved.body,
          tags: saved.tags,
          caption: saved.caption,
          orderLinks: buildWriterOrderLinks(input, reserved.id, now()),
          qualityStatus: check.status,
          issues: issuesOf(check),
        },
        { ...settlement, errorCode: repairError },
      )
      } catch (error) {
        // 결과 저장이 거부되면(제약 위반 등) 결과와 성공 정산은 함께 롤백된다. 예약을 실패로 닫아 비용이 원장에 남게 한다.
        console.error("[marketing] writer save failed", { message: error instanceof Error ? error.message : String(error) })
        await repo.settleGeneration(reserved.id, { status: "failed", ...settlement, errorCode: "save-error" })
        return { ok: false, reason: "save-failed" }
      }
      if (completed.kind !== "completed") {
        return { ok: false, reason: "save-failed" }
      }
      return { ok: true, outputId: completed.outputId, qualityStatus: check.status, repaired }
    },
  }
}

export type Writer = ReturnType<typeof createWriter>
