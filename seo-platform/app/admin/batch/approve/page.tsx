import Link from "next/link"

import { cancelApprovalAction } from "@/app/admin/batch/approve/actions"
import { ApprovalLaunchForm, type ApprovalCandidateItem } from "@/components/admin/approval-launch-form"
import { StatusChip } from "@/components/admin/status-chip"
import { formatKstDateTime } from "@/lib/admin/time"
import { KICK_FAILURE_MESSAGES } from "@/lib/batch/approval-kick"
import { approvalWarning, canCancelApproval, canResumeApproval, describeApprovalError, describeApprovalStatus } from "@/lib/batch/approval-view"
import type { BatchApprovalRow } from "@/types/database"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const BLOCK_MESSAGES: Record<string, string> = {
  "no-places": "선택된 장소가 없습니다.",
  "too-many-places": "한 번에 최대 5곳까지 승인할 수 있습니다.",
  "duplicate-place": "같은 장소가 중복 선택되었습니다.",
  "not-draft": "선택 장소 중 draft 상태가 아닌 곳이 있습니다.",
  "not-verified": "선택 장소 중 공식 검증이 완료되지 않은 곳이 있습니다.",
  excluded: "선택 장소 중 후보 제외 대상이 있습니다.",
  "has-generation": "선택 장소 중 이미 AI 생성 이력이 있는 곳이 있습니다.",
  "has-seo-page": "선택 장소 중 이미 SEO 페이지가 있는 곳이 있습니다.",
  "missing-slug": "선택 장소 중 slug가 없는 곳이 있습니다.",
  "invalid-max-cost": "승인 비용 상한이 올바르지 않습니다.",
  "invalid-expiry": "승인 유효시간이 올바르지 않습니다.",
  "already-active": "이미 진행 중인 승인이 있습니다. 완료·취소 후 다시 승인해 주세요.",
  "not-confirmed": "승인 확인 체크박스에 체크해야 진행할 수 있습니다.",
  "no-admin": "관리자 계정을 확인하지 못했습니다. 다시 로그인해 주세요.",
}

function resolveErrorMessage(errorKey: string | null): string | null {
  if (errorKey === null) {
    return null
  }
  if (errorKey.startsWith("kick-")) {
    const code = errorKey.slice("kick-".length)
    const known: Record<string, string> = KICK_FAILURE_MESSAGES
    return known[code] ?? "자동 실행 요청에 실패했습니다. AI 생성은 시작되지 않았습니다."
  }
  return BLOCK_MESSAGES[errorKey] ?? "요청을 처리하지 못했습니다."
}

const NOTICE_MESSAGES: Record<string, string> = {
  started: "승인이 완료되어 자동 생성을 시작했습니다. 진행 상태는 아래 승인 이력에서 확인하세요.",
  cancelled: "승인을 취소했습니다.",
}

export default async function BatchApprovePage({ searchParams }: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const params = await searchParams
  const errorKey = typeof params["error"] === "string" ? params["error"] : null
  const noticeKey = typeof params["notice"] === "string" ? params["notice"] : null
  const errorMessage = resolveErrorMessage(errorKey)
  const noticeMessage = noticeKey !== null ? NOTICE_MESSAGES[noticeKey] ?? null : null
  const usdKrwRate = Number.parseFloat(process.env["AI_COST_USD_KRW_RATE"] ?? "") || 1400

  const [candidates, approvals] = await Promise.all([loadCandidates(), loadApprovals()])

  return (
    <section aria-labelledby="batch-approve-title" className="flex flex-col gap-6">
      <header className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">운영 · 승인 자동 생성</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]" id="batch-approve-title">
          승인 자동 생성 (최대 5곳)
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">
          공식 검증이 완료된 장소를 선택해 한 번 승인하면, 브라우저를 닫아도 서버가 이어서 AI 생성을 진행합니다. AI 생성은 Preview 환경에서만 실행되며, 운영 게시는 생성 완료 후 별도 승인 단계입니다.
        </p>
        <p className="mt-3 flex flex-wrap gap-4 text-sm">
          <Link className="font-semibold text-[var(--accent-primary)]" href="/admin/places">
            ← 장소관리로 돌아가기
          </Link>
          <Link className="font-semibold text-[var(--accent-primary)]" href="/admin/batch">
            Batch 이력 보기
          </Link>
        </p>
      </header>

      {errorMessage !== null ? (
        <p className="rounded-2xl border border-[var(--status-error)]/40 bg-[var(--status-error)]/10 p-4 text-sm font-semibold leading-6 text-[var(--status-error)]" role="alert">
          {errorMessage}
        </p>
      ) : null}
      {noticeMessage !== null ? (
        <p className="rounded-2xl border border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 p-4 text-sm font-semibold leading-6 text-[var(--accent-primary)]" role="status">
          {noticeMessage}
        </p>
      ) : null}

      <ApprovalLaunchForm candidates={candidates} usdKrwRate={usdKrwRate} />

      <ApprovalHistorySection approvals={approvals} />
    </section>
  )
}

