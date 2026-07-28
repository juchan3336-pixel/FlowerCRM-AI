"use client"

import { useRouter } from "next/navigation"
import { useTransition } from "react"

// 장소관리 헤더의 "AI 일괄 생성"·"일괄 게시"는 다른 화면으로 이동하는 액션이다.
// 기존에는 plain <Link>라 클릭 후 이동이 끝날 때까지 아무 진행 표시가 없어 멈춘 것처럼 보였다.
// 여기서는 네비게이션 pending(useTransition)에 스피너를 묶어 이동 중임을 회전으로 보여주고,
// 이동이 끝나면(이 컴포넌트가 언마운트) 자동 해제된다 — 수동 set-only로 너무 빨리 끄지 않는다.
export type NavActionButtonVariant = "primary" | "secondary"

export function NavActionButton({
  href,
  label,
  title,
  variant,
}: Readonly<{ href: string; label: string; title?: string; variant: NavActionButtonVariant }>) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const onActivate = () => {
    // 처리 중 중복 클릭 차단 — 같은 이동을 다시 밀어 넣지 않는다.
    if (isPending) {
      return
    }
    startTransition(() => {
      router.push(href)
    })
  }

  return <NavActionButtonView isPending={isPending} label={label} onActivate={onActivate} variant={variant} {...(title === undefined ? {} : { title })} />
}

// 프레젠테이션 분리 — pending 상태 렌더링(스피너 회전·중복 클릭 차단·접근성)을 테스트에서 직접 검증한다.
export function NavActionButtonView({
  isPending,
  label,
  onActivate,
  title,
  variant,
}: Readonly<{ isPending: boolean; label: string; onActivate?: () => void; title?: string; variant: NavActionButtonVariant }>) {
  const base =
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]/40 disabled:cursor-not-allowed disabled:opacity-70"
  const variantClass =
    variant === "primary"
      ? "bg-[var(--accent-primary)] text-white transition-opacity duration-150 hover:opacity-90"
      : "border border-[var(--accent-primary)] text-[var(--accent-primary)] transition-colors duration-150 hover:bg-[var(--accent-primary)]/10"
  // 스피너 대비: primary는 흰색, secondary는 강조색. animate-spin은 disabled여도 계속 회전한다.
  const spinnerClass = variant === "primary" ? "border-white/40 border-t-white" : "border-[var(--accent-primary)]/40 border-t-[var(--accent-primary)]"

  return (
    <button aria-busy={isPending} className={`${base} ${variantClass}`} disabled={isPending} onClick={onActivate} title={title} type="button">
      {isPending ? <span aria-hidden className={`size-4 animate-spin rounded-full border-2 ${spinnerClass}`} /> : null}
      <span>{label}</span>
      {/* 스피너는 aria-hidden이므로 진행 상태는 버튼 접근성 이름으로 전달한다. */}
      {isPending ? <span className="sr-only">이동 중…</span> : null}
    </button>
  )
}
