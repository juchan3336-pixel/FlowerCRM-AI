import Link from "next/link"

import type { AdminPlaceRow } from "@/lib/admin/places"
import { formatKstDateTime } from "@/lib/admin/time"
import { StatusChip, type StatusChipTone } from "./status-chip"

type ChipDescriptor = {
  readonly label: string
  readonly tone: StatusChipTone
}

export function describePlaceStatus(status: AdminPlaceRow["status"]): ChipDescriptor {
  switch (status) {
    case "published":
      return { label: "게시됨", tone: "accent" }
    case "noindex":
      return { label: "비노출", tone: "warning" }
    case "archived":
      return { label: "보관", tone: "muted" }
    default:
      return { label: "게시 전", tone: "neutral" }
  }
}

export function describeAiState(aiState: AdminPlaceRow["aiState"]): ChipDescriptor {
  return aiState === "적용됨" ? { label: "적용됨", tone: "accent" } : { label: "생성 안됨", tone: "warning" }
}

export function describeSeoState(seoState: AdminPlaceRow["seoState"]): ChipDescriptor {
  switch (seoState) {
    case "published":
      return { label: "게시됨", tone: "accent" }
    case "ready":
      return { label: "게시 대기", tone: "warning" }
    case "draft":
      return { label: "초안", tone: "neutral" }
    case "archived":
      return { label: "보관", tone: "muted" }
    default:
      return { label: "없음", tone: "warning" }
  }
}

type PlaceRowItemProps = {
  readonly row: AdminPlaceRow
  readonly href: string
  readonly isSelected: boolean
  // 화면 표시용 순번(전체/검색 결과 집합 기준). 저장하지 않고 렌더 시 계산해 전달한다.
  readonly seq: number
}

// 게시일시 표시 — 실제 timestamptz가 있으면 KST(YYYY-MM-DD HH:mm), 미게시면 "-".
export function formatPlacePublishedAt(publishedAt: string | null): string {
  if (publishedAt === null) {
    return "-"
  }
  return formatKstDateTime(publishedAt)
}

export function PlaceRowItem({ row, href, isSelected, seq }: PlaceRowItemProps) {
  const placeStatus = describePlaceStatus(row.status)
  const aiState = describeAiState(row.aiState)
  const seoState = describeSeoState(row.seoState)

  return (
    <tr className={isSelected ? "bg-[var(--surface-secondary)] text-[var(--text-primary)]" : "text-[var(--text-primary)]"}>
      <td className="px-3 py-4 text-right font-mono text-xs tabular-nums text-[var(--text-secondary)]">{seq.toLocaleString("ko-KR")}</td>
      <td className="px-5 py-4">
        <Link
          aria-current={isSelected ? "true" : undefined}
          className="font-semibold transition-colors duration-150 ease-out hover:text-[var(--accent-primary)] focus-visible:text-[var(--accent-primary)] focus-visible:outline-none"
          href={href}
        >
          {row.name}
        </Link>
      </td>
      <td className="px-5 py-4 text-[var(--text-secondary)]">{row.category}</td>
      <td className="px-5 py-4 text-[var(--text-secondary)]">{row.region}</td>
      <td className="px-5 py-4"><StatusChip label={placeStatus.label} tone={placeStatus.tone} /></td>
      <td className="px-5 py-4"><StatusChip label={aiState.label} tone={aiState.tone} /></td>
      <td className="px-5 py-4"><StatusChip label={seoState.label} tone={seoState.tone} /></td>
      <td className="whitespace-nowrap px-5 py-4 text-[var(--text-secondary)] tabular-nums">{formatPlacePublishedAt(row.publishedAt)}</td>
    </tr>
  )
}
