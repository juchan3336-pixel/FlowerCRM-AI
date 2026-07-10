import Link from "next/link"

import type { AdminDashboardTaskCard } from "@/lib/admin/dashboard"

const toneClassName: Record<AdminDashboardTaskCard["tone"], string> = {
  accent: "text-[var(--accent-primary)]",
  neutral: "text-[var(--text-primary)]",
  warning: "text-[var(--status-warning)]",
}

type TaskCardProps = {
  readonly task: AdminDashboardTaskCard
}

function TaskCardBody({ task }: TaskCardProps) {
  const valueSizeClassName = task.value.length <= 8 ? "font-mono text-3xl" : "text-xl"

  return (
    <>
      <p className="text-sm font-semibold text-[var(--text-secondary)]">{task.label}</p>
      <p className={`mt-3 font-semibold tracking-[-0.01em] ${valueSizeClassName} ${toneClassName[task.tone]}`}>
        {task.value}
      </p>
      <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">{task.detail}</p>
    </>
  )
}

export function TaskCard({ task }: TaskCardProps) {
  if (task.href === undefined) {
    return (
      <article className="flex flex-col rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
        <TaskCardBody task={task} />
      </article>
    )
  }

  return (
    <Link
      href={task.href}
      className="group flex flex-col rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 transition duration-150 ease-out hover:border-[var(--accent-primary)] hover:bg-[var(--surface-primary)] focus-visible:border-[var(--accent-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]/30"
    >
      <TaskCardBody task={task} />
      <p className="mt-4 text-sm font-semibold text-[var(--accent-primary)] opacity-80 transition-opacity duration-150 group-hover:opacity-100">
        바로 처리하기 →
      </p>
    </Link>
  )
}
