import Link from "next/link"

import { BatchProgressRunner } from "@/components/admin/batch-progress"
import { NeedsReviewBulkPanel } from "@/components/admin/needs-review-bulk-panel"
import { type NeedsReviewPreview } from "@/components/admin/needs-review-resolution-form"
import { formatBatchKstTime, latestBatchUpdatedAt, summarizeBatchTotals } from "@/lib/batch/batch-view"
import { BATCH_EVENT_LABELS } from "@/lib/batch/event-log"
import { isResolvableField, RESOLVABLE_FIELD_LABELS, toEditableValues } from "@/lib/batch/needs-review-resolution"
import { formatBatchItemReason, formatQualityIssueCode } from "@/lib/batch/reason-labels"
import type { AiGeneratedSeoContent, GenerationVariationAudit } from "@/lib/ai/types"
import { claimableStatusesFor } from "@/lib/batch/state-machine"
import type { BatchRunSettings } from "@/lib/batch/types"
import type { PublishItemVerification } from "@/lib/batch/publish-batch-service"
import type { BatchRunEventRow, BatchRunItemRow } from "@/types/database"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const ITEM_STATUS_LABELS: Record<BatchRunItemRow["status"], Readonly<{ label: string; className: string }>> = {
  queued: { label: "대기", className: "border-[var(--border-default)] bg-[var(--surface-secondary)] text-[var(--text-secondary)]" },
  processing: { label: "처리 중", className: "border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]" },
  ready: { label: "ready", className: "border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]" },
  warn_ready: { label: "WARN-ready", className: "border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 text-[var(--status-warning)]" },
  needs_review: { label: "사용자 확인 필요", className: "border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 text-[var(--status-warning)]" },
  failed: { label: "실패", className: "border-[var(--status-error)]/40 bg-[var(--status-error)]/10 text-[var(--status-error)]" },
  skipped: { label: "건너뜀", className: "border-[var(--border-default)] bg-[var(--surface-secondary)] text-[var(--text-secondary)]" },
  interrupted: { label: "중단됨(재개 가능)", className: "border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 text-[var(--status-warning)]" },
  published: { label: "게시됨", className: "border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]" },
  publish_failed: { label: "게시 실패", className: "border-[var(--status-error)]/40 bg-[var(--status-error)]/10 text-[var(--status-error)]" },
}

const STEP_LABELS: Record<string, string> = {
  generating: "생성 중",
  checking: "검사 중",
  applying: "적용 중",
  publishing: "게시 중",
  verifying: "확인 중",
}

// 다양화 감사(output.audit)의 FAQ 선택 경로 라벨 — PR-S2. audit 없는 구 generation은 "—"로 표시.
const FAQ_SELECTION_LABELS: Record<GenerationVariationAudit["faq_selection"], string> = {
  hash: "기본 선택",
  fallback: "회피 순환",
  "exhausted-min-overlap": "최소 중복",
}

function variationSummary(audit: GenerationVariationAudit): string {
  const parts = [`제목 ${audit.title_pattern_id}${audit.title_fallback ? " (회피)" : ""}`, `FAQ ${FAQ_SELECTION_LABELS[audit.faq_selection]}`]
  if (audit.keywords_rebuilt) {
    parts.push("키워드 재구성")
  }
  return parts.join(" · ")
}

// 게시 배치 결과의 공개 검증 상태 라벨 — seo_pages.verification_* 실시간 값 기준 (PR #25 연동).
const VERIFICATION_LABELS: Record<string, Readonly<{ label: string; className: string }>> = {
  pending: { label: "확인 중", className: "border-[var(--border-default)] bg-[var(--surface-secondary)] text-[var(--text-secondary)]" },
  verified: { label: "공개 확인됨", className: "border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]" },
  delayed: { label: "확인 지연", className: "border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 text-[var(--status-warning)]" },
  failed: { label: "확인 실패", className: "border-[var(--status-error)]/40 bg-[var(--status-error)]/10 text-[var(--status-error)]" },
}

