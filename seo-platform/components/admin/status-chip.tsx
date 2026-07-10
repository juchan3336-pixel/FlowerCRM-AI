export type StatusChipTone = "accent" | "neutral" | "warning" | "muted"

const toneClassName: Record<StatusChipTone, string> = {
  accent: "border-[var(--accent-primary)]/30 bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]",
  neutral: "border-[var(--border-default)] bg-[var(--surface-secondary)] text-[var(--text-primary)]",
  warning: "border-[var(--status-warning)]/30 bg-[var(--status-warning)]/10 text-[var(--status-warning)]",
  muted: "border-[var(--border-default)] bg-[var(--surface-secondary)] text-[var(--text-secondary)]",
}

type StatusChipProps = {
  readonly label: string
  readonly tone: StatusChipTone
}

export function StatusChip({ label, tone }: StatusChipProps) {
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold ${toneClassName[tone]}`}>
      {label}
    </span>
  )
}
