"use client"

import { useMemo, useRef, useState, useTransition } from "react"

import { startBatchPublishAction } from "@/app/admin/batch/actions"
import type { ContentMode } from "@/lib/ai/content-mode"
import { BatchFailureToast, createSubmitGate } from "@/components/admin/batch-launch-form"
import { CONTENT_MODE_LABELS } from "@/lib/batch/candidate-policy"
import { PUBLISH_INELIGIBLE_LABELS, type PublishIneligibleReason } from "@/lib/batch/publish-candidate-policy"
import { BATCH_MAX_ITEMS } from "@/lib/batch/types"

export type BatchPublishCandidateItem = {
  readonly placeId: string
  readonly name: string
  readonly region: string
  readonly path: string
  // 업종 원문과 중앙 resolver 판정 모드 — 카테고리 필터·빠른 선택용 (승인 화면과 동일 기준).
  readonly category: string | null
  readonly contentMode: ContentMode | null
  readonly eligible: boolean
  readonly reason: PublishIneligibleReason | null
}

// 게시 화면의 카테고리(모드) 필터 — 승인 화면과 같은 모드 축으로 거른다. 표시만 거르고 선택은 유지된다.
export type PublishCandidateFilter = "all" | ContentMode

export const PUBLISH_FILTER_LABELS: Readonly<Record<PublishCandidateFilter, string>> = {
  all: "전체",
  condolence: CONTENT_MODE_LABELS.condolence,
  celebration: CONTENT_MODE_LABELS.celebration,
  "corporate-celebration": CONTENT_MODE_LABELS["corporate-celebration"],
}

export function filterPublishCandidates(candidates: readonly BatchPublishCandidateItem[], filter: PublishCandidateFilter): readonly BatchPublishCandidateItem[] {
  return filter === "all" ? candidates : candidates.filter((candidate) => candidate.contentMode === filter)
}

// 카테고리(모드) 필터 + 지정 수량으로 게시 가능 후보 상위 N개를 뽑는다 — 기존 선택을 대체한다.
export function quickSelectPublishCandidates(candidates: readonly BatchPublishCandidateItem[], filter: PublishCandidateFilter, count: number): readonly string[] {
  const capped = Math.max(0, Math.min(Math.floor(count), BATCH_MAX_ITEMS))
  return filterPublishCandidates(candidates, filter)
    .filter((candidate) => candidate.eligible)
    .slice(0, capped)
    .map((candidate) => candidate.placeId)
}

type BatchPublishFormProps = {
  readonly candidates: readonly BatchPublishCandidateItem[]
  readonly envBlocked: boolean
}

export const PUBLISH_SUBMIT_FAILED_MESSAGE = "일괄 게시 요청을 보내지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요."

export function BatchPublishForm({ candidates, envBlocked }: BatchPublishFormProps) {
  const [isPending, startTransition] = useTransition()
  const [submitError, setSubmitError] = useState<string | null>(null)
  const gateRef = useRef(createSubmitGate())

  // 성공·검증 실패 모두 redirect로 끝난다 — catch는 전송 실패 전용 (batch-launch-form과 동일 계약).
  const submit = (formData: FormData) => {
    if (!gateRef.current.tryAcquire()) {
      return
    }
    setSubmitError(null)
    startTransition(async () => {
      try {
        await startBatchPublishAction(formData)
      } catch {
        setSubmitError(PUBLISH_SUBMIT_FAILED_MESSAGE)
      } finally {
        gateRef.current.release()
      }
    })
  }

  return (
    <>
      <BatchPublishFormView action={submit} candidates={candidates} envBlocked={envBlocked} isPending={isPending} />
      {submitError !== null ? (
        <BatchFailureToast
          message={submitError}
          onDismiss={() => {
            setSubmitError(null)
          }}
        />
      ) : null}
    </>
  )
}

