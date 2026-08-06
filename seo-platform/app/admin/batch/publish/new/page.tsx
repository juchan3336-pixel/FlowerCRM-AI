import Link from "next/link"

import { BatchServerErrorToast } from "@/components/admin/batch-launch-form"
import { BatchPublishForm, type BatchPublishCandidateItem } from "@/components/admin/batch-publish-form"
import { resolvePublishEnvironment } from "@/lib/admin/publish-environment"

export const dynamic = "force-dynamic"
export const maxDuration = 30

// 생성 배치 결과 중 게시 대상에서 빠지는 상태의 사유 라벨 — ready/warn_ready 외 전부.
const BATCH_OUTCOME_EXCLUDE_LABELS: Partial<Record<string, string>> = {
  needs_review: "품질 검토 필요 (게시 보류)",
  failed: "생성 실패",
  skipped: "건너뜀",
  interrupted: "중단됨",
  published: "이미 게시됨",
  publish_failed: "이전 게시 실패",
  queued: "아직 생성 대기",
  processing: "아직 생성 중",
}

// ready인데도 게시 후보 판정에서 빠진 경우의 사유 (콘텐츠 변경 등) — 후보 목록의 판정 라벨을 재사용한다.
function describeCandidateExclusion(candidate: { readonly eligible: boolean; readonly reason: string | null } | undefined): string {
  if (candidate === undefined) return "게시 후보 목록에 없음"
  if (candidate.eligible) return "선택 상한(5곳) 초과"
  return "게시 조건 미충족"
}

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
    category: candidate.category,
    contentMode: candidate.contentMode,
    eligible: candidate.decision.eligible,
    reason: candidate.decision.eligible ? null : candidate.decision.reason,
  }))

  // 생성 배치 → 게시 연결: ?fromBatch=<runId>로 들어오면 그 배치의 적격 장소를 자동 선택하고,
  // 부적격(품질 검토·실패 등)은 사유와 함께 제외 목록으로 보여준다 — 분류는 이미 끝났고 여기선 표시만 한다.
  const fromBatchRaw = typeof params["fromBatch"] === "string" ? params["fromBatch"] : null
  const fromBatch = fromBatchRaw !== null && /^[0-9a-fA-F-]{36}$/.test(fromBatchRaw) ? fromBatchRaw : null
  let initialSelected: readonly string[] = []
  let batchExcluded: readonly { name: string; reason: string }[] = []
  if (fromBatch !== null) {
    const { listBatchItemOutcomes } = await import("@/lib/batch/publish-batch-service")
    const { preselectPublishCandidatesFromBatch } = await import("@/components/admin/batch-publish-form")
    try {
      const outcomes = await listBatchItemOutcomes(fromBatch)
      const publishablePlaceIds = new Set(outcomes.filter((outcome) => outcome.status === "ready" || outcome.status === "warn_ready").map((outcome) => outcome.placeId))
      initialSelected = preselectPublishCandidatesFromBatch(candidates, publishablePlaceIds)
      const selectedSet = new Set(initialSelected)
      const candidateById = new Map(candidates.map((candidate) => [candidate.placeId, candidate]))
      batchExcluded = outcomes
        .filter((outcome) => !selectedSet.has(outcome.placeId))
        .map((outcome) => ({ name: outcome.name, reason: BATCH_OUTCOME_EXCLUDE_LABELS[outcome.status] ?? describeCandidateExclusion(candidateById.get(outcome.placeId)) }))
    } catch {
      // 배치 조회 실패는 게시 화면 자체를 막지 않는다 — 자동 선택 없이 일반 화면으로 둔다.
    }
  }

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

      {fromBatch !== null ? (
        <section aria-label="배치 연결 결과" className="rounded-2xl border border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 p-4 text-sm leading-6">
          <p className="font-semibold text-[var(--accent-primary)]">
            생성 배치의 적격 {initialSelected.length}곳이 자동 선택되었습니다. 아래에서 게시 승인 체크 후 시작하면 됩니다.
          </p>
          {batchExcluded.length > 0 ? (
            <div className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">
              <p className="font-semibold">부적격으로 제외된 장소 ({batchExcluded.length}곳):</p>
              <ul className="mt-1 list-inside list-disc">
                {batchExcluded.map((entry) => (
                  <li key={entry.name}>
                    {entry.name} — {entry.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      <BatchPublishForm candidates={candidates} envBlocked={envBlocked} initialSelected={initialSelected} />
    </section>
  )
}
