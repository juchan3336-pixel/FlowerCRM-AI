"use client"

import { useFormStatus } from "react-dom"

// 제출 중에는 버튼을 잠그고 진행 중임을 알린다 — AI 글 생성은 20~40초 걸려, 다시 누르면 같은 요청이 두 번 들어간다.
export function PendingSubmitButton({ label, pendingLabel, className }: Readonly<{ label: string; pendingLabel: string; className: string }>) {
  const { pending } = useFormStatus()
  return (
    <button aria-disabled={pending} className={`${className} disabled:cursor-wait disabled:opacity-60`} disabled={pending} type="submit">
      {pending ? pendingLabel : label}
    </button>
  )
}
