"use client"

import { useFormStatus } from "react-dom"

export function ManualSyncSubmitButton() {
  const { pending } = useFormStatus()

  return (
    <button
      aria-describedby="manual-sync-help"
      className="rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2 text-sm font-semibold text-[var(--accent-primary)] disabled:cursor-wait disabled:opacity-60"
      disabled={pending}
      type="submit"
    >
      {pending ? "Syncing..." : "Run Google Sheets sync"}
    </button>
  )
}
