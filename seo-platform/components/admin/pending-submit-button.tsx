"use client"

import { useFormStatus } from "react-dom"

type PendingSubmitButtonProps = {
  readonly label: string
  readonly pendingLabel: string
  readonly className: string
}

export function PendingSubmitButton({ label, pendingLabel, className }: PendingSubmitButtonProps) {
  const { pending } = useFormStatus()

  return (
    <button aria-busy={pending} className={className} disabled={pending} type="submit">
      {pending ? pendingLabel : label}
    </button>
  )
}
