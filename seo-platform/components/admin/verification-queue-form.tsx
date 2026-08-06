"use client"

import { useMemo, useRef, useState, useTransition } from "react"

import { markPlacesVerifiedAction } from "@/app/admin/verify/actions"
import type { ContentMode } from "@/lib/ai/content-mode"
import { CONTENT_MODE_LABELS } from "@/lib/batch/candidate-policy"
import { createSubmitGate } from "./batch-launch-form"

export type VerificationQueueItem = {
  readonly placeId: string
  readonly name: string
  readonly region: string
  readonly address: string | null
  readonly phone: string | null
  readonly homepage: string
  readonly category: string | null
  readonly contentMode: ContentMode
}

export const VERIFY_FORM_MAX_ITEMS = 10

// 카테고리(모드) 필터 — 승인·게시 화면과 같은 축. 표시만 거르고 선택은 유지된다.
export type VerificationQueueFilter = "all" | ContentMode

export const VERIFY_FILTER_LABELS: Readonly<Record<VerificationQueueFilter, string>> = {
  all: "전체",
  condolence: CONTENT_MODE_LABELS.condolence,
  celebration: CONTENT_MODE_LABELS.celebration,
  "corporate-celebration": CONTENT_MODE_LABELS["corporate-celebration"],
}

export function filterVerificationCandidates(candidates: readonly VerificationQueueItem[], filter: VerificationQueueFilter): readonly VerificationQueueItem[] {
  return filter === "all" ? candidates : candidates.filter((candidate) => candidate.contentMode === filter)
}

// 카테고리 지정 + 수량 지정 자동 선택 — 기존 선택을 대체한다. 상한(10곳)을 넘는 수량은 자른다.
export function quickSelectVerificationCandidates(candidates: readonly VerificationQueueItem[], filter: VerificationQueueFilter, count: number): readonly string[] {
  const capped = Math.max(0, Math.min(Math.floor(count), VERIFY_FORM_MAX_ITEMS))
  return filterVerificationCandidates(candidates, filter)
    .slice(0, capped)
    .map((candidate) => candidate.placeId)
}

export const VERIFY_SUBMIT_FAILED_MESSAGE = "검증 반영 요청을 보내지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요."

export function VerificationQueueForm({ candidates }: Readonly<{ candidates: readonly VerificationQueueItem[] }>) {
  const [isPending, startTransition] = useTransition()
  const [submitError, setSubmitError] = useState<string | null>(null)
  const gateRef = useRef(createSubmitGate())

  // 성공·검증 실패 모두 redirect로 끝난다 — catch는 전송 실패 전용 (승인 화면과 동일 계약).
  const submit = (formData: FormData) => {
    if (!gateRef.current.tryAcquire()) {
      return
    }
    setSubmitError(null)
    startTransition(async () => {
      try {
        await markPlacesVerifiedAction(formData)
      } catch {
        setSubmitError(VERIFY_SUBMIT_FAILED_MESSAGE)
      } finally {
        gateRef.current.release()
      }
    })
  }

  return (
    <>
      <VerificationQueueFormView action={submit} candidates={candidates} isPending={isPending} />
      {submitError !== null ? (
        <p className="rounded-2xl border border-[var(--status-error)]/40 bg-[var(--status-error)]/10 p-4 text-sm font-semibold leading-6 text-[var(--status-error)]" role="alert">
          {submitError}
        </p>
      ) : null}
    </>
  )
}

