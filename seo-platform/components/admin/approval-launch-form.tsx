"use client"

import { useMemo, useRef, useState, useTransition } from "react"

import { approveAndGenerateAction } from "@/app/admin/batch/approve/actions"
import type { ContentMode } from "@/lib/ai/content-mode"
import { formatKstDateTime } from "@/lib/admin/time"
import { BATCH_INELIGIBLE_LABELS, CONTENT_MODE_LABELS, type BatchIneligibleReason } from "@/lib/batch/candidate-policy"
import { approvalMaxCostUsd, estimateBatchCost } from "@/lib/batch/cost-policy"
import { BATCH_MAX_ITEMS } from "@/lib/batch/types"
import { createSubmitGate } from "./batch-launch-form"

export type ApprovalCandidateItem = {
  readonly placeId: string
  readonly name: string
  readonly region: string
  readonly address: string | null
  readonly phone: string | null
  readonly verifiedAt: string | null
  readonly verificationSourceUrls: readonly string[]
  readonly estimatedTokens: number
  readonly estimatedCostUsd: number
  readonly eligible: boolean
  readonly reason: BatchIneligibleReason | null
  // 업종 원문과 중앙 resolver 판정 모드 — 표시·필터용 (PR C).
  readonly category: string | null
  readonly contentMode: ContentMode | null
  readonly hasGeneration: boolean
  readonly seoPageStatus: string | null
}

// 모드·적격 필터 — 후보 데이터는 이미 로드돼 있어 클라이언트에서 거른다.
export type ApprovalCandidateFilter = "all" | ContentMode | "eligible-only" | "blocked-only"

export const APPROVAL_FILTER_LABELS: Readonly<Record<ApprovalCandidateFilter, string>> = {
  all: "전체",
  condolence: CONTENT_MODE_LABELS.condolence,
  celebration: CONTENT_MODE_LABELS.celebration,
  "corporate-celebration": CONTENT_MODE_LABELS["corporate-celebration"],
  "eligible-only": "승인 가능만",
  "blocked-only": "차단만",
}

export function filterApprovalCandidates(candidates: readonly ApprovalCandidateItem[], filter: ApprovalCandidateFilter): readonly ApprovalCandidateItem[] {
  switch (filter) {
    case "all":
      return candidates
    case "eligible-only":
      return candidates.filter((candidate) => candidate.eligible)
    case "blocked-only":
      return candidates.filter((candidate) => !candidate.eligible)
    default:
      return candidates.filter((candidate) => candidate.contentMode === filter)
  }
}

// 카테고리(모드) 필터 + 지정 수량으로 적격 후보 상위 N개를 뽑는다 — 빠른 선택 버튼과 테스트가 공유한다.
// 결과는 기존 선택을 대체한다(추가 아님). BATCH_MAX_ITEMS를 넘는 수량은 상한으로 자른다.
export function quickSelectApprovalCandidates(candidates: readonly ApprovalCandidateItem[], filter: ApprovalCandidateFilter, count: number): readonly string[] {
  const capped = Math.max(0, Math.min(Math.floor(count), BATCH_MAX_ITEMS))
  return filterApprovalCandidates(candidates, filter)
    .filter((candidate) => candidate.eligible)
    .slice(0, capped)
    .map((candidate) => candidate.placeId)
}

function ModeBadge({ mode }: Readonly<{ mode: ContentMode | null }>) {
  if (mode === null) {
    return <span className="whitespace-nowrap rounded-full border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 px-2.5 py-0.5 text-xs font-semibold text-[var(--status-warning)]">모드 판정 불가</span>
  }
  return <span className="whitespace-nowrap rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-2.5 py-0.5 text-xs font-semibold text-[var(--text-secondary)]">{CONTENT_MODE_LABELS[mode]}</span>
}

export const APPROVAL_SUBMIT_FAILED_MESSAGE = "승인 요청을 보내지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요."

