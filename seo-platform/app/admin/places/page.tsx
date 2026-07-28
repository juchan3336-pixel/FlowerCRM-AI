import Link from "next/link"

import { NavActionButton } from "@/components/admin/nav-action-button"
import { PlaceDetailDrawer } from "@/components/admin/place-detail-drawer"
import { PlaceRowItem } from "@/components/admin/place-row"
import { PlacesSearchForm, PlacesSearchPendingProvider, PlacesSearchResultsRegion } from "@/components/admin/places-search"
import type { AdminPlaceDetailResult } from "@/lib/admin/place-detail"
import { loadAdminPlaceDetail } from "@/lib/admin/place-detail"
import {
  buildAdminPlacesWorkspaceErrorResult,
  loadAdminPlacesWorkspace,
  resolveSupabaseUrlHostOrRef,
} from "@/lib/admin/places"
import type { AdminPlacesTaskFilterKey, AdminPlacesWorkspaceResult } from "@/lib/admin/places"
import { buildAdminPlacesHref, resolveAdminPlacesWorkspaceParams, type AdminPlacesWorkspaceParams } from "@/lib/admin/places-url"

export const dynamic = "force-dynamic"
// 게시 서버 액션(RPC + revalidate + 공개 URL 확인)이 함수 실행 제한에 걸려 응답이 유실되지 않도록 여유를 둔다.
export const maxDuration = 30

export type AdminPlacesWorkspaceCounts = {
  readonly total: number | null
  readonly aiMissing: number | null
  readonly publishPending: number | null
  readonly published: number | null
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
  detail = null,
}: Readonly<{
  workspace: AdminPlacesWorkspaceResult
  counts: AdminPlacesWorkspaceCounts
  params: AdminPlacesWorkspaceParams
  detail?: AdminPlaceDetailResult | null
}>) {
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
    <PlacesSearchPendingProvider>
    <section aria-labelledby="admin-places-title" className="flex flex-col gap-6">
      <header className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">운영</p>
        <div className="mt-2 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 id="admin-places-title" className="text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              장소관리
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">
              전체 장소를 검색하고 AI 생성부터 게시 준비까지 처리하는 SEO 운영 작업 공간입니다. 장소명을 누르면 상세 작업 화면이 열립니다.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* 승인 1회로 서버가 이어서 생성하는 자동 흐름 — 기존 수동 흐름과 라벨로 구분한다(수동 경로는 fallback으로 유지).
                버튼은 화면 이동일 뿐이며, 생성은 다음 화면에서 승인해야 시작된다. */}
            <NavActionButton
              href="/admin/batch/approve"
              label="승인 자동 생성"
              title="공식 검증 장소를 승인해 자동 생성 (누르면 승인 화면으로 이동)"
              variant="primary"
            />
            <NavActionButton href="/admin/batch/new" label="수동 AI 일괄 생성" title="기존 수동 Batch 생성" variant="secondary" />
            <NavActionButton href="/admin/batch/publish/new" label="일괄 게시" title="생성 완료 페이지 게시" variant="secondary" />
            <p className="whitespace-nowrap rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2 text-sm font-semibold text-[var(--text-primary)]">
              {rangeLabel}
            </p>
          </div>
        </div>

        <nav aria-label="작업 필터" className="mt-5 flex flex-wrap gap-2">
          {chips.map((chip) => {
            const isActive = params.task === chip.key
            return (
              <Link
                key={chip.key ?? "all"}
                href={buildAdminPlacesHref({ task: chip.key, q: params.q, pageSize: params.pageSize, selected: params.selected })}
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

        <PlacesSearchForm params={params} />
      </header>

      <PlacesSearchResultsRegion>
      <section aria-labelledby="admin-places-table-title" className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <div className="flex flex-col gap-1 border-b border-[var(--border-default)] p-5 sm:flex-row sm:items-center sm:justify-between">
          <h3 id="admin-places-table-title" className="text-lg font-semibold text-[var(--text-primary)]">
            장소 목록
          </h3>
          <p className="text-sm leading-6 text-[var(--text-secondary)]">{rangeLabel}</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] border-collapse text-left text-sm">
            <thead className="bg-[var(--surface-secondary)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
              <tr>
                <th className="w-12 px-3 py-4 text-right" scope="col">No.</th>
                <th className="px-5 py-4" scope="col">장소명</th>
                <th className="px-5 py-4" scope="col">카테고리</th>
                <th className="px-5 py-4" scope="col">지역</th>
                <th className="px-5 py-4" scope="col">상태</th>
                <th className="px-5 py-4" scope="col">AI 상태</th>
                <th className="px-5 py-4" scope="col">SEO 상태</th>
                <th className="px-5 py-4" scope="col">게시일시</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-default)]">
              {isError ? (
                <tr>
                  <td colSpan={8} className="px-5 py-10 text-center text-sm leading-6 text-[var(--text-secondary)]">
                    데이터를 불러오지 못했습니다. 아래 연결 진단에서 오류 내용을 확인하세요.
                  </td>
                </tr>
              ) : workspace.rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-5 py-10 text-center text-sm leading-6 text-[var(--text-secondary)]">
                    검색 결과가 없습니다. 검색어나 필터를 바꿔 보세요.{" "}
                    <Link className="font-semibold text-[var(--accent-primary)]" href="/admin/places">
                      전체 목록 보기
                    </Link>
                  </td>
                </tr>
              ) : (
                workspace.rows.map((row, index) => (
                  <PlaceRowItem
                    key={row.id}
                    row={row}
                    seq={workspace.offset + index + 1}
                    isSelected={params.selected === row.id}
                    href={buildAdminPlacesHref({ q: params.q, task: params.task, page: params.page, pageSize: params.pageSize, selected: row.id })}
                  />
                ))
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
                href={buildAdminPlacesHref({ task: params.task, q: params.q, pageSize: params.pageSize, page: params.page - 1, selected: params.selected })}
                label="이전"
              />
              <PageLink
                disabled={params.page >= totalPages}
                href={buildAdminPlacesHref({ task: params.task, q: params.q, pageSize: params.pageSize, page: params.page + 1, selected: params.selected })}
                label="다음"
              />
            </div>
          </nav>
        ) : null}
      </section>
      </PlacesSearchResultsRegion>

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

      {params.selected !== null && detail !== null ? <PlaceDetailDrawer detail={detail} params={params} /> : null}
    </section>
    </PlacesSearchPendingProvider>
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

