"use client"

import { useMemo, useState } from "react"

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

export function BatchLaunchForm({ candidates, usdKrwRate, productionBlocked }: BatchLaunchFormProps) {
  const [selected, setSelected] = useState<readonly string[]>([])
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
    <form action={startBatchGenerationAction} className="flex flex-col gap-5">
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
                  disabled={!candidate.eligible || productionBlocked || (!selected.includes(candidate.placeId) && selected.length >= BATCH_MAX_ITEMS)}
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
          <input className="mt-1 size-4 accent-[var(--accent-primary)]" name="officialCheckApproved" type="checkbox" />
          선택한 장소는 공식 명칭·주소·전화·화환 반입 정책 검증을 완료했습니다.
        </label>
      </section>

      <button
        className="w-full rounded-full bg-[var(--accent-primary)] px-4 py-3 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:px-8"
        disabled={selected.length === 0 || productionBlocked}
        type="submit"
      >
        AI 일괄 생성 시작 ({selected.length}건)
      </button>
    </form>
  )
}