export default async function BatchDetailPage({
  params,
  searchParams,
}: Readonly<{ params: Promise<{ batchId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const { batchId } = await params
  const query = await searchParams
  const autoStart = query["start"] === "1"

  const { createSupabaseBatchRepository } = await import("@/lib/batch/supabase-batch-repository")
  const repository = createSupabaseBatchRepository()
  const run = await repository.getRun(batchId)
  if (run === null) {
    return (
      <section className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6 text-sm leading-6 text-[var(--text-secondary)]">
        배치를 찾을 수 없습니다.{" "}
        <Link className="font-semibold text-[var(--accent-primary)]" href="/admin/batch/new">
          새 배치 시작
        </Link>
      </section>
    )
  }

  // 장시간 멈춘 processing item은 interrupted로 판정한다 (자동 재개 없음 — '이어서 진행' 대상).
  await repository.markStaleItemsInterrupted(batchId)
  const items = await repository.listItems(batchId)
  const totals = summarizeBatchTotals(items)
  const isPublishRun = run.kind === "publish"
  const settings = run.settings as unknown as BatchRunSettings
  // 게시 배치의 종료 판정: ready는 아직 claim 전 대기 상태다 (생성 배치에서는 종료 상태).
  const nonTerminal = isPublishRun ? ["ready", "warn_ready", "queued", "processing", "interrupted"] : ["queued", "processing", "interrupted"]
  const terminalCount = items.filter((item) => !nonTerminal.includes(item.status)).length
  const claimable = claimableStatusesFor(run.kind)
  const hasClaimable = items.some((item) => claimable.includes(item.status))
  const processingItem = items.find((item) => item.status === "processing") ?? null
  const isRunning = run.status === "running"
  const lastUpdatedLabel = formatBatchKstTime(latestBatchUpdatedAt(run.updated_at, items))
  // 생성 배치 종료 후 게시로 넘길 수 있는 적격 item 수 (ready·warn_ready).
  const publishableCount = items.filter((item) => item.status === "ready" || item.status === "warn_ready").length

  // 게시 배치: 장소별 실시간 공개 검증 상태 (seo_pages.verification_*)
  let verifications: ReadonlyMap<string, PublishItemVerification> = new Map()
  if (isPublishRun) {
    const { listPublishItemVerifications } = await import("@/lib/batch/publish-batch-service")
    verifications = await listPublishItemVerifications(items.map((item) => item.place_id))
  }

  // 생성 배치: generation output.audit 다양화 감사 join 표시 (audit 없는 구 generation은 미표시)
  let variationAudits: ReadonlyMap<string, GenerationVariationAudit> = new Map()
  if (!isPublishRun) {
    const { listGenerationVariationAudits } = await import("@/lib/ai/supabase-repository")
    variationAudits = await listGenerationVariationAudits(items.map((item) => item.retry_generation_id ?? item.generation_id ?? ""))
  }

  // 이벤트 타임라인 (PR-S4) — 최근 100개. 도입 이전 배치는 이벤트가 없다 (역보정 없음).
  const events = await repository.listEvents(batchId, 100)
  const itemNames = new Map(items.map((item) => [item.id, snapshotName(item)]))

  // needs_review 검토·보정 패널 — 생성 배치에서만, preview generation이 남아 있는 item만 대상이다.
  const reviewNotice = reviewNoticeMessage(typeof query["review"] === "string" ? query["review"] : undefined)
  const needsReviewPreviews = isPublishRun ? [] : await loadNeedsReviewPreviews(batchId, items)

  return (
    <section aria-labelledby="batch-detail-title" className="flex flex-col gap-6">
      <header className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">운영 · Batch</p>
        <div className="mt-2 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]" id="batch-detail-title">
              {isPublishRun ? "일괄 게시 진행" : "AI 일괄 생성 진행"}
            </h2>
            <p className="mt-2 font-mono text-xs text-[var(--text-secondary)]">batch {run.id}</p>
            <p className="mt-2 text-sm">
              <Link className="font-semibold text-[var(--accent-primary)]" href="/admin/batch">
                ← Batch 이력
              </Link>
            </p>
          </div>
          <p className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2 text-sm font-semibold text-[var(--text-primary)]">
            {isRunning ? <span aria-hidden className="inline-block size-2.5 animate-pulse rounded-full bg-[var(--accent-primary)]" /> : null}
            {run.status === "running" ? "진행 중" : run.status === "completed" ? "완료" : run.status === "cancelled" ? "중단됨" : "실패"} · {terminalCount}/{items.length}
          </p>
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-[var(--surface-elevated)]">
          <div
            className={`h-full rounded-full bg-[var(--accent-primary)] transition-all ${isRunning ? "animate-pulse" : ""}`}
            style={{ width: `${String(items.length === 0 ? 0 : Math.round((terminalCount / items.length) * 100))}%` }}
          />
        </div>
        <div aria-live="polite" role="status">
          {processingItem !== null ? (
            <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
              현재 처리: <span className="font-semibold text-[var(--text-primary)]">{snapshotName(processingItem)}</span>
              {processingItem.current_step !== null ? ` — ${STEP_LABELS[processingItem.current_step] ?? processingItem.current_step}` : ""}
            </p>
          ) : null}
        </div>
        {lastUpdatedLabel !== null ? <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">마지막 상태 갱신 {lastUpdatedLabel} (KST)</p> : null}
        <div className="mt-4">
          <BatchProgressRunner autoStart={autoStart} batchId={run.id} hasClaimable={hasClaimable} kind={run.kind} runStatus={run.status} />
        </div>
      </header>

      {/* 생성 배치가 끝나면 적격(ready·WARN-ready)만 자동 선택된 게시 화면으로 바로 넘어간다 — 부적격은 게시 화면에서 사유와 함께 제외 표시된다. */}
      {!isPublishRun && !isRunning && publishableCount > 0 ? (
        <section aria-label="게시 연결" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 p-4">
          <p className="text-sm font-semibold leading-6 text-[var(--accent-primary)]">
            게시 가능한 적격 장소 {publishableCount}곳이 준비되었습니다. 부적격(품질 검토·실패)은 자동으로 제외됩니다.
          </p>
          <Link
            className="inline-flex items-center justify-center rounded-full bg-[var(--accent-primary)] px-5 py-2 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90"
            href={`/admin/batch/publish/new?fromBatch=${run.id}`}
          >
            적격 {publishableCount}곳 일괄 게시 →
          </Link>
        </section>
      ) : null}

      {isPublishRun ? (
        <section aria-label="집계" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryTile label="게시됨" value={totals.published} hint={null} />
          <SummaryTile label="게시 실패" value={totals.publish_failed} hint={null} />
          <SummaryTile label="건너뜀" value={totals.skipped} hint={null} />
          <SummaryTile
            label="공개 확인됨"
            value={items.filter((item) => verifications.get(item.place_id)?.verificationStatus === "verified").length}
            hint="공개 URL 확인은 게시 후 비동기로 진행됩니다"
          />
        </section>
      ) : (
        <section aria-label="집계" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryTile label="ready" value={totals.ready + totals.warn_ready} hint={totals.warn_ready > 0 ? `WARN-ready ${String(totals.warn_ready)} 포함` : null} />
          <SummaryTile label="사용자 확인 필요" value={totals.needs_review} hint={null} />
          <SummaryTile label="실패 / 건너뜀" value={totals.failed + totals.skipped} hint={null} />
          <SummaryTile
            label="실제 비용 (토큰)"
            value={`$${totals.actual_cost_usd.toFixed(4)}`}
            hint={`${(totals.tokens_input + totals.tokens_output).toLocaleString("ko-KR")} tk · 예상 $${settings.estimated_cost_usd.toFixed(4)}`}
          />
        </section>
      )}

      <section aria-label="장소별 결과" className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left text-sm">
            <thead className="bg-[var(--surface-secondary)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
              <tr>
                <th className="px-5 py-3" scope="col">#</th>
                <th className="px-5 py-3" scope="col">장소</th>
                <th className="px-5 py-3" scope="col">상태</th>
                {isPublishRun ? (
                  <th className="px-5 py-3" scope="col">공개 검증</th>
                ) : (
                  <>
                    <th className="px-5 py-3" scope="col">품질</th>
                    <th className="px-5 py-3" scope="col">다양화</th>
                    <th className="px-5 py-3" scope="col">토큰 · 비용</th>
                  </>
                )}
                <th className="px-5 py-3" scope="col">사유</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-default)]">
              {items.map((item) => {
                // 게시 배치에서 ready는 아직 게시 전 대기 상태다 — 생성 배치의 종료 상태(ready)와 라벨을 구분한다.
                const tone = isPublishRun && item.status === "ready" ? { label: "게시 대기", className: ITEM_STATUS_LABELS.queued.className } : ITEM_STATUS_LABELS[item.status]
                const verification = verifications.get(item.place_id) ?? null
                const verificationTone = verification?.verificationStatus != null ? VERIFICATION_LABELS[verification.verificationStatus] ?? null : null
                return (
                  <tr key={item.id}>
                    <td className="px-5 py-3 font-mono text-xs">{item.sequence}</td>
                    <td className="px-5 py-3 font-semibold text-[var(--text-primary)]">{snapshotName(item)}</td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tone.className}`}>{tone.label}</span>
                    </td>
                    {isPublishRun ? (
                      <td className="px-5 py-3 text-xs">
                        {verificationTone !== null ? (
                          <span className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${verificationTone.className}`}>
                            {verificationTone.label}
                            {verification?.lastHttpStatus != null ? ` · HTTP ${String(verification.lastHttpStatus)}` : ""}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    ) : (
                      <>
                        <td className="px-5 py-3 text-xs">{item.quality_status ?? "—"}</td>
                        <td className="max-w-[220px] px-5 py-3 text-xs text-[var(--text-secondary)]">
                          {(() => {
                            const audit = variationAudits.get(item.retry_generation_id ?? item.generation_id ?? "")
                            return audit === undefined ? "—" : variationSummary(audit)
                          })()}
                        </td>
                        <td className="px-5 py-3 text-xs">
                          {item.tokens_input !== null || item.tokens_output !== null
                            ? `${((item.tokens_input ?? 0) + (item.tokens_output ?? 0)).toLocaleString("ko-KR")} tk · $${(item.cost_usd ?? 0).toFixed(4)}`
                            : "—"}
                        </td>
                      </>
                    )}
                    <td className="max-w-[260px] px-5 py-3 text-xs text-[var(--text-secondary)]">{formatBatchItemReason(item.skip_reason ?? item.last_error_code) ?? "—"}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {reviewNotice !== null ? (
        <p className="rounded-3xl border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 p-4 text-sm leading-6 text-[var(--text-primary)]">{reviewNotice}</p>
      ) : null}

      {needsReviewPreviews.length > 0 ? <NeedsReviewBulkPanel previews={needsReviewPreviews} /> : null}

      <BatchEventTimeline events={events} itemNames={itemNames} />
    </section>
  )
}

const REVIEW_NOTICES: Readonly<Record<string, string>> = {
  resolved: "검토 결과를 반영했습니다. 게시 준비(ready) 상태가 되었으며 아직 게시되지 않았습니다.",
  "not-confirmed": "확인란에 동의해야 게시 준비로 진행할 수 있습니다.",
  "item-not-needs-review": "이미 처리된 항목이라 변경하지 않았습니다.",
  "generation-mismatch": "대상 콘텐츠와 장소가 일치하지 않아 중단했습니다.",
  "generation-not-resolvable": "이 콘텐츠는 검토 해소 대상이 아닙니다.",
  "place-not-draft": "이미 공개 중이거나 준비 상태가 아닌 장소라 중단했습니다.",
  "already-published": "이미 공개된 장소라 중단했습니다.",
  "quality-warn": "재평가에 주의 항목이 남아 있어 확인 대기 상태를 유지했습니다.",
  "quality-fail": "재평가가 실패해 확인 대기 상태를 유지했습니다.",
  "quality-unknown": "품질 재평가 결과를 계산하지 못해 확인 대기 상태를 유지했습니다.",
  "review-quality-not-pass": "재평가가 통과하지 못해 확인 대기 상태를 유지했습니다.",
  "review-seo-page-blocked": "게시 준비 단계가 차단되어 확인 대기 상태를 유지했습니다.",
  "review-unexpected": "처리 중 오류가 발생해 확인 대기 상태를 유지했습니다.",
}

function reviewNoticeMessage(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null
  }
  if (raw.startsWith("invalid-")) {
    const field = raw.slice("invalid-".length)
    const label = isResolvableField(field) ? RESOLVABLE_FIELD_LABELS[field] : "입력값"
    return `${label} 형식이 올바르지 않아 변경하지 않았습니다. 안내된 입력 형식을 확인하세요.`
  }
  return REVIEW_NOTICES[raw] ?? "요청을 처리하지 못했습니다. 상세 원인은 감사 로그에서 확인하세요."
}