async function getAdminPlaceDetail(placeId: string): Promise<AdminPlaceDetailResult> {
  const hasLiveSupabaseEnv = process.env["NEXT_PUBLIC_SUPABASE_URL"] !== undefined && process.env["SUPABASE_SERVICE_ROLE_KEY"] !== undefined
  if (!hasLiveSupabaseEnv) {
    return { kind: "error", message: "environment missing" }
  }

  try {
    const { createSupabaseAdminPlaceDetailRepository } = await import("@/lib/admin/supabase-place-detail")
    const result = await loadAdminPlaceDetail(createSupabaseAdminPlaceDetailRepository(), placeId)
    return await reverifyDelayedVerificationSafely(result)
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : "unknown error" }
  }
}

// 드로어 진입 시 delayed 상태만 1회 재확인한다 — 200이면 verified, 여전히 비정상이면 failed(운영 확인 필요).
// 재확인 실패(네트워크 등)가 드로어 표시를 깨지 않도록 안전 처리한다.
async function reverifyDelayedVerificationSafely(result: AdminPlaceDetailResult): Promise<AdminPlaceDetailResult> {
  if (result.kind !== "found") {
    return result
  }
  const seoPage = result.detail.seoPage
  if (seoPage?.status !== "published" || seoPage.verificationStatus !== "delayed") {
    return result
  }
  try {
    const [{ reverifyDelayedSeoPage }, { createSupabaseVerificationRepository }, { getSiteUrl }] = await Promise.all([
      import("@/lib/seo-pages/publish-verification"),
      import("@/lib/seo-pages/supabase-verification"),
      import("@/lib/site-url"),
    ])
    const status = await reverifyDelayedSeoPage({
      path: seoPage.path,
      url: `${getSiteUrl()}${seoPage.path}`,
      repository: createSupabaseVerificationRepository(),
    })
    return { kind: "found", detail: { ...result.detail, seoPage: { ...seoPage, verificationStatus: status } } }
  } catch (error) {
    console.error("[publish-verification] delayed recheck failed", { path: seoPage.path, error: error instanceof Error ? error.message : String(error) })
    return result
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

export default async function AdminPlacesPage(props: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const searchParams = await props.searchParams
  const params = resolveAdminPlacesWorkspaceParams(searchParams)
  const [{ workspace, counts }, detail] = await Promise.all([
    getAdminPlacesWorkspace(params),
    params.selected === null ? Promise.resolve(null) : getAdminPlaceDetail(params.selected),
  ])
  return <AdminPlacesContent workspace={workspace} counts={counts} params={params} detail={detail} />
}
