"use client"

import Link from "next/link"
import { useEffect } from "react"

import { buildRootCodeRecoveryRedirect, buildRootRecoveryRedirect } from "@/lib/root-recovery"

// 루트 진입 화면 — 관리자 로그인·SEO 운영 콘솔 진입 버튼만 제공한다.
// 'SEO 운영 콘솔'은 /admin 직결: 비로그인은 미들웨어가 /login?next=/admin으로 보내고,
// 로그인된 관리자는 바로 대시보드로 진입한다 (인증·세션 로직 무변경).
export function RootEntry({ environmentLabel }: Readonly<{ environmentLabel: string | null }>) {
  // 비밀번호 복구 링크가 루트로 도착하면 기존 복구 흐름으로 되돌린다 (기능 유지).
  useEffect(() => {
    const redirectPath = buildRootRecoveryRedirect(window.location.hash) ?? buildRootCodeRecoveryRedirect(window.location.search)
    if (redirectPath !== null) {
      window.location.replace(redirectPath)
    }
  }, [])

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-[var(--surface-primary)] px-4 py-12">
      <section className="w-full max-w-xl rounded-3xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6 text-center shadow-sm sm:p-10">
        {environmentLabel !== null ? (
          <p className="mx-auto w-fit rounded-full border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 px-3 py-1 text-xs font-semibold text-[var(--status-warning)]">
            {environmentLabel}
          </p>
        ) : null}
        <p className={`text-xs font-semibold uppercase tracking-[0.08em] text-[var(--accent-primary)] ${environmentLabel !== null ? "mt-4" : ""}`}>전국팔도플라워</p>
        <h1 className="mt-2 text-3xl font-bold tracking-[-0.02em] text-[var(--text-primary)] sm:text-4xl">팔도플라워 SEO Platform</h1>
        <p className="mt-4 text-sm leading-6 text-[var(--text-secondary)] sm:text-base">
          장소 SEO 콘텐츠의 생성·게시·운영을 관리하는 내부 플랫폼입니다. 관리자 전용 서비스로, 일반 방문자용 페이지가 아닙니다.
        </p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Link
            className="inline-flex items-center justify-center rounded-full bg-[var(--accent-primary)] px-6 py-3 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90"
            href="/login"
          >
            관리자 로그인
          </Link>
          <Link
            className="inline-flex items-center justify-center rounded-full border border-[var(--accent-primary)] px-6 py-3 text-sm font-semibold text-[var(--accent-primary)] transition-colors duration-150 hover:bg-[var(--accent-primary)]/10"
            href="/admin"
          >
            SEO 운영 콘솔
          </Link>
        </div>
        <p className="mt-6 text-xs leading-5 text-[var(--text-secondary)]">로그인하지 않은 상태로 콘솔에 진입하면 로그인 화면으로 이동합니다.</p>
      </section>
    </main>
  )
}
