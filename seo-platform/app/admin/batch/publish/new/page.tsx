import Link from "next/link"

import { BatchServerErrorToast } from "@/components/admin/batch-launch-form"
import { BatchPublishForm, type BatchPublishCandidateItem } from "@/components/admin/batch-publish-form"
import { resolvePublishEnvironment } from "@/lib/admin/publish-environment"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const ERROR_MESSAGES: Record<string, string> = {
  "env-blocked": "Preview 배포에서는 게시를 실행할 수 없습니다. 운영(Production) admin에서 실행하세요.",
  "already-running": "이미 진행 중인 게시 배치가 있습니다. 완료·중단 후 다시 시작하세요.",
  empty: "선택된 장소가 없습니다.",
  "too-many": "한 배치는 최대 5건까지 선택할 수 있습니다.",
  duplicate: "같은 장소가 중복 선택되었습니다.",
  "publish-approval-required": "게시 승인에 체크해야 시작할 수 있습니다.",
  ineligible: "선택 장소 중 게시 조건을 충족하지 않는 장소가 있습니다. 목록의 사유를 확인하세요.",
}

export default async function BatchPublishNewPage({ searchParams }: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const params = await searchParams
  const errorKey = typeof params["error"] === "string" ? params["error"] : null
  const errorMessage = errorKey !== null ? ERROR_MESSAGES[errorKey] ?? "요청을 처리하지 못했습니다." : null
  const envBlocked = !resolvePublishEnvironment(process.env["VERCEL_ENV"]).allowed

  const { listBatchPublishCandidates } = await import("@/lib/batch/publish-batch-service")
  const candidates: BatchPublishCandidateItem[] = (await listBatchPublishCandidates()).map((candidate) => ({
    placeId: candidate.placeId,
    name: candidate.name,
    region: candidate.region,
    path: candidate.path,
    eligible: candidate.decision.eligible,
    reason: candidate.decision.eligible ? null : candidate.decision.reason,
  }))

  return (
    <section aria-labelledby="batch-publish-title" className="flex flex-col gap-6">
      <header className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">운영 · Batch</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]" id="batch-publish-title">
          일괄 게시 (최대 5건)
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">
          게시 준비(ready)가 끝난 장소를 선택해 한 장소씩 순차 게시합니다. 게시 성공 후 공개 URL 확인은 비동기로 진행되며 결과 화면에 장소별로 표시됩니다. 실패한 장소는 그 장소만 실패로 남고 다음 장소를 계속 처리합니다.
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

      {envBlocked ? (
        <p className="rounded-2xl border border-[var(--status-warning)]/50 bg-[var(--status-warning)]/10 p-4 text-sm font-semibold leading-6 text-[var(--status-warning)]">
          ⚠ 이 배포에서는 게시가 차단됩니다 — 게시는 운영(Production) admin에서만 실행할 수 있습니다.
        </p>
      ) : null}
      {errorMessage !== null ? (
        <p className="rounded-2xl border border-[var(--status-error)]/40 bg-[var(--status-error)]/10 p-4 text-sm font-semibold leading-6 text-[var(--status-error)]">{errorMessage}</p>
      ) : null}
      {errorMessage !== null ? <BatchServerErrorToast message={errorMessage} /> : null}

      <BatchPublishForm candidates={candidates} envBlocked={envBlocked} />
    </section>
  )
}
