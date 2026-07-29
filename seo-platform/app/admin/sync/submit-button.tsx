"use client"

import { useFormStatus } from "react-dom"

// 수동 1회 실행 버튼 — 다음 배치를 브라우저가 다시 제출하던 자동 루프는 제거됐다.
// 연속 처리는 서버 self-chain(SyncJobCard)이 담당한다: 화면을 닫아도 진행되고, 실패 행에서 멈추지 않는다.
export function ManualSyncSubmitButton() {
  const { pending } = useFormStatus()

  return (
    <button
      aria-describedby="manual-sync-help"
      className="rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2 text-sm font-semibold text-[var(--accent-primary)] disabled:cursor-wait disabled:opacity-60"
      disabled={pending}
      type="submit"
    >
      {pending ? "동기화 중..." : "한 번 실행 (50건)"}
    </button>
  )
}
