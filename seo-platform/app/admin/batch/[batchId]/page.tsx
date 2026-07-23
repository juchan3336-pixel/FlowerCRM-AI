import Link from "next/link"

import { BatchProgressRunner } from "@/components/admin/batch-progress"
import { formatBatchKstTime, latestBatchUpdatedAt, summarizeBatchTotals } from "@/lib/batch/batch-view"
import { formatBatchItemReason } from "@/lib/batch/reason-labels"
import { claimableStatusesFor } from "@/lib/batch/state-machine"
import type { BatchRunSettings } from "@/lib/batch/types"
import type { PublishItemVerification } from "@/lib/batch/publish-batch-service"
import type { BatchRunItemRow } from "@/types/database"

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

  // 게시 배치: 장소별 실시간 공개 검증 상태 (seo_pages.verification_*)
  let verifications: ReadonlyMap<string, PublishItemVerification> = new Map()
  if (isPublishRun) {
    const { listPublishItemVerifications } = await import("@/lib/batch/publish-batch-service")
    verifications = await listPublishItemVerifications(items.map((item) => item.place_id))
  }

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
    </section>
  )
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

function SummaryTile({ label, value, hint }: Readonly<{ label: string; value: string | number; hint: string | null }>) {
  return (
    <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">{label}</p>
      <p className="mt-2 text-xl font-semibold text-[var(--text-primary)]">{value}</p>
      {hint !== null ? <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">{hint}</p> : null}
    </div>
  )
}
