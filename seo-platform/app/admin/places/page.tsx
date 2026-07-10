import Link from "next/link"

import { PlaceRowItem } from "@/components/admin/place-row"
import {
  buildAdminPlacesWorkspaceErrorResult,
  loadAdminPlacesWorkspace,
  resolveSupabaseUrlHostOrRef,
} from "@/lib/admin/places"
import type { AdminPlacesTaskFilterKey, AdminPlacesWorkspaceResult } from "@/lib/admin/places"

export const dynamic = "force-dynamic"

export const ADMIN_PLACES_PAGE_SIZES = [50, 100, 200] as const
export const ADMIN_PLACES_DEFAULT_PAGE_SIZE = 50

export type AdminPlacesWorkspaceParams = {
  readonly q: string | null
  readonly task: AdminPlacesTaskFilterKey | null
  readonly page: number
  readonly pageSize: number
}

export type AdminPlacesWorkspaceCounts = {
  readonly total: number | null
  readonly aiMissing: number | null
  readonly publishPending: number | null
  readonly published: number | null
}

const TASK_FILTER_KEYS = ["ai-missing", "publish-pending", "published"] as const

export function resolveAdminPlacesWorkspaceParams(searchParams: Record<string, string | string[] | undefined>): AdminPlacesWorkspaceParams {
  const q = readSingleParam(searchParams["q"])?.trim().slice(0, 100) ?? null
  const taskCandidate = readSingleParam(searchParams["task"])
  const pageCandidate = Number.parseInt(readSingleParam(searchParams["page"]) ?? "", 10)
  const pageSizeCandidate = Number.parseInt(readSingleParam(searchParams["pageSize"]) ?? "", 10)

  return {
    q: q !== null && q.length > 0 ? q : null,
    task: (TASK_FILTER_KEYS as readonly string[]).includes(taskCandidate ?? "") ? (taskCandidate as AdminPlacesTaskFilterKey) : null,
    page: Number.isInteger(pageCandidate) && pageCandidate >= 1 ? pageCandidate : 1,
    pageSize: (ADMIN_PLACES_PAGE_SIZES as readonly number[]).includes(pageSizeCandidate) ? pageSizeCandidate : ADMIN_PLACES_DEFAULT_PAGE_SIZE,
  }
}

export function buildAdminPlacesHref(input: Readonly<{ q?: string | null; task?: AdminPlacesTaskFilterKey | null; page?: number; pageSize?: number }>): string {
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
  const query = params.toString()
  return query.length > 0 ? `/admin/places?${query}` : "/admin/places"
}

type FilterChip = {
  readonly key: AdminPlacesTaskFilterKey | null
  readonly label: string
  readonly count: number | null
}

