"use client"

import { useEffect, useMemo, useRef, useState, useTransition } from "react"

import { startBatchGenerationAction } from "@/app/admin/batch/actions"
import { BATCH_INELIGIBLE_LABELS, type BatchIneligibleReason } from "@/lib/batch/candidate-policy"
import { DEFAULT_MAX_COST_USD, estimateBatchCost } from "@/lib/batch/cost-policy"
import { BATCH_MAX_ITEMS } from "@/lib/batch/types"

export type BatchLaunchCandidate = {
  readonly placeId: string
  readonly name: string
  readonly region: string
  readonly address: string | null
  readonly eligible: boolean
  readonly reason: BatchIneligibleReason | null
}

type BatchLaunchFormProps = {
  readonly candidates: readonly BatchLaunchCandidate[]
  readonly usdKrwRate: number
  readonly productionBlocked: boolean
}

export const BATCH_SUBMIT_FAILED_MESSAGE = "배치 시작 요청을 보내지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요."

// 전송 중 재진입 차단 게이트 — isPending 상태 반영 전의 연속 클릭까지 막는다 (중복 batch 생성 금지).
export function createSubmitGate(): { readonly tryAcquire: () => boolean; readonly release: () => void } {
  let inFlight = false
  return {
    tryAcquire: () => {
      if (inFlight) {
        return false
      }
      inFlight = true
      return true
    },
    release: () => {
      inFlight = false
    },
  }
}

