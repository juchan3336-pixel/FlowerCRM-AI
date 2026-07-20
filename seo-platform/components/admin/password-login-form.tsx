"use client"

import { useActionState } from "react"

import { passwordLoginFormAction, type PasswordLoginFormState } from "@/app/login/actions"

const PASSWORD_LOGIN_INITIAL_STATE: PasswordLoginFormState = { status: "idle" }

const ERROR_MESSAGES: Record<Extract<PasswordLoginFormState, { status: "error" }>["code"], string> = {
  "invalid-credentials": "이메일 또는 비밀번호가 올바르지 않습니다.",
  "server-error": "로그인 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.",
  unauthorized: "이 계정은 관리자 콘솔 접근이 허용되지 않았습니다.",
  "setup-missing": "이 환경에는 관리자 로그인 설정이 아직 구성되지 않았습니다.",
}

export function passwordLoginErrorMessage(state: PasswordLoginFormState): string | null {
  return state.status === "error" ? ERROR_MESSAGES[state.code] : null
}

export function PasswordLoginForm({ nextPath }: Readonly<{ nextPath: string }>) {
  const [state, formAction, isPending] = useActionState(passwordLoginFormAction, PASSWORD_LOGIN_INITIAL_STATE)

  return <PasswordLoginFormView action={formAction} isPending={isPending} nextPath={nextPath} state={state} />
}

// 프레젠테이션 분리 — pending/오류 상태 렌더링을 테스트에서 직접 검증할 수 있게 한다.
export function PasswordLoginFormView({
  action,
  isPending,
  nextPath,
  state,
}: Readonly<{
  action?: (formData: FormData) => void
  isPending: boolean
  nextPath: string
  state: PasswordLoginFormState
}>) {
  const errorMessage = passwordLoginErrorMessage(state)

  return (
    <form action={action} aria-busy={isPending} className="mt-6 grid gap-4">
      <input name="next" type="hidden" value={nextPath} />
      <div aria-live="polite" role="status">
        {errorMessage !== null ? (
          <p className="rounded-2xl border border-red-300 bg-red-50 p-4 text-sm font-semibold leading-6 text-red-700" data-testid="password-login-error">
            {errorMessage}
          </p>
        ) : null}
      </div>
      <label className="grid gap-2 text-sm font-semibold text-[var(--text-primary)]">
        Email
        <input
          className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm text-[var(--text-primary)] focus-visible:border-[var(--accent-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]/30"
          defaultValue={state.status === "error" ? state.email : ""}
          name="email"
          placeholder="admin@example.com"
          required
          type="email"
        />
      </label>
      <label className="grid gap-2 text-sm font-semibold text-[var(--text-primary)]">
        Password
        <input
          className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm text-[var(--text-primary)] focus-visible:border-[var(--accent-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]/30"
          name="password"
          required
          type="password"
        />
      </label>
      <label className="flex items-center gap-3 text-sm font-semibold text-[var(--text-primary)]">
        <input className="size-4 rounded border border-[var(--border-default)]" name="remember" type="checkbox" />
        Remember me
      </label>
      <button
        className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent-primary)] px-5 py-3 text-sm font-semibold text-white transition-opacity duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]/40 disabled:cursor-not-allowed disabled:opacity-70"
        disabled={isPending}
        type="submit"
      >
        {isPending ? (
          <>
            <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            로그인 중...
          </>
        ) : (
          "로그인"
        )}
      </button>
    </form>
  )
}
