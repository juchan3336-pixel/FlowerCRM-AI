"use client"

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"

import { useDrawerPendingAction } from "@/components/admin/drawer-actions"

export type ConfirmPanelKind = "publish" | "archive" | "restore"

type ConfirmPanelsContextValue = {
  readonly openPanel: ConfirmPanelKind | null
  readonly open: (kind: ConfirmPanelKind) => void
  readonly close: (kind: ConfirmPanelKind, options?: Readonly<{ returnFocus?: boolean }>) => void
  readonly registerToggle: (kind: ConfirmPanelKind, element: HTMLButtonElement | null) => void
}

const ConfirmPanelsContext = createContext<ConfirmPanelsContextValue>({
  openPanel: null,
  open: () => undefined,
  close: () => undefined,
  registerToggle: () => undefined,
})

export function confirmPanelId(kind: ConfirmPanelKind): string {
  return `confirm-panel-${kind}`
}

export function confirmPanelTitleId(kind: ConfirmPanelKind): string {
  return `confirm-panel-${kind}-title`
}

type ConfirmPanelsProviderProps = {
  readonly children: ReactNode
  readonly initialOpen: ConfirmPanelKind | null
  // 액션 완료로 SEO 상태가 바뀌면(소프트 내비게이션, 재마운트 없음) 열림 상태를 초기화해 stale 패널을 막는다.
  readonly resetKey: string
}

export function ConfirmPanelsProvider({ children, initialOpen, resetKey }: ConfirmPanelsProviderProps) {
  const [openPanel, setOpenPanel] = useState<ConfirmPanelKind | null>(initialOpen)
  const [lastResetKey, setLastResetKey] = useState(resetKey)
  const togglesRef = useRef(new Map<ConfirmPanelKind, HTMLButtonElement>())

  if (resetKey !== lastResetKey) {
    setLastResetKey(resetKey)
    setOpenPanel(initialOpen)
  }

  const open = useCallback((kind: ConfirmPanelKind) => {
    setOpenPanel(kind)
  }, [])

  const close = useCallback((kind: ConfirmPanelKind, options?: Readonly<{ returnFocus?: boolean }>) => {
    setOpenPanel((current) => (current === kind ? null : current))
    if (options?.returnFocus === true) {
      togglesRef.current.get(kind)?.focus()
    }
  }, [])

  const registerToggle = useCallback((kind: ConfirmPanelKind, element: HTMLButtonElement | null) => {
    if (element === null) {
      togglesRef.current.delete(kind)
    } else {
      togglesRef.current.set(kind, element)
    }
  }, [])

  return <ConfirmPanelsContext.Provider value={{ openPanel, open, close, registerToggle }}>{children}</ConfirmPanelsContext.Provider>
}

type ConfirmToggleButtonProps = {
  readonly kind: ConfirmPanelKind
  readonly className: string
  readonly children: ReactNode
}

// 기존 ?confirm= Link 대체 — 서버 왕복 없이 클릭 즉시 패널을 연다.
export function ConfirmToggleButton({ kind, className, children }: ConfirmToggleButtonProps) {
  const { openPanel, open, close, registerToggle } = useContext(ConfirmPanelsContext)
  const pendingAction = useDrawerPendingAction()
  const isOpen = openPanel === kind

  return (
    <button
      aria-controls={confirmPanelId(kind)}
      aria-expanded={isOpen}
      className={`${className} transition-[transform,opacity] duration-100 active:scale-[0.98] active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60 ${
        isOpen ? "ring-2 ring-[var(--accent-primary)]/40 ring-offset-2" : ""
      }`}
      disabled={pendingAction !== null}
      onClick={() => {
        if (isOpen) {
          close(kind)
        } else {
          open(kind)
        }
      }}
      ref={(element) => {
        registerToggle(kind, element)
      }}
      type="button"
    >
      {children}
    </button>
  )
}

type ConfirmCancelButtonProps = {
  readonly kind: ConfirmPanelKind
  readonly className: string
}

export function ConfirmCancelButton({ kind, className }: ConfirmCancelButtonProps) {
  const { close } = useContext(ConfirmPanelsContext)
  const pendingAction = useDrawerPendingAction()

  return (
    <button
      className={`${className} disabled:cursor-not-allowed disabled:opacity-60`}
      disabled={pendingAction !== null}
      onClick={() => {
        close(kind, { returnFocus: true })
      }}
      type="button"
    >
      취소
    </button>
  )
}

type ConfirmPanelShellProps = {
  readonly kind: ConfirmPanelKind
  readonly title: string
  readonly description: string
  readonly tone: "warning" | "primary"
  readonly children: ReactNode
  readonly closedContent?: ReactNode
}

// 서버 제출 전 확인 단계 — modal이 아니라 인라인 region으로, 배경을 막지 않는다.
export function ConfirmPanelShell({ kind, title, description, tone, children, closedContent }: ConfirmPanelShellProps) {
  const { openPanel, close } = useContext(ConfirmPanelsContext)
  const panelRef = useRef<HTMLElement | null>(null)
  const isOpen = openPanel === kind

  useEffect(() => {
    if (!isOpen) {
      return
    }

    const panel = panelRef.current
    if (panel !== null) {
      // 패널이 이미 충분히 보이면 스크롤하지 않는다 (모바일에서 화면 튐 방지).
      const rect = panel.getBoundingClientRect()
      const viewportHeight = window.innerHeight
      const fullyVisible = rect.top >= 0 && rect.bottom <= viewportHeight
      if (!fullyVisible) {
        panel.scrollIntoView({ behavior: "smooth", block: "nearest" })
      }
      const focusTarget = panel.querySelector<HTMLElement>('input[type="checkbox"], button[type="submit"]')
      focusTarget?.focus({ preventScroll: true })
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close(kind, { returnFocus: true })
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [isOpen, kind, close])

  if (!isOpen) {
    return closedContent ?? null
  }

  return (
    <section
      aria-labelledby={confirmPanelTitleId(kind)}
      className={`rounded-2xl border-2 bg-[var(--surface-elevated)] p-4 shadow-lg motion-reduce:animate-none animate-confirm-panel-in ${
        tone === "warning" ? "border-[var(--status-warning)]" : "border-[var(--accent-primary)]"
      }`}
      id={confirmPanelId(kind)}
      ref={panelRef}
      role="region"
    >
      <h4 className="flex items-center gap-2 text-base font-semibold text-[var(--text-primary)]" id={confirmPanelTitleId(kind)}>
        <span aria-hidden className={tone === "warning" ? "text-[var(--status-warning)]" : "text-[var(--accent-primary)]"}>
          ⚠
        </span>
        {title}
      </h4>
      <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">{description}</p>
      {children}
    </section>
  )
}