export function AdminPlacesContent({
  workspace,
  counts,
  params,
}: Readonly<{ workspace: AdminPlacesWorkspaceResult; counts: AdminPlacesWorkspaceCounts; params: AdminPlacesWorkspaceParams }>) {
  const isError = workspace.source === "error"
  const chips: readonly FilterChip[] = [
    { key: null, label: "전체", count: counts.total },
    { key: "ai-missing", label: "AI 생성 안됨", count: counts.aiMissing },
    { key: "publish-pending", label: "게시 대기", count: counts.publishPending },
    { key: "published", label: "게시 완료", count: counts.published },
  ]
  const shownStart = workspace.total === 0 ? 0 : workspace.offset + 1
  const shownEnd = Math.min(workspace.offset + workspace.rows.length, workspace.total)
  const totalPages = Math.max(Math.ceil(workspace.total / workspace.limit), 1)
  const rangeLabel = isError
    ? "오류"
    : workspace.total === 0
      ? "0건"
      : `${workspace.total.toLocaleString("ko-KR")}건 중 ${shownStart.toLocaleString("ko-KR")}–${shownEnd.toLocaleString("ko-KR")} 표시`

  return (
    <section aria-labelledby="admin-places-title" className="flex flex-col gap-6">
      <header className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">운영</p>
        <div className="mt-2 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 id="admin-places-title" className="text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              장소관리
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">
              전체 장소를 검색하고 AI 생성·게시 상태를 확인하는 SEO 운영 작업 공간입니다. 행을 누르면 상세 정보가 열립니다.
            </p>
          </div>
          <p className="whitespace-nowrap rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2 text-sm font-semibold text-[var(--text-primary)]">
            {rangeLabel}
          </p>
        </div>

        <nav aria-label="작업 필터" className="mt-5 flex flex-wrap gap-2">
          {chips.map((chip) => {
            const isActive = params.task === chip.key
            return (
              <Link
                key={chip.key ?? "all"}
                href={buildAdminPlacesHref({ task: chip.key, q: params.q, pageSize: params.pageSize })}
                aria-current={isActive ? "page" : undefined}
                className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]/30 ${
                  isActive
                    ? "border-[var(--accent-primary)] bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]"
                    : "border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)]"
                }`}
              >
                {chip.label}
                <span className="font-mono text-xs">{chip.count === null ? "—" : chip.count.toLocaleString("ko-KR")}</span>
              </Link>
            )
          })}
        </nav>

        <form action="/admin/places" method="get" className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          {params.task !== null ? <input type="hidden" name="task" value={params.task} /> : null}
          {params.pageSize !== ADMIN_PLACES_DEFAULT_PAGE_SIZE ? <input type="hidden" name="pageSize" value={String(params.pageSize)} /> : null}
          <input
            aria-label="장소 검색"
            className="w-full rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-5 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus-visible:border-[var(--accent-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]/30 sm:max-w-md"
            defaultValue={params.q ?? ""}
            name="q"
            placeholder="장소명, 주소, 지역, 카테고리, 슬러그 검색"
            type="search"
          />
          <div className="flex items-center gap-3">
            <button
              className="rounded-full bg-[var(--accent-primary)] px-5 py-3 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90"
              type="submit"
            >
              검색
            </button>
            {params.q !== null ? (
              <Link
                className="text-sm font-semibold text-[var(--text-secondary)] transition-colors duration-150 hover:text-[var(--accent-primary)]"
                href={buildAdminPlacesHref({ task: params.task, pageSize: params.pageSize })}
              >
                검색 초기화
              </Link>
            ) : null}
          </div>
        </form>
      </header>

      <section aria-labelledby="admin-places-table-title" className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <div className="flex flex-col gap-1 border-b border-[var(--border-default)] p-5 sm:flex-row sm:items-center sm:justify-between">
          <h3 id="admin-places-table-title" className="text-lg font-semibold text-[var(--text-primary)]">
            장소 목록
          </h3>
          <p className="text-sm leading-6 text-[var(--text-secondary)]">{rangeLabel}</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] border-collapse text-left text-sm">
            <thead className="bg-[var(--surface-secondary)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
              <tr>
                <th className="px-5 py-4" scope="col">장소명</th>
                <th className="px-5 py-4" scope="col">카테고리</th>
                <th className="px-5 py-4" scope="col">지역</th>
                <th className="px-5 py-4" scope="col">상태</th>
                <th className="px-5 py-4" scope="col">AI 상태</th>
                <th className="px-5 py-4" scope="col">SEO 상태</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-default)]">
              {isError ? (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-sm leading-6 text-[var(--text-secondary)]">
                    데이터를 불러오지 못했습니다. 아래 연결 진단에서 오류 내용을 확인하세요.
                  </td>
                </tr>
              ) : workspace.rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-sm leading-6 text-[var(--text-secondary)]">
                    검색 결과가 없습니다. 검색어나 필터를 바꿔 보세요.{" "}
                    <Link className="font-semibold text-[var(--accent-primary)]" href="/admin/places">
                      전체 목록 보기
                    </Link>
                  </td>
                </tr>
              ) : (
                workspace.rows.map((row) => <PlaceRowItem key={row.id} row={row} />)
              )}
            </tbody>
          </table>
        </div>
        {!isError && workspace.total > 0 ? (
          <nav aria-label="페이지 이동" className="flex flex-col gap-3 border-t border-[var(--border-default)] p-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-[var(--text-secondary)]">
              페이지 {Math.min(params.page, totalPages).toLocaleString("ko-KR")} / {totalPages.toLocaleString("ko-KR")}
            </p>
            <div className="flex items-center gap-2">
              <PageLink
                disabled={params.page <= 1}
                href={buildAdminPlacesHref({ task: params.task, q: params.q, pageSize: params.pageSize, page: params.page - 1 })}
                label="이전"
              />
              <PageLink
                disabled={params.page >= totalPages}
                href={buildAdminPlacesHref({ task: params.task, q: params.q, pageSize: params.pageSize, page: params.page + 1 })}
                label="다음"
              />
            </div>
          </nav>
        ) : null}
      </section>

      <details className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
        <summary className="cursor-pointer text-sm font-semibold text-[var(--text-secondary)]">연결 진단</summary>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <DiagnosticsCard label="데이터 소스" value={workspace.diagnostics.dataSource === "live" ? "실시간" : "오류"} />
          <DiagnosticsCard label="조건에 맞는 장소 수" value={formatCount(workspace.diagnostics.placesQueryCount)} />
          <DiagnosticsCard label="SEO 페이지 수" value={formatCount(workspace.diagnostics.seoPagesPlaceCount)} />
          <DiagnosticsCard label="연결 대상" value={workspace.diagnostics.supabaseUrlHostOrRef ?? "—"} />
          <DiagnosticsCard label="오류 내용" value={formatQueryError(workspace.diagnostics.queryErrorCode, workspace.diagnostics.queryErrorMessage)} />
          <DiagnosticsCard label="최근 조회 시각" value={workspace.diagnostics.lastQueriedAt} />
        </dl>
      </details>
    </section>
  )
}

function PageLink({ href, label, disabled }: Readonly<{ href: string; label: string; disabled: boolean }>) {
  if (disabled) {
    return (
      <span aria-disabled className="rounded-full border border-[var(--border-default)] px-4 py-2 text-sm font-semibold text-[var(--text-secondary)] opacity-50">
        {label}
      </span>
    )
  }

  return (
    <Link
      className="rounded-full border border-[var(--border-default)] px-4 py-2 text-sm font-semibold text-[var(--text-primary)] transition-colors duration-150 ease-out hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]/30"
      href={href}
    >
      {label}
    </Link>
  )
}

async function getAdminPlacesWorkspace(params: AdminPlacesWorkspaceParams): Promise<Readonly<{ workspace: AdminPlacesWorkspaceResult; counts: AdminPlacesWorkspaceCounts }>> {
  const hasLiveSupabaseEnv = process.env["NEXT_PUBLIC_SUPABASE_URL"] !== undefined && process.env["SUPABASE_SERVICE_ROLE_KEY"] !== undefined
  const supabaseUrlHostOrRef = resolveSupabaseUrlHostOrRef(process.env["NEXT_PUBLIC_SUPABASE_URL"])
  const query = {
    search: params.q,
    task: params.task,
    offset: (params.page - 1) * params.pageSize,
    limit: params.pageSize,
  }
  const emptyCounts: AdminPlacesWorkspaceCounts = { total: null, aiMissing: null, publishPending: null, published: null }

  if (!hasLiveSupabaseEnv && process.env.NODE_ENV !== "production") {
    return { workspace: await loadAdminPlacesWorkspace({}, query, { supabaseUrlHostOrRef }), counts: emptyCounts }
  }

  try {
    const { createSupabaseAdminPlacesRepository } = await import("@/lib/admin/supabase-places")
    const repository = createSupabaseAdminPlacesRepository()
    const [workspace, total, aiMissing, publishPending, published] = await Promise.all([
      loadAdminPlacesWorkspace({ places: repository }, query, { supabaseUrlHostOrRef }),
      tryCount(() => repository.countPlaces()),
      tryCount(() => repository.countPlacesMissingAiContent?.()),
      tryCount(() => repository.countReadyPlaceSeoPages?.()),
      tryCount(() => repository.countPublishedPlaceSeoPages?.()),
    ])
    return { workspace, counts: { total, aiMissing, publishPending, published } }
  } catch (error) {
    return { workspace: buildAdminPlacesWorkspaceErrorResult(error, query, { supabaseUrlHostOrRef }), counts: emptyCounts }
  }
}

async function tryCount(count: () => Promise<number> | undefined): Promise<number | null> {
  try {
    return (await count()) ?? null
  } catch {
    return null
  }
}

function DiagnosticsCard({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4">
      <dt className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">{label}</dt>
      <dd className="mt-2 break-words text-sm font-semibold text-[var(--text-primary)]">{value}</dd>
    </div>
  )
}

function formatCount(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("ko-KR")
}

function formatQueryError(code: string | null, message: string | null): string {
  if (code === null && message === null) {
    return "—"
  }

  if (code === null) {
    return message ?? "—"
  }

  if (message === null) {
    return code
  }

  return `${code}: ${message}`
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

export default async function AdminPlacesPage(props: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const searchParams = await props.searchParams
  const params = resolveAdminPlacesWorkspaceParams(searchParams)
  const { workspace, counts } = await getAdminPlacesWorkspace(params)
  return <AdminPlacesContent workspace={workspace} counts={counts} params={params} />
}