// 프레젠테이션 분리 — 필터·빠른 선택·확인 체크 렌더링을 테스트에서 직접 검증한다.
export function VerificationQueueFormView({
  action,
  candidates,
  isPending,
  initialSelected = [],
}: Readonly<{
  action?: (formData: FormData) => void
  candidates: readonly VerificationQueueItem[]
  isPending: boolean
  initialSelected?: readonly string[]
}>) {
  const [selected, setSelected] = useState<readonly string[]>(initialSelected)
  const [filter, setFilter] = useState<VerificationQueueFilter>("all")
  const [quickCount, setQuickCount] = useState(VERIFY_FORM_MAX_ITEMS)
  const visible = useMemo(() => filterVerificationCandidates(candidates, filter), [candidates, filter])

  const toggle = (placeId: string) => {
    setSelected((current) => {
      if (current.includes(placeId)) {
        return current.filter((id) => id !== placeId)
      }
      if (current.length >= VERIFY_FORM_MAX_ITEMS) {
        return current
      }
      return [...current, placeId]
    })
  }

  return (
    <form action={action} aria-busy={isPending} className="flex flex-col gap-5">
      <nav aria-label="검증 후보 필터" className="flex flex-wrap gap-2">
        {(Object.keys(VERIFY_FILTER_LABELS) as readonly VerificationQueueFilter[]).map((key) => (
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
            {VERIFY_FILTER_LABELS[key]}
          </button>
        ))}
      </nav>

      {/* 빠른 선택 — 현재 필터(카테고리)의 후보를 지정 수량만큼 자동 선택한다. 기존 선택은 대체된다. */}
      <div aria-label="빠른 선택" className="flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3" role="group">
        <label className="text-xs font-semibold text-[var(--text-secondary)]" htmlFor="verify-quick-count">
          선택 수량
        </label>
        <input
          className="w-16 rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-2 py-1 text-sm tabular-nums text-[var(--text-primary)]"
          disabled={isPending}
          id="verify-quick-count"
          max={VERIFY_FORM_MAX_ITEMS}
          min={1}
          onChange={(event) => {
            const parsed = Number.parseInt(event.target.value, 10)
            setQuickCount(Number.isNaN(parsed) ? 1 : Math.max(1, Math.min(parsed, VERIFY_FORM_MAX_ITEMS)))
          }}
          type="number"
          value={quickCount}
        />
        <button
          className="rounded-full border border-[var(--accent-primary)] bg-[var(--accent-primary)]/10 px-4 py-1.5 text-xs font-semibold text-[var(--accent-primary)] transition-colors duration-150 hover:bg-[var(--accent-primary)]/20 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isPending || visible.length === 0}
          onClick={() => {
            setSelected(quickSelectVerificationCandidates(candidates, filter, quickCount))
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

      <section aria-label="검증 대기 후보" className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <div className="flex items-center justify-between border-b border-[var(--border-default)] p-5">
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">확인할 업체 목록 (공식 홈페이지 보유)</h3>
          <p className="text-sm font-semibold text-[var(--text-primary)]">
            선택 {selected.length} / {VERIFY_FORM_MAX_ITEMS}
          </p>
        </div>
        {visible.length === 0 ? (
          <p className="p-6 text-sm leading-6 text-[var(--text-secondary)]">
            {candidates.length === 0
              ? "검증 대기 후보가 없습니다. 대상은 공식 홈페이지가 등록된 미검증 draft 장소이며, AI 생성·SEO 페이지가 아직 없어야 합니다."
              : "현재 필터에 해당하는 후보가 없습니다. 다른 카테고리 필터를 선택하세요."}
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border-default)]">
            {visible.map((candidate) => (
              <li className="flex items-start gap-3 px-5 py-4" key={candidate.placeId}>
                <input
                  aria-label={`${candidate.name} 검증 선택`}
                  checked={selected.includes(candidate.placeId)}
                  className="mt-1 size-4 accent-[var(--accent-primary)]"
                  disabled={isPending || (!selected.includes(candidate.placeId) && selected.length >= VERIFY_FORM_MAX_ITEMS)}
                  name="placeIds"
                  onChange={() => {
                    toggle(candidate.placeId)
                  }}
                  type="checkbox"
                  value={candidate.placeId}
                />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-[var(--text-primary)]">{candidate.name}</p>
                  <p className="mt-0.5 text-xs leading-5 text-[var(--text-secondary)]">
                    {candidate.region} · {candidate.address ?? "-"} · {candidate.phone ?? "전화 미등록"}
                  </p>
                  <p className="mt-0.5 text-xs leading-5 text-[var(--text-secondary)]">
                    {candidate.category ?? "-"} · {CONTENT_MODE_LABELS[candidate.contentMode]}
                  </p>
                </div>
                <a
                  className="whitespace-nowrap rounded-full border border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 px-3 py-1 text-xs font-semibold text-[var(--accent-primary)] transition-colors duration-150 hover:bg-[var(--accent-primary)]/20"
                  href={candidate.homepage}
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  공식 홈페이지 확인 ↗
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="검증 확인" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 text-sm leading-6">
        <h3 className="text-lg font-semibold text-[var(--text-primary)]">확인 체크 (필수)</h3>
        <p className="mt-2 text-[var(--text-secondary)]">
          각 장소의 공식 홈페이지를 열어 <strong>업체명·주소·전화번호</strong>가 목록과 일치하는지 직접 확인한 뒤 반영하세요. 반영된 장소는 곧바로 승인 자동 생성 후보에 나타납니다. 홈페이지가 다른 업체이거나 정보가 다르면 선택하지 마세요.
        </p>
        <label className="mt-4 flex items-start gap-2 text-sm leading-6 text-[var(--text-primary)]">
          <input className="mt-1 size-4 accent-[var(--accent-primary)]" disabled={isPending} name="verifyConfirmed" type="checkbox" />
          선택한 장소의 공식 홈페이지에서 명칭·주소·전화를 확인했으며 공식 검증(verified) 반영을 승인합니다.
        </label>
      </section>

      <div aria-live="polite" role="status">
        {isPending ? <p className="text-sm leading-6 text-[var(--text-secondary)]">검증 상태를 반영하고 있습니다...</p> : null}
      </div>

      <button
        className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[var(--accent-primary)] px-4 py-3 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:px-8"
        disabled={isPending || selected.length === 0}
        type="submit"
      >
        {isPending ? "반영 중..." : `확인 완료 — 2단계로 등록 (${String(selected.length)}곳)`}
      </button>
    </form>
  )
}