// 검토 대상 로딩 — preview 상태의 generation이 있는 needs_review item만 폼을 연다.
// 이미 적용됐거나(applied) 사라진 generation은 정식 경로로 해소할 수 없으므로 폼을 만들지 않는다.
async function loadNeedsReviewPreviews(batchId: string, items: readonly BatchRunItemRow[]): Promise<readonly NeedsReviewPreview[]> {
  const targets = items.filter((item) => item.status === "needs_review")
  if (targets.length === 0) {
    return []
  }
  const { createSupabaseAiRepository } = await import("@/lib/ai/supabase-repository")
  const repository = createSupabaseAiRepository()
  const previews: NeedsReviewPreview[] = []
  for (const item of targets) {
    const generationId = item.retry_generation_id ?? item.generation_id
    if (generationId === null) {
      continue
    }
    const generation = await repository.findAiGenerationById(generationId)
    const content = (generation?.output as AiGeneratedSeoContent | null) ?? null
    if (generation?.status !== "preview" || content === null) {
      continue
    }
    previews.push({
      itemId: item.id,
      batchId,
      generationId,
      placeName: snapshotName(item),
      reasonLabel: formatBatchItemReason(item.last_error_code) ?? "자동 진행 조건을 충족하지 않아 확인이 필요합니다.",
      qualityIssueLabels: qualityIssueLabelsOf(item.quality_issues),
      values: toEditableValues(content),
    })
  }
  return previews
}