export function BatchLaunchForm({ candidates, usdKrwRate, productionBlocked }: BatchLaunchFormProps) {
  const [isPending, startTransition] = useTransition()
  const [submitError, setSubmitError] = useState<string | null>(null)
  const gateRef = useRef(createSubmitGate())

  // 서버 액션은 성공·검증 실패 모두 redirect로 끝난다 — 여기 catch는 네트워크 등 전송 실패만 처리한다.
  const submit = (formData: FormData) => {
    if (!gateRef.current.tryAcquire()) {
      return
    }
    setSubmitError(null)
    startTransition(async () => {
      try {
        await startBatchGenerationAction(formData)
      } catch {
        setSubmitError(BATCH_SUBMIT_FAILED_MESSAGE)
      } finally {
        gateRef.current.release()
      }
    })
  }

  return (
    <>
      <BatchLaunchFormView action={submit} candidates={candidates} isPending={isPending} productionBlocked={productionBlocked} usdKrwRate={usdKrwRate} />
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

// 프레젠테이션 분리 — pending/오류 상태 렌더링을 테스트에서 직접 검증할 수 있게 한다.
export function BatchLaunchFormView({
  action,
  candidates,
  isPending,
  productionBlocked,
  usdKrwRate,
  initialSelected = [],
  initialConfirmOpen = false,
}: Readonly<{
  action?: (formData: FormData) => void
  candidates: readonly BatchLaunchCandidate[]
  isPending: boolean
  productionBlocked: boolean
  usdKrwRate: number
  initialSelected?: readonly string[]
  initialConfirmOpen?: boolean
}>) {
  const [selected, setSelected] = useState<readonly string[]>(initialSelected)
  const [confirmOpen, setConfirmOpen] = useState(initialConfirmOpen)
  const estimate = useMemo(() => estimateBatchCost(selected.length, usdKrwRate), [selected.length, usdKrwRate])

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
      <section aria-label="대상 선택" className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <div className="flex items-center justify-between border-b border-[var(--border-default)] p-5">
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">공식 검증 완료 장소</h3>
          <p className="text-sm font-semibold text-[var(--text-primary)]">
            선택 {selected.length} / {BATCH_MAX_ITEMS}
          </p>
        </div>
        {candidates.length === 0 ? (
          <p className="p-6 text-sm leading-6 text-[var(--text-secondary)]">
            선택 가능한 장소가 없습니다. Batch 대상은 official_verification_status=verified인 draft 장소만 허용됩니다 — 공식 검증(명칭·주소·전화·화환 정책) 완료 후 검증 상태를 기록하세요.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border-default)]">
            {candidates.map((candidate) => (
              <li className="flex items-start gap-3 px-5 py-4" key={candidate.placeId}>
                <input
                  aria-label={`${candidate.name} 선택`}
                  checked={selected.includes(candidate.placeId)}
                  className="mt-1 size-4 accent-[var(--accent-primary)]"
                  disabled={isPending || !candidate.eligible || productionBlocked || (!selected.includes(candidate.placeId) && selected.length >= BATCH_MAX_ITEMS)}
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
                    {candidate.region}
                    {candidate.address !== null ? ` · ${candidate.address}` : ""}
                  </p>
                </div>
                {candidate.eligible ? (
                  <span className="whitespace-nowrap rounded-full border border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 px-2.5 py-0.5 text-xs font-semibold text-[var(--accent-primary)]">
                    선택 가능
                  </span>
                ) : (
                  <span className="whitespace-nowrap rounded-full border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 px-2.5 py-0.5 text-xs font-semibold text-[var(--status-warning)]">
                    진입 불가 — {candidate.reason === null ? "사유 미상" : BATCH_INELIGIBLE_LABELS[candidate.reason]}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="비용 예측" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 text-sm leading-6">
        <h3 className="text-lg font-semibold text-[var(--text-primary)]">예상 비용</h3>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
          <dt className="text-[var(--text-secondary)]">예상 생성 수</dt>
          <dd className="m-0 font-semibold">{estimate.items}건</dd>
          <dt className="text-[var(--text-secondary)]">예상 토큰</dt>
          <dd className="m-0 font-semibold">{estimate.estimatedTokens.toLocaleString("ko-KR")}</dd>
          <dt className="text-[var(--text-secondary)]">예상 비용</dt>
          <dd className="m-0 font-semibold">
            ${estimate.estimatedCostUsd.toFixed(4)} (약 {estimate.estimatedCostKrw.toLocaleString("ko-KR")}원)
          </dd>
          <dt className="text-[var(--text-secondary)]">적용 환율 / 상한</dt>
          <dd className="m-0 font-semibold">
            {usdKrwRate.toLocaleString("ko-KR")}원/USD · 상한 ${DEFAULT_MAX_COST_USD}
          </dd>
        </dl>
        <label className="mt-4 flex items-start gap-2 text-sm leading-6 text-[var(--text-primary)]">
          <input className="mt-1 size-4 accent-[var(--accent-primary)]" disabled={isPending} name="officialCheckApproved" type="checkbox" />
          선택한 장소는 공식 명칭·주소·전화·화환 반입 정책 검증을 완료했습니다.
        </label>
      </section>

      <div aria-live="polite" role="status">
        {isPending ? <p className="text-sm leading-6 text-[var(--text-secondary)]">배치를 생성하고 있습니다. 잠시만 기다려 주세요 — 완료되면 진행 화면으로 이동합니다.</p> : null}
      </div>

      <button
        className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[var(--accent-primary)] px-4 py-3 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:px-8"
        disabled={isPending || selected.length === 0 || productionBlocked}
        onClick={() => {
          setConfirmOpen(true)
        }}
        type="button"
      >
        {isPending ? (
          <>
            <span aria-hidden className="inline-block size-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            배치 준비 중...
          </>
        ) : (
          `AI 일괄 생성 시작 (${String(selected.length)}건)`
        )}
      </button>

      {confirmOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
          onClick={() => {
            // pending 중에는 배경 클릭으로 닫히지 않는다 (요청 진행 중 이탈 방지).
            if (!isPending) {
              setConfirmOpen(false)
            }
          }}
        >
          <div
            aria-busy={isPending}
            aria-labelledby="batch-confirm-title"
            aria-modal="true"
            className="w-full max-w-md rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6 shadow-2xl"
            onClick={(event) => {
              event.stopPropagation()
            }}
            role="dialog"
          >
            <h3 className="text-lg font-semibold text-[var(--text-primary)]" id="batch-confirm-title">
              일괄 생성 최종 확인
            </h3>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm leading-6">
              <dt className="text-[var(--text-secondary)]">선택 장소</dt>
              <dd className="m-0 font-semibold">{selected.length}건</dd>
              <dt className="text-[var(--text-secondary)]">예상 토큰</dt>
              <dd className="m-0 font-semibold">{estimate.estimatedTokens.toLocaleString("ko-KR")}</dd>
              <dt className="text-[var(--text-secondary)]">예상 비용</dt>
              <dd className="m-0 font-semibold">
                ${estimate.estimatedCostUsd.toFixed(4)} (약 {estimate.estimatedCostKrw.toLocaleString("ko-KR")}원)
              </dd>
            </dl>
            <p className="mt-3 text-xs leading-5 text-[var(--text-secondary)]">시작하면 선택한 장소를 한 곳씩 순차 생성합니다. 완료되면 진행 화면으로 이동합니다.</p>
            <div aria-live="polite" role="status">
              {isPending ? <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">배치를 생성하고 있습니다. 창을 닫지 말고 잠시만 기다려 주세요.</p> : null}
            </div>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                className="rounded-full border border-[var(--border-default)] px-5 py-2.5 text-sm font-semibold text-[var(--text-primary)] hover:border-[var(--accent-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isPending}
                onClick={() => {
                  setConfirmOpen(false)
                }}
                type="button"
              >
                취소
              </button>
              <button
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent-primary)] px-6 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isPending}
                type="submit"
              >
                {isPending ? (
                  <>
                    <span aria-hidden className="inline-block size-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                    배치 생성 준비 중...
                  </>
                ) : (
                  "일괄 생성 시작"
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </form>
  )
}

// 실패 Toast — NoticeToast와 동일한 시각 규칙 (실패 톤, 닫기 전 유지). 서버 검증 실패(redirect ?error=)와 전송 실패 모두 이걸로 표시한다.
export function BatchFailureToast({ message, onDismiss }: Readonly<{ message: string; onDismiss?: () => void }>) {
  return (
    <div
      aria-live="assertive"
      role="alert"
      className="fixed inset-x-4 bottom-4 z-50 flex items-start gap-3 rounded-2xl border-2 border-[var(--status-warning)] bg-[var(--surface-elevated)] p-4 shadow-2xl sm:inset-x-auto sm:right-6 sm:bottom-6 sm:max-w-sm"
    >
      <span aria-hidden className="text-lg leading-6 text-[var(--status-warning)]">
        ⚠
      </span>
      <div className="min-w-0 flex-1 text-sm leading-6">
        <p className="font-semibold text-[var(--status-warning)]">배치 시작 실패</p>
        <p className="mt-0.5 text-[var(--text-primary)]">{message}</p>
      </div>
      {onDismiss !== undefined ? (
        <button aria-label="알림 닫기" className="text-sm font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)]" onClick={onDismiss} type="button">
          ✕
        </button>
      ) : null}
    </div>
  )
}

// 서버 액션 redirect(?error=...)로 돌아온 실패를 Toast로 표시 — NoticeToast처럼 URL 파라미터를 정리해 새로고침 반복 표시를 막는다.
export function BatchServerErrorToast({ message }: Readonly<{ message: string }>) {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.has("error")) {
      url.searchParams.delete("error")
      window.history.replaceState(window.history.state, "", url.toString())
    }
  }, [])

  if (!visible) {
    return null
  }

  return (
    <BatchFailureToast
      message={message}
      onDismiss={() => {
        setVisible(false)
      }}
    />
  )
}
