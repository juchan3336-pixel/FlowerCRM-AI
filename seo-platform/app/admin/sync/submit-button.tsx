"use client"

import { useEffect, useRef } from "react"
import { useFormStatus } from "react-dom"

export function ManualSyncSubmitButton({ autoRun }: Readonly<{ autoRun: AutoRunState }>) {
  const { pending } = useFormStatus()
  const autoButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!autoRun.shouldContinue || pending) {
      return
    }

    const timeout = window.setTimeout(() => {
      autoButtonRef.current?.form?.requestSubmit(autoButtonRef.current)
    }, 1200)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [autoRun.shouldContinue, pending])

  return (
    <div className="flex flex-wrap gap-2">
      <button
        aria-describedby="manual-sync-help"
        className="rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2 text-sm font-semibold text-[var(--accent-primary)] disabled:cursor-wait disabled:opacity-60"
        disabled={pending}
        type="submit"
      >
        {pending ? "Syncing..." : "Run once"}
      </button>
      <button
        aria-describedby="manual-sync-help"
        className="rounded-full border border-[var(--accent-primary)] bg-[var(--accent-primary)] px-4 py-2 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60"
        disabled={pending}
        name="auto"
        ref={autoButtonRef}
        type="submit"
        value="1"
      >
        {autoRun.active ? "Auto syncing..." : "Auto sync remaining"}
      </button>
    </div>
  )
}

export type AutoRunState = {
  readonly active: boolean
  readonly shouldContinue: boolean
}
