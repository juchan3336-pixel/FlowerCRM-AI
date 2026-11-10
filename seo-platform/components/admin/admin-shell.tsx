"use client"

import { useState, type ReactNode } from "react"
import Link, { useLinkStatus } from "next/link"
import { usePathname } from "next/navigation"
import { ADMIN_NAV_ITEMS, isAdminNavItemActive, type AdminNavItem } from "./admin-data"
import { AuthBoundaryPlaceholder } from "./auth-boundary"

type AdminShellProps = {
  readonly children: ReactNode
}

// 누른 메뉴에 즉시 진행 표시를 띄운다 — 서버 응답을 기다리는 동안에도 눌렸다는 것이 보이게 한다.
function NavPendingIndicator() {
  const { pending } = useLinkStatus()
  if (!pending) return null
  return (
    <span className="inline-flex items-center" role="status">
      <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--accent-primary)] border-t-transparent" />
      <span className="sr-only">이동 중</span>
    </span>
  )
}

// 일반 <a>는 메뉴를 누를 때마다 문서 전체를 다시 받는다 — Link로 화면 영역만 교체한다.
// 미리 받기는 마우스를 올리거나 포커스한 메뉴에만 켠다. 이때 받는 것은 로딩 자리표시(loading.tsx)까지이고
// 화면의 데이터 조회는 실행되지 않는다. 처음부터 전 메뉴에 켜면 메뉴 수만큼 인증 확인 요청이 먼저 나간다.
// prefetch={true}는 화면 데이터까지 미리 조회하므로 쓰지 않는다.
function AdminNavLink({ item, isActive }: Readonly<{ item: AdminNavItem; isActive: boolean }>) {
  const [intent, setIntent] = useState(false)

  return (
    <Link
      prefetch={intent ? null : false}
      className={`flex items-center justify-between gap-2 rounded-2xl border px-4 py-3 text-sm font-semibold transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]/30 ${
        isActive
          ? "border-[var(--accent-primary)] bg-[var(--surface-primary)] text-[var(--accent-primary)]"
          : "border-[var(--border-default)] bg-[var(--surface-secondary)] text-[var(--text-primary)] hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)]"
      }`}
      href={item.href}
      aria-current={isActive ? "page" : undefined}
      onFocus={() => {
        setIntent(true)
      }}
      onMouseEnter={() => {
        setIntent(true)
      }}
      onTouchStart={() => {
        setIntent(true)
      }}
    >
      {item.label}
      <NavPendingIndicator />
    </Link>
  )
}

export function AdminShell({ children }: AdminShellProps) {
  const pathname = usePathname()

  return (
    <AuthBoundaryPlaceholder>
      <div className="min-h-[100dvh] bg-[var(--surface-primary)] lg:flex">
        <aside className="border-b border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-5 lg:min-h-[100dvh] lg:w-72 lg:border-b-0 lg:border-r lg:px-6 lg:py-6">
          <div className="flex h-full flex-col gap-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-secondary)]">관리자</p>
              <h1 className="mt-2 text-2xl font-semibold tracking-[-0.015em] text-[var(--text-primary)]">SEO 운영 콘솔</h1>
              <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
                장소 데이터와 SEO 게시 상태를 한곳에서 확인하는 운영 화면입니다.
              </p>
            </div>
            <nav aria-label="관리자 네비게이션" className="grid gap-2">
              {ADMIN_NAV_ITEMS.map((item) => {
                // 하위 경로(/admin/batch/new, /admin/batch/<id> 등)에서도 해당 섹션을 활성 표시하되,
                // 형제 메뉴(승인 자동 생성)와 동시에 켜지지 않도록 제외 경로를 함께 판정한다.
                // usePathname 타입은 string이지만 라우터 밖 정적 렌더(테스트)에서는 null이 온다.
                const isActive = isAdminNavItemActive(item, pathname)

                return <AdminNavLink isActive={isActive} item={item} key={item.href} />
              })}
            </nav>
            <button
              className="inline-flex w-fit rounded-full border border-[var(--border-default)] px-4 py-2 text-sm font-semibold text-[var(--text-primary)] transition-colors duration-150 ease-out hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]/30"
              type="button"
              onClick={() => {
                void fetch("/logout", { credentials: "include" }).then(() => {
                  window.location.assign("/login?logged-out=1")
                })
              }}
            >
              로그아웃
            </button>
            <p className="mt-auto text-xs leading-5 text-[var(--text-secondary)]">
              KST 기준 · <span className="whitespace-nowrap">읽기 전용</span>
            </p>
          </div>
        </aside>
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </AuthBoundaryPlaceholder>
  )
}
