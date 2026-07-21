"use client"

import { useEffect, useState } from "react"

import type { AdminPlacesAiCode, AdminPlacesNotice } from "@/lib/admin/places-url"

export type NoticeToastContent = {
  readonly tone: "success" | "failure"
  readonly title: string
  readonly message: string
}

const SUCCESS_TOAST_MESSAGES: Partial<Record<AdminPlacesNotice, string>> = {
  "ai-generated": "AI 미리보기가 생성되었습니다.",
  prepared: "게시 준비가 완료되었습니다.",
  "prepared-existing": "AI 내용을 적용했습니다. SEO 페이지는 이미 존재합니다.",
  published: "게시가 완료되었습니다.",
  "already-published": "이미 게시된 페이지입니다. 변경 사항이 없습니다.",
  archived: "보관이 완료되었습니다.",
  restored: "게시 준비 상태로 복원되었습니다.",
}

// 처리 자체는 성공했지만 확인이 지연된 상태 — "실패"로 표기하면 실제 게시 실패처럼 보이므로 별도 제목을 쓴다.
const DELAYED_TOAST_MESSAGES: Partial<Record<AdminPlacesNotice, string>> = {
  "cache-refresh-failed": "게시 데이터는 저장됐지만 공개 페이지 확인이 지연되고 있습니다. 잠시 후 다시 확인해 주세요.",
}

const FAILURE_TOAST_MESSAGES: Partial<Record<AdminPlacesNotice, string>> = {
  "ai-error": "AI 생성에 실패했습니다. 다시 시도하세요.",
  "ai-failed": "AI 생성에 실패했습니다. 기존 데이터는 변경되지 않았습니다.",
  "ai-busy": "이 장소의 AI 생성이 이미 진행 중입니다.",
  "ai-recent": "방금 생성된 AI 미리보기가 있습니다. 먼저 검토하세요.",
  "no-preview": "적용할 AI 미리보기가 없습니다. 먼저 AI 생성을 실행하세요.",
  "prepare-blocked": "게시 준비가 차단되었습니다. 필수 정보를 확인하세요.",
  "missing-env": "서버 환경 변수가 설정되지 않아 실행할 수 없습니다.",
  "publish-blocked": "게시 조건을 충족하지 않아 게시되지 않았습니다.",
  "publish-failed": "게시 처리에 실패했습니다. 상태는 변경되지 않았습니다.",
  "approval-required": "게시하려면 검토 완료 체크박스에 동의해야 합니다.",
  "archive-blocked": "게시됨 상태가 아니어서 보관할 수 없습니다.",
  "archive-failed": "보관 처리에 실패했습니다. 상태는 변경되지 않았습니다.",
  "restore-blocked": "보관 상태가 아니어서 복원할 수 없습니다.",
  "restore-failed": "복원 처리에 실패했습니다. 상태는 변경되지 않았습니다.",
  "env-blocked": "Preview 환경에서는 게시·보관·복원을 실행할 수 없습니다. 운영 admin에서 실행하세요.",
  "quality-blocked": "콘텐츠 품질 검사에 실패해 게시 준비가 차단되었습니다. 드로어의 품질 검사 결과를 확인하세요.",
}

const SUCCESS_AUTO_DISMISS_MS = 5000

export function resolveNoticeToast(notice: AdminPlacesNotice | null, aiCode: AdminPlacesAiCode | null): NoticeToastContent | null {
  if (notice === null) {
    return null
  }

  const successMessage = SUCCESS_TOAST_MESSAGES[notice]
  if (successMessage !== undefined) {
    return { tone: "success", title: "완료", message: successMessage }
  }

  const delayedMessage = DELAYED_TOAST_MESSAGES[notice]
  if (delayedMessage !== undefined) {
    return { tone: "failure", title: "확인 지연", message: delayedMessage }
  }

  const failureMessage = FAILURE_TOAST_MESSAGES[notice]
  if (failureMessage !== undefined) {
    return {
      tone: "failure",
      title: "실패",
      message: aiCode === null ? failureMessage : `${failureMessage} (오류 코드: ${aiCode})`,
    }
  }

  return null
}

type NoticeToastProps = {
  readonly notice: AdminPlacesNotice | null
  readonly aiCode: AdminPlacesAiCode | null
}

export function NoticeToast({ notice, aiCode }: NoticeToastProps) {
  const content = resolveNoticeToast(notice, aiCode)
  const [visible, setVisible] = useState(content !== null)

  // 새로고침 시 동일 notice가 반복 표시되지 않도록 URL에서 알림 파라미터를 제거한다 (RSC 재요청 없음).
  useEffect(() => {
    if (content === null) {
      return
    }
    const url = new URL(window.location.href)
    url.searchParams.delete("notice")
    url.searchParams.delete("aiCode")
    window.history.replaceState(window.history.state, "", url.toString())
  }, [content])

  // 성공 Toast는 5초 후 자동 닫힘. 실패 Toast는 닫기 전까지 유지된다.
  useEffect(() => {
    if (content?.tone !== "success") {
      return
    }
    const timer = setTimeout(() => {
      setVisible(false)
    }, SUCCESS_AUTO_DISMISS_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [content])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setVisible(false)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [])

  if (content === null || !visible) {
    return null
  }

  return (
    <div
      aria-live="polite"
      role="status"
      className={`fixed inset-x-4 bottom-4 z-50 flex items-start gap-3 rounded-2xl border-2 p-4 shadow-2xl sm:inset-x-auto sm:right-6 sm:bottom-6 sm:max-w-sm ${
        content.tone === "success"
          ? "border-[var(--accent-primary)] bg-[var(--surface-elevated)]"
          : "border-[var(--status-warning)] bg-[var(--surface-elevated)]"
      }`}
    >
      <span aria-hidden className={`text-lg leading-6 ${content.tone === "success" ? "text-[var(--accent-primary)]" : "text-[var(--status-warning)]"}`}>
        {content.tone === "success" ? "✓" : "⚠"}
      </span>
      <div className="min-w-0 flex-1 text-sm leading-6">
        <p className={`font-semibold ${content.tone === "success" ? "text-[var(--accent-primary)]" : "text-[var(--status-warning)]"}`}>{content.title}</p>
        <p className="mt-0.5 break-words text-[var(--text-primary)]">{content.message}</p>
      </div>
      <button
        aria-label="알림 닫기"
        className="rounded-full border border-[var(--border-default)] px-2 py-0.5 text-xs font-semibold text-[var(--text-secondary)] transition-colors duration-150 hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]/30"
        onClick={() => {
          setVisible(false)
        }}
        type="button"
      >
        닫기
      </button>
    </div>
  )
}