function qualityIssueLabelsOf(issues: BatchRunItemRow["quality_issues"]): readonly string[] {
  if (!Array.isArray(issues)) {
    return []
  }
  return issues
    .map((issue) => (typeof issue === "object" && issue !== null && !Array.isArray(issue) ? (issue as Record<string, unknown>)["code"] : null))
    .filter((code): code is string => typeof code === "string")
    .map((code) => formatQualityIssueCode(code))
}

function snapshotName(item: BatchRunItemRow): string {
  const snapshot = item.input_snapshot
  if (typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot)) {
    const name = (snapshot as Record<string, unknown>)["name"]
    if (typeof name === "string" && name.length > 0) {
      return name
    }
  }
  return item.place_id.slice(0, 8)
}

// 이벤트 타임라인 (PR-S4) — 내부 코드는 노출하지 않고 한글 라벨·사유 formatter로만 표시한다.
function BatchEventTimeline({ events, itemNames }: Readonly<{ events: readonly BatchRunEventRow[]; itemNames: ReadonlyMap<string, string> }>) {
  return (
    <section aria-label="이벤트 타임라인" className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
      <div className="border-b border-[var(--border-default)] p-5">
        <h3 className="text-lg font-semibold text-[var(--text-primary)]">이벤트 타임라인</h3>
        <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">최근 {events.length > 0 ? Math.min(events.length, 100) : 0}개 · 상태 전이·재개·취소·공개 검증 갱신 기록 (KST)</p>
      </div>
      {events.length === 0 ? (
        <p className="p-6 text-sm leading-6 text-[var(--text-secondary)]">이 Batch는 이벤트 기록 기능 도입 이전에 실행되었습니다.</p>
      ) : (
        <ul className="divide-y divide-[var(--border-default)]">
          {events.map((event) => {
            const detail = typeof event.detail === "object" && event.detail !== null && !Array.isArray(event.detail) ? (event.detail as Record<string, unknown>) : {}
            const reason = formatBatchItemReason(typeof detail["error_code"] === "string" ? detail["error_code"] : typeof detail["skip_reason"] === "string" ? detail["skip_reason"] : null)
            const transition = event.from_status !== null || event.to_status !== null ? `${statusLabelOf(event.from_status)} → ${statusLabelOf(event.to_status)}` : null
            return (
              <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3 text-sm leading-6" key={event.id}>
                <span className="font-mono text-xs text-[var(--text-secondary)]">{formatBatchKstTime(event.created_at) ?? "—"}</span>
                <span className="font-semibold text-[var(--text-primary)]">{BATCH_EVENT_LABELS[event.event_type]}</span>
                {event.item_id !== null ? <span className="text-[var(--text-secondary)]">{itemNames.get(event.item_id) ?? "—"}</span> : null}
                {transition !== null ? <span className="text-xs text-[var(--text-secondary)]">{transition}</span> : null}
                {event.step !== null ? <span className="text-xs text-[var(--text-secondary)]">단계 {STEP_LABELS[event.step] ?? event.step}</span> : null}
                {typeof detail["trigger"] === "string" && detail["trigger"] === "resume" ? (
                  <span className="rounded-full border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 px-2 py-0.5 text-xs font-semibold text-[var(--status-warning)]">이어서 진행</span>
                ) : null}
                {event.actor !== null ? <span className="text-xs text-[var(--text-secondary)]">{event.actor}</span> : null}
                {typeof detail["verification_status"] === "string" ? (
                  <span className="text-xs text-[var(--text-secondary)]">검증 {VERIFICATION_LABELS[detail["verification_status"]]?.label ?? "—"}</span>
                ) : null}
                {reason !== null ? <span className="text-xs text-[var(--text-secondary)]">{reason}</span> : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

const ITEM_STATUS_TEXT: Record<string, string> = {
  queued: "대기",
  processing: "처리 중",
  ready: "ready",
  warn_ready: "WARN-ready",
  needs_review: "확인 필요",
  failed: "실패",
  skipped: "건너뜀",
  interrupted: "중단됨",
  published: "게시됨",
  publish_failed: "게시 실패",
  running: "진행 중",
  completed: "완료",
  cancelled: "중단됨",
  pending: "확인 중",
  verified: "공개 확인됨",
  delayed: "확인 지연",
}

function statusLabelOf(status: string | null): string {
  return status === null ? "—" : ITEM_STATUS_TEXT[status] ?? "—"
}

function SummaryTile({ label, value, hint }: Readonly<{ label: string; value: string | number; hint: string | null }>) {
  return (
    <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">{label}</p>
      <p className="mt-2 text-xl font-semibold text-[var(--text-primary)]">{value}</p>
      {hint !== null ? <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">{hint}</p> : null}
    </div>
  )
}