// 검증일시는 다른 관리자 화면과 같은 KST 표기로 맞춘다 (원문 ISO 노출 금지).
export function formatVerifiedAt(verifiedAt: string | null): string {
  return verifiedAt === null ? "-" : formatKstDateTime(verifiedAt)
}

export function ApprovalLaunchForm({ candidates, usdKrwRate }: Readonly<{ candidates: readonly ApprovalCandidateItem[]; usdKrwRate: number }>) {
  const [isPending, startTransition] = useTransition()
  const [submitError, setSubmitError] = useState<string | null>(null)
  // 서버 액션 redirect는 소프트 내비게이션이라 이 컴포넌트가 다시 마운트되지 않는다.
  // 확인 모달을 명시적으로 닫지 않으면 결과(성공/실패/불확실)와 무관하게 열린 채 남는다 — PR-D.
  const [confirmOpen, setConfirmOpen] = useState(false)
  const gateRef = useRef(createSubmitGate())

  // 서버 액션은 성공·검증 실패 모두 redirect로 끝난다 — 여기 catch는 전송 실패만 처리한다.
  const submit = (formData: FormData) => {
    if (!gateRef.current.tryAcquire()) {
      return
    }
    setSubmitError(null)
    startTransition(async () => {
      try {
        await approveAndGenerateAction(formData)
      } catch {
        setSubmitError(APPROVAL_SUBMIT_FAILED_MESSAGE)
      } finally {
        // 요청이 어떤 식으로 끝나든(성공·확정 실패·불확실) 모달은 닫는다.
        gateRef.current.release()
        setConfirmOpen(false)
      }
    })
  }

  return (
    <>
      <ApprovalLaunchFormView
        action={submit}
        candidates={candidates}
        confirmOpen={confirmOpen}
        isPending={isPending}
        onConfirmOpenChange={setConfirmOpen}
        usdKrwRate={usdKrwRate}
      />
      {submitError !== null ? (
        <p className="rounded-2xl border border-[var(--status-error)]/40 bg-[var(--status-error)]/10 p-4 text-sm font-semibold leading-6 text-[var(--status-error)]" role="alert">
          {submitError}
        </p>
      ) : null}
    </>
  )
}

