"use client"

import { useFormStatus } from "react-dom"

// 자동 연속 동기화 버튼 — 중복 클릭 차단은 두 겹이다:
//  1) useFormStatus의 pending으로 전송 중 disabled
//  2) 진행 중 job이 있으면 서버가 새 job을 만들지 않는다 (sync_jobs 유니크 인덱스 + already-active 분기)
// 브라우저 루프는 쓰지 않는다 — 다음 배치는 서버 self-chain이 이어간다.
export function SyncJobStartButton({ active }: Readonly<{ active: boolean }>) {
  const { pending } = useFormStatus()
  const disabled = pending || active
  return (
    <button
      aria-describedby="sync-job-help"
      className="inline-flex items-center justify-center gap-2 rounded-full border border-[var(--accent-primary)] bg-[var(--accent-primary)] px-4 py-2 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      disabled={disabled}
      type="submit"
    >
      {pending || active ? (
        <>
          <span aria-hidden className="inline-block size-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          {pending ? "시작하는 중..." : "자동 동기화 진행 중"}
        </>
      ) : (
        "신규 데이터 동기화 시작"
      )}
    </button>
  )
}

export function SyncJobResumeButton() {
  const { pending } = useFormStatus()
  return (
    <button
      className="inline-flex items-center justify-center gap-2 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2 text-sm font-semibold text-[var(--accent-primary)] disabled:cursor-not-allowed disabled:opacity-60"
      disabled={pending}
      type="submit"
    >
      {pending ? (
        <>
          <span aria-hidden className="inline-block size-4 animate-spin rounded-full border-2 border-[var(--accent-primary)]/40 border-t-[var(--accent-primary)]" />
          이어서 진행하는 중...
        </>
      ) : (
        "이어서 진행"
      )}
    </button>
  )
}
