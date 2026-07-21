"use client"

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { useFormStatus } from "react-dom"

export type DrawerActionKind = "ai" | "retry" | "prepare" | "publish" | "archive" | "restore"

export const DRAWER_ACTION_LABELS: Record<DrawerActionKind, Readonly<{ label: string; pendingLabel: string }>> = {
  ai: { label: "AI 생성", pendingLabel: "AI 생성 중…" },
  retry: { label: "품질 FAIL 복구 재시도 (1회)", pendingLabel: "복구 재시도 생성 중…" },
  prepare: { label: "게시 준비", pendingLabel: "게시 준비 중…" },
  publish: { label: "게시 확인", pendingLabel: "게시 중…" },
  archive: { label: "보관 확인", pendingLabel: "보관 중…" },
  restore: { label: "복원 확인", pendingLabel: "복원 중…" },
}

type DrawerActionsContextValue = {
  readonly pendingAction: DrawerActionKind | null
  readonly reportPending: (kind: DrawerActionKind, isPending: boolean) => void
}

const DrawerActionsContext = createContext<DrawerActionsContextValue>({ pendingAction: null, reportPending: () => undefined })

// 서버 액션의 redirect는 소프트 내비게이션이라 이 컴포넌트가 재마운트되지 않는다.
// pending은 useFormStatus가 보고하는 실제 제출 수명주기에만 묶여야 하며, 수동 set-only 상태로 두면 완료 후에도 버튼이 영구 비활성된다.
export function DrawerActionsProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [pendingAction, setPendingAction] = useState<DrawerActionKind | null>(null)
  const reportPending = useCallback((kind: DrawerActionKind, isPending: boolean) => {
    setPendingAction((current) => {
      if (isPending) {
        return kind
      }
      return current === kind ? null : current
    })
  }, [])

  return <DrawerActionsContext.Provider value={{ pendingAction, reportPending }}>{children}</DrawerActionsContext.Provider>
}

// 확인 패널 토글·취소 버튼이 진행 중 여부를 읽어 스스로 비활성되도록 노출한다.
export function useDrawerPendingAction(): DrawerActionKind | null {
  return useContext(DrawerActionsContext).pendingAction
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
  return (
    <form action={action} className={formClassName}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} name={name} type="hidden" value={value} />
      ))}
      {children}
      <DrawerActionSubmitButton className={buttonClassName} kind={kind} />
    </form>
  )
}

// useFormStatus는 감싸는 form 내부에서만 동작하므로 버튼을 별도 컴포넌트로 분리한다.
function DrawerActionSubmitButton({ kind, className }: Readonly<{ kind: DrawerActionKind; className: string }>) {
  const { pending } = useFormStatus()
  const { pendingAction, reportPending } = useContext(DrawerActionsContext)

  useEffect(() => {
    reportPending(kind, pending)
    return () => {
      reportPending(kind, false)
    }
  }, [kind, pending, reportPending])

  return (
    <ActionSubmitButtonView
      className={className}
      disabled={pending || pendingAction !== null}
      isPending={pending}
      label={DRAWER_ACTION_LABELS[kind].label}
      pendingLabel={DRAWER_ACTION_LABELS[kind].pendingLabel}
    />
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