// 프레젠테이션 분리 — 선택·비용·모달·pending 렌더링을 테스트에서 직접 검증한다.
export function ApprovalLaunchFormView({
  action,
  candidates,
  isPending,
  usdKrwRate,
  initialSelected = [],
  initialConfirmOpen = false,
  confirmOpen: controlledConfirmOpen,
  onConfirmOpenChange,
}: Readonly<{
  action?: (formData: FormData) => void
  candidates: readonly ApprovalCandidateItem[]
  isPending: boolean
  usdKrwRate: number
  initialSelected?: readonly string[]
  initialConfirmOpen?: boolean
  // 모달 상태는 부모가 소유할 수 있다 — 요청이 끝나면 부모가 닫는다.
  confirmOpen?: boolean
  onConfirmOpenChange?: (open: boolean) => void
}>) {
  const [selected, setSelected] = useState<readonly string[]>(initialSelected)
  const [filter, setFilter] = useState<ApprovalCandidateFilter>("all")
  const [quickCount, setQuickCount] = useState(BATCH_MAX_ITEMS)
  const [uncontrolledConfirmOpen, setUncontrolledConfirmOpen] = useState(initialConfirmOpen)
  const confirmOpen = controlledConfirmOpen ?? uncontrolledConfirmOpen
  const setConfirmOpen = (open: boolean) => {
    setUncontrolledConfirmOpen(open)
    onConfirmOpenChange?.(open)
  }
  // 적격/부적격을 한 표에 섞으면 부적격 장소가 선택 가능한 후보처럼 보인다 — 목록 자체를 분리한다.
  // 필터는 표시만 거른다 — 이미 선택한 장소는 필터를 바꿔도 선택이 유지된다.
  const filtered = useMemo(() => filterApprovalCandidates(candidates, filter), [candidates, filter])
  const eligible = useMemo(() => filtered.filter((candidate) => candidate.eligible), [filtered])
  const ineligible = useMemo(() => filtered.filter((candidate) => !candidate.eligible), [filtered])
  const estimate = useMemo(() => estimateBatchCost(selected.length, usdKrwRate), [selected.length, usdKrwRate])
  const maxCost = useMemo(() => approvalMaxCostUsd(selected.length), [selected.length])
  const selectedNames = useMemo(
    () => candidates.filter((candidate) => selected.includes(candidate.placeId)).map((candidate) => candidate.name),
    [candidates, selected],
  )

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
      <nav aria-label="후보 필터" className="flex flex-wrap gap-2">
        {(Object.keys(APPROVAL_FILTER_LABELS) as readonly ApprovalCandidateFilter[]).map((key) => (
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
            {APPROVAL_FILTER_LABELS[key]}
          </button>
        ))}
      </nav>

      {/* 빠른 선택 — 현재 필터(카테고리)의 적격 후보를 지정 수량만큼 자동 선택한다. 기존 선택은 대체된다. */}
      <div aria-label="빠른 선택" className="flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3" role="group">
        <label className="text-xs font-semibold text-[var(--text-secondary)]" htmlFor="approval-quick-count">
          선택 수량
        </label>
        <input
          className="w-16 rounded-xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-2 py-1 text-sm tabular-nums text-[var(--text-primary)]"
          disabled={isPending}
          id="approval-quick-count"
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
          disabled={isPending || eligible.length === 0}
          onClick={() => {
            setSelected(quickSelectApprovalCandidates(candidates, filter, quickCount))
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

      {eligible.length === 0 ? (
        <p className="rounded-2xl border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 p-4 text-sm font-semibold leading-6 text-[var(--status-warning)]" role="status">
          현재 자동 생성 가능한 장소가 없습니다.
          <span className="mt-1 block font-normal">
            공식 검증이 완료됐고 기존 AI 생성 이력과 SEO 페이지가 없는 장소만 선택할 수 있습니다.
          </span>
        </p>
      ) : null}

      <section aria-label="자동 생성 가능 후보" className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <div className="flex items-center justify-between border-b border-[var(--border-default)] p-5">
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">자동 생성 가능 후보</h3>
          <p className="text-sm font-semibold text-[var(--text-primary)]">
            선택 {selected.length} / {BATCH_MAX_ITEMS}
          </p>
        </div>
        {eligible.length === 0 ? (
          <p className="p-6 text-sm leading-6 text-[var(--text-secondary)]">
            선택할 수 있는 장소가 없습니다. 대상은 공식 검증(official_verification_status=verified)이 완료된 draft 장소이며, AI 생성·SEO 페이지가 아직 없어야 합니다.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] border-collapse text-left text-sm">
              <thead className="bg-[var(--surface-secondary)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
                <tr>
                  <th className="w-10 px-3 py-3" scope="col">
                    <span className="sr-only">선택</span>
                  </th>
                  <th className="w-12 px-3 py-3 text-right" scope="col">No.</th>
                  <th className="px-4 py-3" scope="col">장소명</th>
                  <th className="px-4 py-3" scope="col">업종 / 모드</th>
                  <th className="px-4 py-3" scope="col">지역</th>
                  <th className="px-4 py-3" scope="col">주소</th>
                  <th className="px-4 py-3" scope="col">전화</th>
                  <th className="px-4 py-3" scope="col">공식 검증 출처</th>
                  <th className="px-4 py-3" scope="col">검증일시</th>
                  <th className="px-4 py-3 text-right" scope="col">예상 토큰</th>
                  <th className="px-4 py-3 text-right" scope="col">예상 비용</th>
                  <th className="px-4 py-3" scope="col">상태</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-default)]">
                {eligible.map((candidate, index) => {
                  const checked = selected.includes(candidate.placeId)
                  return (
                    <tr className="text-[var(--text-primary)]" key={candidate.placeId}>
                      <td className="px-3 py-3">
                        <input
                          aria-label={`${candidate.name} 선택`}
                          checked={checked}
                          className="size-4 accent-[var(--accent-primary)]"
                          disabled={isPending || !candidate.eligible || (!checked && selected.length >= BATCH_MAX_ITEMS)}
                          name="placeIds"
                          onChange={() => {
                            toggle(candidate.placeId)
                          }}
                          type="checkbox"
                          value={candidate.placeId}
                        />
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-[var(--text-secondary)]">{index + 1}</td>
                      <td className="px-4 py-3 font-semibold">{candidate.name}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1">
                          <span className="text-xs text-[var(--text-secondary)]">{candidate.category ?? "-"}</span>
                          <ModeBadge mode={candidate.contentMode} />
                        </div>
                      </td>
                      <td className="px-4 py-3 text-[var(--text-secondary)]">{candidate.region}</td>
                      <td className="px-4 py-3 text-[var(--text-secondary)]">{candidate.address ?? "-"}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-[var(--text-secondary)]">{candidate.phone ?? "-"}</td>
                      <td className="px-4 py-3 text-xs text-[var(--text-secondary)]">
                        {candidate.verificationSourceUrls.length === 0 ? "-" : `${String(candidate.verificationSourceUrls.length)}건`}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 tabular-nums text-[var(--text-secondary)]">{formatVerifiedAt(candidate.verifiedAt)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-[var(--text-secondary)]">{candidate.estimatedTokens.toLocaleString("ko-KR")}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-[var(--text-secondary)]">${candidate.estimatedCostUsd.toFixed(4)}</td>
                      <td className="px-4 py-3">
                        <span className="whitespace-nowrap rounded-full border border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 px-2.5 py-0.5 text-xs font-semibold text-[var(--accent-primary)]">
                          승인 가능
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {ineligible.length > 0 ? (
        <section aria-label="부적격·제외 항목" className="overflow-hidden rounded-3xl border border-dashed border-[var(--border-default)] bg-[var(--surface-secondary)]">
          <div className="border-b border-[var(--border-default)] p-5">
            <h3 className="text-lg font-semibold text-[var(--text-secondary)]">부적격 · 제외 항목</h3>
            <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">아래 장소는 자동 생성 대상이 아니며 선택할 수 없습니다.</p>
          </div>
          <ul className="divide-y divide-[var(--border-default)]">
            {ineligible.map((candidate) => (
              <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm opacity-70" key={candidate.placeId}>
                <span className="font-semibold text-[var(--text-secondary)]">{candidate.name}</span>
                <span className="text-xs text-[var(--text-secondary)]">{candidate.region}</span>
                <span className="text-xs text-[var(--text-secondary)]">{candidate.category ?? "-"}</span>
                <ModeBadge mode={candidate.contentMode} />
                <span className="whitespace-nowrap rounded-full border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 px-2.5 py-0.5 text-xs font-semibold text-[var(--status-warning)]">
                  자동 생성 불가 — {candidate.reason === null ? "사유 미상" : BATCH_INELIGIBLE_LABELS[candidate.reason]}
                </span>
                <span className="text-xs text-[var(--text-secondary)]">
                  출처 {candidate.verificationSourceUrls.length > 0 ? "있음" : "없음"} · 생성 이력 {candidate.hasGeneration ? "있음" : "없음"} · SEO {candidate.seoPageStatus ?? "없음"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="비용 예측" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 text-sm leading-6">
        <h3 className="text-lg font-semibold text-[var(--text-primary)]">예상 비용과 승인 상한</h3>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
          <dt className="text-[var(--text-secondary)]">선택 장소</dt>
          <dd className="m-0 font-semibold">{selected.length}곳</dd>
          <dt className="text-[var(--text-secondary)]">예상 토큰</dt>
          <dd className="m-0 font-semibold">{estimate.estimatedTokens.toLocaleString("ko-KR")}</dd>
          <dt className="text-[var(--text-secondary)]">예상 비용</dt>
          <dd className="m-0 font-semibold">
            ${estimate.estimatedCostUsd.toFixed(4)} (약 {estimate.estimatedCostKrw.toLocaleString("ko-KR")}원)
          </dd>
          <dt className="text-[var(--text-secondary)]">승인 비용 상한</dt>
          <dd className="m-0 font-semibold">${maxCost.toFixed(4)}</dd>
        </dl>
        <label className="mt-4 flex items-start gap-2 text-sm leading-6 text-[var(--text-primary)]">
          <input className="mt-1 size-4 accent-[var(--accent-primary)]" disabled={isPending} name="approvalConfirmed" type="checkbox" />
          선택한 장소의 공식 명칭·주소·전화·화환 반입 정책 검증을 완료했으며, 자동 생성을 승인합니다.
        </label>
      </section>

      <div aria-live="polite" role="status">
        {isPending ? <p className="text-sm leading-6 text-[var(--text-secondary)]">승인하고 자동 생성을 요청하는 중입니다. 잠시만 기다려 주세요.</p> : null}
      </div>

      <button
        className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[var(--accent-primary)] px-4 py-3 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:px-8"
        disabled={isPending || selected.length === 0}
        onClick={() => {
          setConfirmOpen(true)
        }}
        type="button"
      >
        {isPending ? (
          <>
            <span aria-hidden className="inline-block size-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            승인 처리 중...
          </>
        ) : (
          `승인하고 자동 생성 (${String(selected.length)}곳)`
        )}
      </button>

      {confirmOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
          onClick={() => {
            if (!isPending) {
              setConfirmOpen(false)
            }
          }}
        >
          <div
            aria-busy={isPending}
            aria-labelledby="approval-confirm-title"
            aria-modal="true"
            className="w-full max-w-md rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6 shadow-2xl"
            onClick={(event) => {
              event.stopPropagation()
            }}
            role="dialog"
          >
            <h3 className="text-lg font-semibold text-[var(--text-primary)]" id="approval-confirm-title">
              자동 생성 최종 승인
            </h3>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm leading-6">
              <dt className="text-[var(--text-secondary)]">선택 장소</dt>
              <dd className="m-0 font-semibold">{selected.length}곳</dd>
              <dt className="text-[var(--text-secondary)]">예상 총비용</dt>
              <dd className="m-0 font-semibold">
                ${estimate.estimatedCostUsd.toFixed(4)} (약 {estimate.estimatedCostKrw.toLocaleString("ko-KR")}원)
              </dd>
              <dt className="text-[var(--text-secondary)]">승인 비용 상한</dt>
              <dd className="m-0 font-semibold">${maxCost.toFixed(4)}</dd>
            </dl>
            <ul className="mt-3 list-disc space-y-0.5 pl-5 text-xs leading-5 text-[var(--text-secondary)]">
              {selectedNames.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
            <ul className="mt-3 space-y-1 text-xs leading-5 text-[var(--text-secondary)]">
              <li>· AI 생성은 Preview 환경에서만 실행됩니다.</li>
              <li>· Production 게시는 자동으로 실행되지 않습니다.</li>
              <li>· AI 생성 완료 후 게시 승인은 별도로 필요합니다.</li>
              <li>· 실행 중 브라우저를 닫아도 서버에서 계속 진행됩니다.</li>
            </ul>
            <div aria-live="polite" role="status">
              {isPending ? <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">승인 요청을 보내는 중입니다. 창을 닫지 말고 잠시만 기다려 주세요.</p> : null}
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
                    승인 처리 중...
                  </>
                ) : (
                  "승인하고 자동 생성"
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </form>
  )
}
