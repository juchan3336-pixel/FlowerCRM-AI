import type { AdminSummaryCard } from "./admin-data"

const toneClassName: Record<AdminSummaryCard["tone"], string> = {
  accent: "text-[var(--accent-primary)]",
  neutral: "text-[var(--text-primary)]",
  warning: "text-[var(--status-warning)]",
}

type SummaryCardProps = {
  readonly card: AdminSummaryCard
}

export function SummaryCard({ card }: SummaryCardProps) {
  return (
    <article className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
      <p className="text-sm font-semibold text-[var(--text-secondary)]">{card.label}</p>
      <p className={`mt-3 font-mono text-3xl font-semibold tracking-[-0.01em] ${toneClassName[card.tone]}`}>
        {card.value}
      </p>
      <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">{card.detail}</p>
    </article>
  )
}
