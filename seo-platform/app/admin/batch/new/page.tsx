import Link from "next/link"

import { BatchLaunchForm, type BatchLaunchCandidate } from "@/components/admin/batch-launch-form"
import { resolvePublishEnvironment } from "@/lib/admin/publish-environment"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const ERROR_MESSAGES: Record<string, string> = {
  "production-blocked": "Production 배포에서는 AI 일괄 생성을 시작할 수 없습니다 (AI_PROVIDER=fake). Preview admin에서 실행하세요.",
  "already-running": "이미 진행 중인 배치가 있습니다. 완료·중단 후 다시 시작하세요.",
  empty: "선택된 장소가 없습니다.",
  "too-many": "한 배치는 최대 5건까지 선택할 수 있습니다.",
  duplicate: "같은 장소가 중복 선택되었습니다.",
  "official-check-required": "공식 검증 완료 확인에 체크해야 시작할 수 있습니다.",
  ineligible: "선택 장소 중 배치 조건을 충족하지 않는 장소가 있습니다. 목록의 사유를 확인하세요.",
  "cost-limit": "예상 비용이 상한을 초과해 시작이 차단되었습니다.",
}

export default async function BatchNewPage({ searchParams }: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const params = await searchParams
  const errorKey = typeof params["error"] === "string" ? params["error"] : null
  const errorMessage = errorKey !== null ? ERROR_MESSAGES[errorKey] ?? "요청을 처리하지 못했습니다." : null
  const productionBlocked = resolvePublishEnvironment(process.env["VERCEL_ENV"]).environment === "production"
  const usdKrwRate = Number.parseFloat(process.env["AI_COST_USD_KRW_RATE"] ?? "") || 1400

  const { listBatchGenerationCandidates } = await import("@/lib/batch/generation-batch-service")
  const candidates: BatchLaunchCandidate[] = (await listBatchGenerationCandidates()).map((candidate) => ({
    placeId: candidate.placeId,
    name: candidate.name,
    region: candidate.region,
    address: candidate.address,
    eligible: candidate.decision.eligible,
    reason: candidate.decision.eligible ? null : candidate.decision.reason,
  }))

  return (
    <section aria-labelledby="batch-new-title" className="flex flex-col gap-6">
      <header className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">운영 · Batch</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]" id="batch-new-title">
          AI 일괄 생성 (최대 5건)
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">
          공식 검증이 완료된 장소를 선택해 순차 생성합니다. PASS·issues 0 또는 repeat:title 단독 WARN 1건이면 게시 준비까지 자동 진행되고, 그 외에는 사용자 확인 대기로 남습니다. 운영 게시는 별도 승인 단계입니다.
        </p>
        <p className="mt-3 text-sm">
          <Link className="font-semibold text-[var(--accent-primary)]" href="/admin/places">
            ← 장소관리로 돌아가기
          </Link>
        </p>
      </header>

      {productionBlocked ? (
        <p className="rounded-2xl border border-[var(--status-warning)]/50 bg-[var(--status-warning)]/10 p-4 text-sm font-semibold leading-6 text-[var(--status-warning)]">
          ⚠ Production 배포입니다 — AI_PROVIDER=fake라 일괄 생성이 차단됩니다. Preview admin에서 실행하세요.
        </p>
      ) : null}
      {errorMessage !== null ? (
        <p className="rounded-2xl border border-[var(--status-error)]/40 bg-[var(--status-error)]/10 p-4 text-sm font-semibold leading-6 text-[var(--status-error)]">{errorMessage}</p>
      ) : null}

      <BatchLaunchForm candidates={candidates} productionBlocked={productionBlocked} usdKrwRate={usdKrwRate} />
    </section>
  )
}