// 프레젠테이션 분리 — pending/승인 상태 렌더링을 테스트에서 직접 검증할 수 있게 한다.
export function BatchPublishFormView({
  action,
  candidates,
  envBlocked,
  isPending,
  initialSelected = [],
}: Readonly<{
  action?: (formData: FormData) => void
  candidates: readonly BatchPublishCandidateItem[]
  envBlocked: boolean
  isPending: boolean
  initialSelected?: readonly string[]
}>) {
  const [selected, setSelected] = useState<readonly string[]>(initialSelected)
  const [filter, setFilter] = useState<PublishCandidateFilter>("all")
  const [quickCount, setQuickCount] = useState(BATCH_MAX_ITEMS)
  const visible = useMemo(() => filterPublishCandidates(candidates, filter), [candidates, filter])
  const visibleEligible = useMemo(() => visible.filter((candidate) => candidate.eligible), [visible])

  const toggle = (placeId: string) => {
    setSelected((current) => {
      if (current.includes(placeId)) {
        return current.filter((id) => id !== placeId)
      }
      if (current.length >= BATCH_MAX_ITEMS) {
        return current
      }
      return [...current, placeId]
    })
  }

  return (
    <form action={action} aria-busy={isPending} className="flex flex-col gap-5">
      <nav aria-label="게시 후보 필터" className="flex flex-wrap gap-2">
        {(Object.keys(PUBLISH_FILTER_LABELS) as readonly PublishCandidateFilter[]).map((key) => (
          <button
            aria-pressed={filter === key}
            className={`rounded-full border px-4 py-1.5 text-xs font-semibold transition-colors duration-150 ${
              filter === key
                ? "border-[var(--accent-primary)] bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]"
                : "border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-secondary)] hover:border-[var(--accent-primary)]"
            }`}
            key={key}
            onClick={() => {
              setFilter(key)
            }}
            type="button"
          >
            {PUBLISH_FILTER_LABELS[key]}
          </button>
        ))}
      </nav>

      {/* 빠른 선택 — 현재 필터(카테고리)의 게시 가능 후보를 지정 수량만큼 자동 선택한다. 기존 선택은 대체된다. */}
      <div aria-label="빠른 선택" className="flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3" role="group">
        <label className="text-xs font-semibold text-[var(--text-secondary)]" htmlFor="publish-quick-count">
          선택 수량
        </label>
        <input
          className="w-16 rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-2 py-1 text-sm tabular-nums text-[var(--text-primary)]"
          disabled={isPending || envBlocked}
          id="publish-quick-count"
          max={BATCH_MAX_ITEMS}
          min={1}
          onChange={(event) => {
            const parsed = Number.parseInt(event.target.value, 10)
            setQuickCount(Number.isNaN(parsed) ? 1 : Math.max(1, Math.min(parsed, BATCH_MAX_ITEMS)))
          }}
          type="number"
          value={quickCount}
        />
        <button
          className="rounded-full border border-[var(--accent-primary)] bg-[var(--accent-primary)]/10 px-4 py-1.5 text-xs font-semibold text-[var(--accent-primary)] transition-colors duration-150 hover:bg-[var(--accent-primary)]/20 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isPending || envBlocked || visibleEligible.length === 0}
          onClick={() => {
            setSelected(quickSelectPublishCandidates(candidates, filter, quickCount))
          }}
          type="button"
        >
          현재 필터 상위 {quickCount}곳 자동 선택
        </button>
        <button
          className="rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-1.5 text-xs font-semibold text-[var(--text-secondary)] transition-colors duration-150 hover:border-[var(--accent-primary)] disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isPending || selected.length === 0}
          onClick={() => {
            setSelected([])
          }}
          type="button"
        >
          선택 해제
        </button>
        <p className="text-xs leading-5 text-[var(--text-secondary)]">카테고리를 지정하려면 위 필터를 먼저 고르세요. 자동 선택은 기존 선택을 대체합니다.</p>
      </div>

      <section aria-label="게시 대상 선택" className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <div className="flex items-center justify-between border-b border-[var(--border-default)] p-5">
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">게시 준비 완료 장소</h3>
          <p className="text-sm font-semibold text-[var(--text-primary)]">
            선택 {selected.length} / {BATCH_MAX_ITEMS}
          </p>
        </div>
        {visible.length === 0 ? (
          <p className="p-6 text-sm leading-6 text-[var(--text-secondary)]">
            {candidates.length === 0
              ? "게시할 수 있는 장소가 없습니다. Batch 게시 대상은 seo_pages.status=ready인 draft 장소만 허용됩니다 — 먼저 AI 일괄 생성으로 ready 상태를 만드세요."
              : "현재 필터에 해당하는 장소가 없습니다. 다른 카테고리 필터를 선택하세요."}
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border-default)]">
            {visible.map((candidate) => (
              <li className="flex items-start gap-3 px-5 py-4" key={candidate.placeId}>
                <input
                  aria-label={`${candidate.name} 게시 선택`}
                  checked={selected.includes(candidate.placeId)}
                  className="mt-1 size-4 accent-[var(--accent-primary)]"
                  disabled={isPending || !candidate.eligible || envBlocked || (!selected.includes(candidate.placeId) && selected.length >= BATCH_MAX_ITEMS)}
                  name="placeIds"
                  onChange={() => {
                    toggle(candidate.placeId)
                  }}
                  type="checkbox"
                  value={candidate.placeId}
                />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-[var(--text-primary)]">{candidate.name}</p>
                  <p className="mt-0.5 break-all font-mono text-xs leading-5 text-[var(--text-secondary)]">
                    {candidate.region} · {candidate.path}
                  </p>
                  <p className="mt-0.5 text-xs leading-5 text-[var(--text-secondary)]">
                    {candidate.category ?? "-"} · {candidate.contentMode === null ? "모드 판정 불가" : CONTENT_MODE_LABELS[candidate.contentMode]}
                  </p>
                </div>
                {candidate.eligible ? (
                  <span className="whitespace-nowrap rounded-full border border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 px-2.5 py-0.5 text-xs font-semibold text-[var(--accent-primary)]">
                    게시 가능
                  </span>
                ) : (
                  <span className="whitespace-nowrap rounded-full border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 px-2.5 py-0.5 text-xs font-semibold text-[var(--status-warning)]">
                    게시 불가 — {candidate.reason === null ? "사유 미상" : PUBLISH_INELIGIBLE_LABELS[candidate.reason]}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="게시 승인" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 text-sm leading-6">
        <h3 className="text-lg font-semibold text-[var(--text-primary)]">게시 승인 (1회)</h3>
        <p className="mt-2 text-[var(--text-secondary)]">
          승인 시점의 generation·SEO 페이지·콘텐츠 해시가 장소별 스냅샷으로 고정됩니다. 승인 이후 콘텐츠가 바뀐 장소는 게시되지 않고 해당 장소만 실패로 남습니다. 게시 후 자동 재게시·취소·보관·복원은 하지 않습니다.
        </p>
        <label className="mt-4 flex items-start gap-2 text-sm leading-6 text-[var(--text-primary)]">
          <input className="mt-1 size-4 accent-[var(--accent-primary)]" disabled={isPending} name="publishApproved" type="checkbox" />
          선택한 장소의 콘텐츠를 검토했으며 운영 게시를 승인합니다.
        </label>
      </section>

      <div aria-live="polite" role="status">
        {isPending ? <p className="text-sm leading-6 text-[var(--text-secondary)]">게시 배치를 생성하고 있습니다. 잠시만 기다려 주세요 — 완료되면 진행 화면으로 이동합니다.</p> : null}
      </div>

      <button
        className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[var(--accent-primary)] px-4 py-3 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:px-8"
        disabled={isPending || selected.length === 0 || envBlocked}
        type="submit"
      >
        {isPending ? (
          <>
            <span aria-hidden className="inline-block size-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            배치 준비 중...
          </>
        ) : (
          `일괄 게시 시작 (${String(selected.length)}건)`
        )}
      </button>
    </form>
  )
}
