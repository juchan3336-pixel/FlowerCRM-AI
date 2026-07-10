"use client"

import { useState } from "react"

import type { AdminPlaceRow } from "@/lib/admin/places"
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
}

export function PlaceRowItem({ row }: PlaceRowItemProps) {
  const [expanded, setExpanded] = useState(false)
  const placeStatus = describePlaceStatus(row.status)
  const aiState = describeAiState(row.aiState)
  const seoState = describeSeoState(row.seoState)

  return (
    <>
      <tr className="text-[var(--text-primary)]">
        <td className="px-5 py-4">
          <button
            aria-expanded={expanded}
            className="flex w-full items-center gap-2 text-left font-semibold transition-colors duration-150 ease-out hover:text-[var(--accent-primary)] focus-visible:text-[var(--accent-primary)] focus-visible:outline-none"
            onClick={() => {
              setExpanded((value) => !value)
            }}
            type="button"
          >
            <span aria-hidden className="text-xs text-[var(--text-secondary)]">{expanded ? "▾" : "▸"}</span>
            {row.name}
          </button>
        </td>
        <td className="px-5 py-4 text-[var(--text-secondary)]">{row.category}</td>
        <td className="px-5 py-4 text-[var(--text-secondary)]">{row.region}</td>
        <td className="px-5 py-4"><StatusChip label={placeStatus.label} tone={placeStatus.tone} /></td>
        <td className="px-5 py-4"><StatusChip label={aiState.label} tone={aiState.tone} /></td>
        <td className="px-5 py-4"><StatusChip label={seoState.label} tone={seoState.tone} /></td>
      </tr>
      {expanded ? (
        <tr className="bg-[var(--surface-secondary)]">
          <td colSpan={6} className="px-5 py-4">
            <dl className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">주소</dt>
                <dd className="mt-1 text-[var(--text-primary)]">{row.address ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">전화</dt>
                <dd className="mt-1 text-[var(--text-primary)]">{row.phone ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">홈페이지</dt>
                <dd className="mt-1 break-all text-[var(--text-primary)]">{row.homepage ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">페이지 주소(슬러그)</dt>
                <dd className="mt-1 break-all font-mono text-xs text-[var(--text-primary)]">{row.slug ?? "—"}</dd>
              </div>
            </dl>
          </td>
        </tr>
      ) : null}
    </>
  )
}
