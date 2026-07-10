import { generateSelectedSampleSeoPagesAction, publishSelectedReadySeoPagesAction } from "./actions"
import { loadAdminSeoPages } from "@/lib/admin/seo-pages"
import type { AdminSeoPagesLoadResult } from "@/lib/admin/seo-pages"

type FilterPlaceholder = {
  readonly label: string
  readonly value: string
  readonly options: readonly string[]
}

export const dynamic = "force-dynamic"

const FILTER_PLACEHOLDERS = [
  { label: "페이지 유형 필터", value: "모든 페이지 유형", options: ["모든 페이지 유형", "area", "funeral", "hospital", "product"] },
  { label: "상태 필터", value: "게시됨", options: ["게시됨", "임시 저장 자리표시자", "보관 자리표시자"] },
  { label: "사이트맵 포함 필터", value: "포함", options: ["포함", "제외 자리표시자"] },
  { label: "canonical 상태 필터", value: "정상", options: ["정상", "누락 자리표시자", "불일치 자리표시자"] },
] as const satisfies readonly FilterPlaceholder[]

export function AdminSeoPagesContent({ seoPages }: Readonly<{ seoPages: AdminSeoPagesLoadResult }>) {
  const sourceLabel = seoPages.source === "supabase" ? "Supabase 공개 안전 뷰" : "로컬 fixture DTO"
  const readyRows = seoPages.rows.filter((row) => row.status === "ready")

  return (
    <section aria-labelledby="admin-seo-pages-title" className="flex flex-col gap-6">
      <header className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-5 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--accent-primary)]">SEO 페이지</p>
        <div className="mt-2 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 id="admin-seo-pages-title" className="text-2xl font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              SEO 페이지 관리 개요
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--text-secondary)]">
              행은 {sourceLabel}에서 불러옵니다. 페이지 라우팅, canonical URL, 사이트맵 포함 여부, 우선순위, 후보 품질, 선택된 롤아웃
              제어만 보여주고 비공개 source 필드는 제외합니다.
            </p>
          </div>
          <span className="w-fit rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2 text-sm font-semibold text-[var(--accent-primary)]">
            선택 롤아웃만
          </span>
        </div>
        <p id="seo-status-placeholder-help" className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
          운영자는 생성 전에 후보 행을, 게시 전에 ready SEO 행을 선택합니다. generate-all 또는 publish-all 동작은 없습니다.
        </p>
      </header>

      <section aria-labelledby="seo-page-filter-title" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
        <div className="flex flex-col gap-1">
          <h3 id="seo-page-filter-title" className="text-lg font-semibold text-[var(--text-primary)]">
            필터 자리표시자만
          </h3>
          <p className="text-sm leading-6 text-[var(--text-secondary)]">
            인증된 query state가 추가되기 전까지는 비활성화된 채로 관리자 필터 구조만 문서화합니다.
          </p>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {FILTER_PLACEHOLDERS.map((filter) => (
            <label className="flex flex-col gap-2 text-sm font-semibold text-[var(--text-primary)]" key={filter.label}>
              {filter.label}
              <select
                className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] px-4 py-3 text-sm font-semibold text-[var(--text-secondary)]"
                disabled
                value={filter.value}
              >
                {filter.options.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </section>

      <section aria-labelledby="candidate-quality-title" className="rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
        <div className="flex flex-col gap-1">
          <h3 id="candidate-quality-title" className="text-lg font-semibold text-[var(--text-primary)]">
            후보 품질
          </h3>
          <p className="text-sm leading-6 text-[var(--text-secondary)]">fixture와 Supabase 후보는 생성에 쓰는 동일한 장소 품질 규칙으로 분류합니다.</p>
        </div>
        <dl className="mt-5 grid gap-3 sm:grid-cols-3">
          <MetricCard label="선택 가능" value={seoPages.candidates.counts.eligible} />
          <MetricCard label="경고" value={seoPages.candidates.counts.warning} />
          <MetricCard label="차단" value={seoPages.candidates.counts.blocked} />
        </dl>
      </section>

      <form action={generateSelectedSampleSeoPagesAction} aria-labelledby="candidate-table-title" className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <div className="flex flex-col gap-4 border-b border-[var(--border-default)] p-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h3 id="candidate-table-title" className="text-lg font-semibold text-[var(--text-primary)]">
              장소 후보
            </h3>
            <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">ready-page 샘플 생성을 위해 선택 가능 또는 경고 후보 5~100개를 고르세요.</p>
          </div>
          <button className="w-fit rounded-full bg-[var(--accent-primary)] px-4 py-2 text-sm font-semibold text-[var(--surface-elevated)]" type="submit">
            선택 샘플 생성
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] border-collapse text-left text-sm">
            <thead className="bg-[var(--surface-secondary)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
              <tr>
                <th className="px-5 py-4" scope="col">선택</th>
                <th className="px-5 py-4" scope="col">장소</th>
                <th className="px-5 py-4" scope="col">카테고리</th>
                <th className="px-5 py-4" scope="col">지역</th>
                <th className="px-5 py-4" scope="col">후보 경로</th>
                <th className="px-5 py-4" scope="col">품질</th>
                <th className="px-5 py-4" scope="col">메모</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-default)]">
              {seoPages.candidates.rows.map((row) => (
                <tr className="text-[var(--text-primary)]" key={row.id}>
                  <td className="px-5 py-4">
                    <input aria-label={`${row.name} 선택`} disabled={row.quality === "blocked"} name="placeId" type="checkbox" value={row.id} />
                  </td>
                  <td className="px-5 py-4 font-semibold">{row.name}</td>
                  <td className="px-5 py-4 text-[var(--text-secondary)]">{row.category}</td>
                  <td className="px-5 py-4 text-[var(--text-secondary)]">{row.location}</td>
                  <td className="px-5 py-4 font-mono text-xs text-[var(--accent-primary)]">{row.path ?? "경로 없음"}</td>
                  <td className="px-5 py-4 text-[var(--accent-primary)]">{row.quality}</td>
                  <td className="px-5 py-4 text-[var(--text-secondary)]">{formatCandidateNotes(row.blockers, row.warnings)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </form>

      <form action={publishSelectedReadySeoPagesAction} aria-labelledby="seo-page-table-title" className="overflow-hidden rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <div className="flex flex-col gap-4 border-b border-[var(--border-default)] p-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
          <h3 id="seo-page-table-title" className="text-lg font-semibold text-[var(--text-primary)]">
            공개 안전 SEO 행
          </h3>
          <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
            행에는 통제된 게시를 위한 ready page가 포함됩니다. 서버 액션은 선택된 ready 행만 허용합니다.
          </p>
          </div>
          <button className="w-fit rounded-full bg-[var(--accent-primary)] px-4 py-2 text-sm font-semibold text-[var(--surface-elevated)]" disabled={readyRows.length === 0} type="submit">
            선택 ready-page 게시
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] border-collapse text-left text-sm">
            <thead className="bg-[var(--surface-secondary)] text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
              <tr>
                <th className="px-5 py-4" scope="col">선택</th>
                <th className="px-5 py-4" scope="col">페이지 유형</th>
                <th className="px-5 py-4" scope="col">경로</th>
                <th className="px-5 py-4" scope="col">canonical URL</th>
                <th className="px-5 py-4" scope="col">상태</th>
                <th className="px-5 py-4" scope="col">사이트맵</th>
                <th className="px-5 py-4" scope="col">우선순위</th>
                <th className="px-5 py-4" scope="col">변경 빈도</th>
                <th className="px-5 py-4" scope="col">canonical 상태</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-default)]">
              {seoPages.rows.map((row) => (
                <tr className="text-[var(--text-primary)]" key={row.id}>
                  <td className="px-5 py-4">
                    <input aria-label={`${row.path} 선택`} disabled={row.status !== "ready"} name="seoPageId" type="checkbox" value={row.id} />
                  </td>
                  <td className="px-5 py-4 font-semibold">{row.type}</td>
                  <td className="px-5 py-4 font-mono text-xs text-[var(--accent-primary)]">{row.path}</td>
                  <td className="px-5 py-4 font-mono text-xs text-[var(--text-secondary)]">{row.canonicalUrl}</td>
                  <td className="px-5 py-4 text-[var(--accent-primary)]">{row.status}</td>
                  <td className="px-5 py-4 text-[var(--accent-primary)]">{row.sitemapState}</td>
                  <td className="px-5 py-4 text-[var(--text-secondary)]">{row.priority}</td>
                  <td className="px-5 py-4 text-[var(--text-secondary)]">{row.changeFrequency}</td>
                  <td className="px-5 py-4 text-[var(--accent-primary)]">{row.canonicalState}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </form>
    </section>
  )
}

function MetricCard({ label, value }: Readonly<{ label: string; value: number }>) {
  return (
    <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)] p-4">
      <dt className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">{label}</dt>
      <dd className="mt-2 text-2xl font-semibold text-[var(--text-primary)]">{value}</dd>
    </div>
  )
}

function formatCandidateNotes(blockers: readonly string[], warnings: readonly string[]): string {
  const notes = [...blockers, ...warnings]
  return notes.length === 0 ? "샘플 생성 가능" : notes.join(", ")
}

async function getAdminSeoPages(): Promise<AdminSeoPagesLoadResult> {
  if (process.env["NEXT_PUBLIC_SUPABASE_URL"] === undefined || process.env["SUPABASE_SERVICE_ROLE_KEY"] === undefined) {
    return loadAdminSeoPages()
  }

  const { createSupabaseAdminSeoPagesRepository } = await import("@/lib/admin/supabase-seo-pages")
  return loadAdminSeoPages(createSupabaseAdminSeoPagesRepository())
}

export default async function AdminSeoPagesPage() {
  return <AdminSeoPagesContent seoPages={await getAdminSeoPages()} />
}
