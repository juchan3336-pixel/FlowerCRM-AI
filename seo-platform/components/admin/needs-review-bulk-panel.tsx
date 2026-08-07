"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

import { resolveNeedsReviewBulkStepAction } from "@/app/admin/batch/actions"
import { NeedsReviewResolutionForm, type NeedsReviewPreview } from "@/components/admin/needs-review-resolution-form"

// 일괄 결과에서 사용자에게 보여줄 유지 사유 라벨 — 코드 원문은 노출하지 않는다.
const KEPT_REASON_LABELS: Readonly<Record<string, string>> = {
  "quality-fail": "재평가 FAIL — 보정 없이는 통과할 수 없습니다",
  "quality-unknown": "품질 재평가를 계산하지 못했습니다",
  "item-not-needs-review": "이미 처리된 항목입니다",
  "review-quality-not-pass": "재평가 FAIL — 보정 없이는 통과할 수 없습니다",
  "review-seo-page-blocked": "게시 준비 단계가 차단되었습니다",
  "review-unexpected": "처리 중 오류가 발생했습니다",
}

type BulkOutcome = {
  readonly ready: number
  readonly warnReady: number
  readonly kept: readonly { readonly placeName: string; readonly reasonLabel: string }[]
}

// needs_review 일괄 검토 패널 — 항목별 확인 체크만 모아 최하단 버튼 한 번으로 순차 해소한다.
// 서버 호출은 1건씩(BatchProgressRunner와 같은 패턴)이라 항목 수가 많아도 서버 타임아웃에 걸리지 않는다.
export function NeedsReviewBulkPanel({ previews }: Readonly<{ previews: readonly NeedsReviewPreview[] }>) {
  const router = useRouter()
  const [checkedIds, setCheckedIds] = useState<readonly string[]>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null)

  const setChecked = (itemId: string, checked: boolean) => {
    setCheckedIds((current) => (checked ? [...current, itemId] : current.filter((id) => id !== itemId)))
  }
  const allChecked = previews.length > 0 && previews.every((preview) => checkedIds.includes(preview.itemId))
  const selected = previews.filter((preview) => checkedIds.includes(preview.itemId))

  const runBulk = async () => {
    if (running || selected.length === 0) {
      return
    }
    setRunning(true)
    setOutcome(null)
    const result: { ready: number; warnReady: number; kept: { placeName: string; reasonLabel: string }[] } = { ready: 0, warnReady: 0, kept: [] }
    try {
      let done = 0
      setProgress({ done, total: selected.length })
      for (const preview of selected) {
        // 완료 응답을 받은 뒤 다음 호출 — 순차성 보장. 실패해도 나머지 항목은 계속 처리한다.
        const step = await resolveNeedsReviewBulkStepAction(preview.itemId, preview.generationId)
        if (step.kind === "resolved") {
          if (step.itemStatus === "warn_ready") {
            result.warnReady += 1
          } else {
            result.ready += 1
          }
        } else {
          result.kept.push({ placeName: preview.placeName, reasonLabel: KEPT_REASON_LABELS[step.reason] ?? "처리하지 못했습니다" })
        }
        done += 1
        setProgress({ done, total: selected.length })
        router.refresh()
      }
    } finally {
      setOutcome(result)
      setProgress(null)
      setRunning(false)
      setCheckedIds([])
      router.refresh()
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {previews.map((preview) => (
        <section
          aria-label={`${preview.placeName} 검토`}
          className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]"
          id={`item-${preview.itemId}`}
          key={preview.itemId}
        >
          <div className="p-5">
            <h3 className="text-lg font-semibold text-[var(--text-primary)]">사용자 확인 필요 — 검토·보정</h3>
            <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
              Preview 원문을 확인하고 필요한 필드만 보정한 뒤 게시 준비(ready)로 올립니다. 게시는 별도 단계이며 여기서는 실행되지 않습니다.
            </p>
          </div>
          <NeedsReviewResolutionForm
            busy={running}
            confirmed={checkedIds.includes(preview.itemId)}
            onConfirmedChange={(confirmed) => {
              setChecked(preview.itemId, confirmed)
            }}
            preview={preview}
          />
        </section>
      ))}

      <section aria-label="일괄 검토 완료" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <h3 className="text-lg font-semibold text-[var(--text-primary)]">일괄 검토 완료</h3>
        <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
          확인란을 체크한 항목을 원문 그대로 승인해 게시 준비(ready)로 올립니다. 필드를 보정하려면 항목 안의 개별 버튼을 사용하세요. 품질 FAIL 항목은 보정 없이는
          통과되지 않습니다. 게시는 별도 단계입니다.
        </p>

        <label className="mt-4 flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
          <input
            checked={allChecked}
            disabled={running || previews.length === 0}
            onChange={(event) => {
              setCheckedIds(event.target.checked ? previews.map((preview) => preview.itemId) : [])
            }}
            type="checkbox"
          />
          전체 선택 ({previews.length}건)
        </label>

        <div aria-live="polite" role="status">
          {progress !== null ? (
            <p className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
              <span aria-hidden className="inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              일괄 처리 중… {progress.done}/{progress.total} (항목별 결과가 나올 때마다 목록이 갱신됩니다)
            </p>
          ) : null}
          {outcome !== null ? (
            <div className="mt-3 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-sm leading-6 text-[var(--text-primary)]">
              <p className="font-semibold">
                게시 준비 완료 {outcome.ready + outcome.warnReady}건
                {outcome.warnReady > 0 ? ` (WARN-ready ${String(outcome.warnReady)}건 포함)` : ""}
                {outcome.kept.length > 0 ? ` · 확인 대기 유지 ${String(outcome.kept.length)}건` : ""}
              </p>
              {outcome.kept.length > 0 ? (
                <ul className="mt-2 list-disc pl-5 text-xs leading-5 text-[var(--text-secondary)]">
                  {outcome.kept.map((entry) => (
                    <li key={entry.placeName}>
                      {entry.placeName} — {entry.reasonLabel}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>

        <button
          className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full bg-[var(--accent-primary)] px-4 py-3 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={running || selected.length === 0}
          onClick={() => {
            void runBulk()
          }}
          type="button"
        >
          {running ? "일괄 처리 중…" : `${String(selected.length)}건 검토 완료 및 게시 준비`}
        </button>
      </section>
    </div>
  )
}
