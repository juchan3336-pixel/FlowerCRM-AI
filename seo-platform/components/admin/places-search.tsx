"use client"

import { useRouter } from "next/navigation"
import { createContext, useContext, useMemo, useTransition, type ReactNode } from "react"

import { buildAdminPlacesHref } from "@/lib/admin/places-url"
import type { AdminPlacesWorkspaceParams } from "@/lib/admin/places-url"

type PlacesSearchPendingContextValue = {
  readonly isPending: boolean
  readonly navigate: (href: string) => void
}

const PlacesSearchPendingContext = createContext<PlacesSearchPendingContextValue>({ isPending: false, navigate: () => undefined })

// 검색 폼(헤더)과 결과 영역(테이블)이 같은 pending 상태를 공유한다. children은 서버 렌더 결과 그대로 전달된다.
export function PlacesSearchPendingProvider({ children }: Readonly<{ children: ReactNode }>) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const value = useMemo<PlacesSearchPendingContextValue>(
    () => ({
      isPending,
      navigate: (href: string) => {
        startTransition(() => {
          router.push(href)
        })
      },
    }),
    [isPending, router],
  )

  return <PlacesSearchPendingContext.Provider value={value}>{children}</PlacesSearchPendingContext.Provider>
}

export function PlacesSearchForm({ params }: Readonly<{ params: AdminPlacesWorkspaceParams }>) {
  const { isPending, navigate } = useContext(PlacesSearchPendingContext)

  const submit = (formData: FormData) => {
    if (isPending) {
      return
    }
    const qValue = formData.get("q")
    const q = typeof qValue === "string" && qValue.trim().length > 0 ? qValue.trim() : null
    navigate(buildAdminPlacesHref({ q, task: params.task, pageSize: params.pageSize, selected: params.selected }))
  }

  const reset = () => {
    if (isPending) {
      return
    }
    navigate(buildAdminPlacesHref({ task: params.task, pageSize: params.pageSize, selected: params.selected }))
  }

  return <PlacesSearchFormView isPending={isPending} onReset={reset} onSubmit={submit} q={params.q} />
}

// 프레젠테이션 분리 — pending 상태 렌더링을 테스트에서 직접 검증할 수 있게 한다.
export function PlacesSearchFormView({
  isPending,
  onReset,
  onSubmit,
  q,
}: Readonly<{
  isPending: boolean
  onReset?: () => void
  onSubmit?: (formData: FormData) => void
  q: string | null
}>) {
  return (
    <form action={onSubmit} aria-busy={isPending} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
      <input
        aria-label="장소 검색"
        className="w-full rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-5 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus-visible:border-[var(--accent-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]/30 sm:max-w-md"
        defaultValue={q ?? ""}
        name="q"
        placeholder="장소명, 주소, 지역, 카테고리, 슬러그 검색"
        type="search"
      />
      <div className="flex items-center gap-3">
        <button
          className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent-primary)] px-5 py-3 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]/40 disabled:cursor-not-allowed disabled:opacity-70"
          disabled={isPending}
          type="submit"
        >
          {isPending ? (
            <>
              <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              검색 중...
            </>
          ) : (
            "검색"
          )}
        </button>
        {q !== null ? (
          <button
            className="text-sm font-semibold text-[var(--text-secondary)] transition-colors duration-150 hover:text-[var(--accent-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]/30 disabled:cursor-not-allowed disabled:opacity-70"
            disabled={isPending}
            onClick={onReset}
            type="button"
          >
            검색 초기화
          </button>
        ) : null}
      </div>
      <p aria-live="polite" className="sr-only" role="status">
        {isPending ? "검색 결과를 불러오는 중입니다." : ""}
      </p>
    </form>
  )
}

export function PlacesSearchResultsRegion({ children }: Readonly<{ children: ReactNode }>) {
  const { isPending } = useContext(PlacesSearchPendingContext)

  return (
    <div aria-busy={isPending} className={`transition-opacity duration-150 ${isPending ? "pointer-events-none opacity-60" : ""}`}>
      {children}
    </div>
  )
}
