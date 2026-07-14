"use client"

import { createContext, useContext, useState, type ReactNode } from "react"

export type DrawerActionKind = "ai" | "prepare" | "publish" | "archive" | "restore"

export const DRAWER_ACTION_LABELS: Record<DrawerActionKind, Readonly<{ label: string; pendingLabel: string }>> = {
  ai: { label: "AI 생성", pendingLabel: "AI 생성 중…" },
  prepare: { label: "게시 준비", pendingLabel: "게시 준비 중…" },
  publish: { label: "게시 확인", pendingLabel: "게시 중…" },
  archive: { label: "보관 확인", pendingLabel: "보관 중…" },
  restore: { label: "복원 확인", pendingLabel: "복원 중…" },
}

type DrawerActionsContextValue = {
  readonly pendingAction: DrawerActionKind | null
  readonly beginAction: (kind: DrawerActionKind) => void
}

const DrawerActionsContext = createContext<DrawerActionsContextValue>({ pendingAction: null, beginAction: () => undefined })

// 액션 완료 시 서버 리다이렉트로 트리가 새로 마운트되므로 pending 상태는 자동 복구된다.
export function DrawerActionsProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [pendingAction, setPendingAction] = useState<DrawerActionKind | null>(null)

  return (
    <DrawerActionsContext.Provider
      value={{
        pendingAction,
        beginAction: (kind) => {
          setPendingAction(kind)
        },
      }}
    >
      {children}
    </DrawerActionsContext.Provider>
  )
}

type DrawerActionFormProps = {
  readonly action: (formData: FormData) => Promise<void>
  readonly kind: DrawerActionKind
  readonly fields: Readonly<Record<string, string>>
  readonly buttonClassName: string
  readonly formClassName?: string
  readonly children?: ReactNode
}

export function DrawerActionForm({ action, kind, fields, buttonClassName, formClassName, children }: DrawerActionFormProps) {
  const { pendingAction, beginAction } = useContext(DrawerActionsContext)

  return (
    <form
      action={action}
      className={formClassName}
      onSubmit={() => {
        beginAction(kind)
      }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} name={name} type="hidden" value={value} />
      ))}
      {children}
      <ActionSubmitButtonView
        className={buttonClassName}
        disabled={pendingAction !== null}
        isPending={pendingAction === kind}
        label={DRAWER_ACTION_LABELS[kind].label}
        pendingLabel={DRAWER_ACTION_LABELS[kind].pendingLabel}
      />
    </form>
  )
}

type ActionSubmitButtonViewProps = {
  readonly label: string
  readonly pendingLabel: string
  readonly isPending: boolean
  readonly disabled: boolean
  readonly className: string
}

// 순수 프레젠테이션 — pending/비활성 상태를 props로 받아 테스트 가능하다.
export function ActionSubmitButtonView({ label, pendingLabel, isPending, disabled, className }: ActionSubmitButtonViewProps) {
  return (
    <button aria-busy={isPending} className={`${className} disabled:cursor-not-allowed disabled:opacity-60`} disabled={disabled} type="submit">
      {isPending ? (
        <span className="inline-flex items-center justify-center gap-2">
          <span aria-hidden className="inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          {pendingLabel}
        </span>
      ) : (
        label
      )}
    </button>
  )
}