export function ApprovalHistorySection({ approvals }: Readonly<{ approvals: readonly BatchApprovalRow[] }>) {
  return (
    <section aria-labelledby="approval-history-title" className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
      <div className="border-b border-[var(--border-default)] p-5">
        <h3 className="text-lg font-semibold text-[var(--text-primary)]" id="approval-history-title">
          승인 이력
        </h3>
      </div>
      {approvals.length === 0 ? (
        <p className="p-6 text-sm leading-6 text-[var(--text-secondary)]">승인 이력이 없습니다.</p>
      ) : (
        <ul className="divide-y divide-[var(--border-default)]">
          {approvals.map((approval) => {
            const status = describeApprovalStatus(approval.status)
            const warning = approvalWarning({ status: approval.status, batchRunId: approval.batch_run_id, lastErrorCode: approval.last_error_code })
            const errorLabel = describeApprovalError(approval.last_error_code)
            return (
              <li className="flex flex-col gap-2 p-5" key={approval.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip label={status.label} tone={status.tone} />
                  <span className="text-sm font-semibold text-[var(--text-primary)]">{approval.approved_place_ids.length}곳</span>
                  <span className="text-xs text-[var(--text-secondary)]">승인자 {approval.approved_by}</span>
                  <span className="text-xs tabular-nums text-[var(--text-secondary)]">{formatKstDateTime(approval.approved_at)}</span>
                </div>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-0.5 text-xs leading-5 sm:grid-cols-4">
                  <dt className="text-[var(--text-secondary)]">승인 비용 상한</dt>
                  <dd className="m-0 font-semibold tabular-nums">${approval.approved_max_cost_usd.toFixed(4)}</dd>
                  <dt className="text-[var(--text-secondary)]">연결 Batch</dt>
                  <dd className="m-0 font-semibold">
                    {approval.batch_run_id === null ? (
                      "-"
                    ) : (
                      <Link className="text-[var(--accent-primary)]" href={`/admin/batch/${approval.batch_run_id}`}>
                        상세 보기
                      </Link>
                    )}
                  </dd>
                  <dt className="text-[var(--text-secondary)]">최근 진행</dt>
                  <dd className="m-0 font-semibold tabular-nums">{approval.last_tick_at === null ? "-" : formatKstDateTime(approval.last_tick_at)}</dd>
                  <dt className="text-[var(--text-secondary)]">오류</dt>
                  <dd className="m-0 font-semibold">{errorLabel ?? "-"}</dd>
                </dl>
                {warning !== null ? (
                  <p className="rounded-xl border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 px-3 py-2 text-xs font-semibold leading-5 text-[var(--status-warning)]">
                    ⚠ {warning.message}
                  </p>
                ) : null}
                {canResumeApproval({ status: approval.status, batchRunId: approval.batch_run_id, lastErrorCode: approval.last_error_code }) ? (
                  <p className="text-xs leading-5 text-[var(--text-secondary)]">이어서 진행 기능은 다음 단계(PR-D)에서 제공됩니다. 현재는 취소 후 새 승인으로 진행하세요.</p>
                ) : null}
                {canCancelApproval(approval.status) ? (
                  <form action={cancelApprovalAction}>
                    <input name="approvalId" type="hidden" value={approval.id} />
                    <button
                      className="rounded-full border border-[var(--border-default)] px-4 py-1.5 text-xs font-semibold text-[var(--text-primary)] hover:border-[var(--status-warning)] hover:text-[var(--status-warning)]"
                      type="submit"
                    >
                      승인 취소
                    </button>
                  </form>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

async function loadCandidates(): Promise<readonly ApprovalCandidateItem[]> {
  try {
    const { listApprovalCandidates } = await import("@/lib/batch/approval-candidates")
    return await listApprovalCandidates()
  } catch {
    return []
  }
}

async function loadApprovals(): Promise<readonly BatchApprovalRow[]> {
  try {
    const { createSupabaseApprovalRepository } = await import("@/lib/batch/supabase-approval-repository")
    return await createSupabaseApprovalRepository().listApprovals(10)
  } catch {
    return []
  }
}
