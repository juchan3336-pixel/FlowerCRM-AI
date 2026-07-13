import type { AdminPlacesTaskFilterKey } from "./places"

export const ADMIN_PLACES_PAGE_SIZES = [50, 100, 200] as const
export const ADMIN_PLACES_DEFAULT_PAGE_SIZE = 50

export const ADMIN_PLACES_NOTICES = [
  "ai-generated",
  "ai-error",
  "no-preview",
  "prepared",
  "prepared-existing",
  "prepare-blocked",
  "missing-env",
  "published",
  "already-published",
  "publish-blocked",
  "publish-failed",
  "approval-required",
  "archived",
  "archive-blocked",
  "archive-failed",
  "restored",
  "restore-blocked",
  "restore-failed",
] as const

export type AdminPlacesNotice = (typeof ADMIN_PLACES_NOTICES)[number]

export const ADMIN_PLACES_CONFIRMS = ["publish", "archive", "restore"] as const

export type AdminPlacesConfirm = (typeof ADMIN_PLACES_CONFIRMS)[number]

export type AdminPlacesWorkspaceParams = {
  readonly q: string | null
  readonly task: AdminPlacesTaskFilterKey | null
  readonly page: number
  readonly pageSize: number
  readonly selected: string | null
  readonly preview: boolean
  readonly notice: AdminPlacesNotice | null
  readonly confirm: AdminPlacesConfirm | null
}

const TASK_FILTER_KEYS = ["ai-missing", "publish-pending", "published"] as const
const SELECTED_ID_PATTERN = /^[0-9a-zA-Z_-]{1,64}$/

export function resolveAdminPlacesWorkspaceParams(searchParams: Record<string, string | string[] | undefined>): AdminPlacesWorkspaceParams {
  const q = readSingleParam(searchParams["q"])?.trim().slice(0, 100) ?? null
  const taskCandidate = readSingleParam(searchParams["task"])
  const pageCandidate = Number.parseInt(readSingleParam(searchParams["page"]) ?? "", 10)
  const pageSizeCandidate = Number.parseInt(readSingleParam(searchParams["pageSize"]) ?? "", 10)
  const selectedCandidate = readSingleParam(searchParams["selected"])?.trim() ?? null
  const noticeCandidate = readSingleParam(searchParams["notice"])
  const confirmCandidate = readSingleParam(searchParams["confirm"])

  return {
    q: q !== null && q.length > 0 ? q : null,
    task: (TASK_FILTER_KEYS as readonly string[]).includes(taskCandidate ?? "") ? (taskCandidate as AdminPlacesTaskFilterKey) : null,
    page: Number.isInteger(pageCandidate) && pageCandidate >= 1 ? pageCandidate : 1,
    pageSize: (ADMIN_PLACES_PAGE_SIZES as readonly number[]).includes(pageSizeCandidate) ? pageSizeCandidate : ADMIN_PLACES_DEFAULT_PAGE_SIZE,
    selected: selectedCandidate !== null && SELECTED_ID_PATTERN.test(selectedCandidate) ? selectedCandidate : null,
    preview: readSingleParam(searchParams["preview"]) === "1",
    notice: (ADMIN_PLACES_NOTICES as readonly string[]).includes(noticeCandidate ?? "") ? (noticeCandidate as AdminPlacesNotice) : null,
    confirm: (ADMIN_PLACES_CONFIRMS as readonly string[]).includes(confirmCandidate ?? "") ? (confirmCandidate as AdminPlacesConfirm) : null,
  }
}

function readSingleParam(value: string | string[] | undefined): string | null {
  if (typeof value === "string") {
    return value
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0]
  }
  return null
}

export type AdminPlacesHrefInput = Readonly<{
  q?: string | null
  task?: AdminPlacesTaskFilterKey | null
  page?: number
  pageSize?: number
  selected?: string | null
  preview?: boolean
  notice?: AdminPlacesNotice | null
  confirm?: AdminPlacesConfirm | null
}>

export function buildAdminPlacesHref(input: AdminPlacesHrefInput): string {
  const params = new URLSearchParams()
  if (input.task !== undefined && input.task !== null) {
    params.set("task", input.task)
  }
  if (input.q !== undefined && input.q !== null && input.q.length > 0) {
    params.set("q", input.q)
  }
  if (input.page !== undefined && input.page > 1) {
    params.set("page", String(input.page))
  }
  if (input.pageSize !== undefined && input.pageSize !== ADMIN_PLACES_DEFAULT_PAGE_SIZE) {
    params.set("pageSize", String(input.pageSize))
  }
  if (input.selected !== undefined && input.selected !== null && input.selected.length > 0) {
    params.set("selected", input.selected)
  }
  if (input.preview === true) {
    params.set("preview", "1")
  }
  if (input.notice !== undefined && input.notice !== null) {
    params.set("notice", input.notice)
  }
  if (input.confirm !== undefined && input.confirm !== null) {
    params.set("confirm", input.confirm)
  }
  const query = params.toString()
  return query.length > 0 ? `/admin/places?${query}` : "/admin/places"
}
