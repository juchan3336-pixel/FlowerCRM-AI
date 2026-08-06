import Link from "next/link"

import { VerificationQueueForm, type VerificationQueueItem } from "@/components/admin/verification-queue-form"
import { listVerificationQueueCandidates } from "@/lib/admin/verification-queue"
import { VERIFY_MAX_ITEMS } from "@/lib/admin/verify-limits"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const ERROR_MESSAGES: Record<string, string> = {
  "no-places": "선택된 장소가 없습니다.",
  "not-confirmed": "공식 홈페이지 확인 체크박스에 체크해야 반영할 수 있습니다.",
  "too-many": `한 번에 최대 ${String(VERIFY_MAX_ITEMS)}곳까지 반영할 수 있습니다.`,
  "update-failed": "검증 반영에 실패했습니다. 잠시 후 다시 시도해 주세요.",
  "no-admin": "관리자 계정을 확인하지 못했습니다. 다시 로그인해 주세요.",
}

export default async function AdminVerifyPage({ searchParams }: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const params = await searchParams
  const errorKey = typeof params["error"] === "string" ? params["error"] : null
  const errorMessage = errorKey !== null ? ERROR_MESSAGES[errorKey] ?? "요청을 처리하지 못했습니다." : null
  const noticeKey = typeof params["notice"] === "string" ? params["notice"] : null
  const updatedCount = typeof params["updated"] === "string" ? params["updated"] : "0"
  const skippedCount = typeof params["skipped"] === "string" ? params["skipped"] : "0"
  const noticeMessage =
    noticeKey === "verified"
      ? `공식 검증 ${updatedCount}곳 반영 완료${skippedCount !== "0" ? ` (조건 불충족 ${skippedCount}곳 제외)` : ""} — 이제 2단계 · AI 생성 화면에서 바로 선택할 수 있습니다.`
      : null

  const candidates: readonly VerificationQueueItem[] = await listVerificationQueueCandidates()

  return (
    <section aria-labelledby="admin-verify-title" className="flex flex-col gap-6">
      <header className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">운영 · 1단계</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]" id="admin-verify-title">
          1단계 · 업체 확인 (한 번에 최대 {VERIFY_MAX_ITEMS}곳)
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">
          공식 홈페이지가 등록된 미검증 장소를 카테고리별로 추출합니다. 홈페이지에서 업체명·주소·전화를 직접 확인한 뒤 반영하면, 그 장소가 승인 자동 생성 후보에 나타나 생성부터 게시까지 콘솔에서 진행할 수 있습니다.
        </p>
        <ol className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold text-[var(--text-secondary)]">
          <li>1. 카테고리·수량 선택</li>
          <li aria-hidden>→</li>
          <li>2. 공식 홈페이지 확인</li>
          <li aria-hidden>→</li>
          <li>3. 검증 반영</li>
          <li aria-hidden>→</li>
          <li>4. 2단계 · AI 생성</li>
          <li aria-hidden>→</li>
          <li>5. 3단계 · 게시</li>
        </ol>
        <p className="mt-3 flex flex-wrap gap-4 text-sm">
          <Link className="font-semibold text-[var(--accent-primary)]" href="/admin/batch/approve">
            2단계 · AI 생성으로 이동 →
          </Link>
          <Link className="font-semibold text-[var(--accent-primary)]" href="/admin/batch/publish/new">
            3단계 · 게시로 이동 →
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

      <VerificationQueueForm candidates={candidates} />
    </section>
  )
}
