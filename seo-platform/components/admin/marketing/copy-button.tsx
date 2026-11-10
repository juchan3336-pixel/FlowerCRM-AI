"use client"

import { useState } from "react"

// 게시 패키지의 제목·본문·주문 링크를 한 번에 복사하는 버튼.
// 복사는 게시가 아니다 — 게시 완료는 올린 글의 주소를 입력해야만 기록된다.
export function CopyButton({ text, label }: Readonly<{ text: string; label: string }>) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle")

  return (
    <button
      className="inline-flex min-h-9 items-center rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-1.5 text-xs font-semibold text-[var(--text-primary)] transition-colors duration-150 ease-out hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]/30"
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => {
            setState("copied")
          },
          () => {
            setState("failed")
          },
        )
      }}
    >
      {state === "copied" ? "복사됨" : state === "failed" ? "복사 실패 — 직접 선택해 복사" : label}
    </button>
  )
}
