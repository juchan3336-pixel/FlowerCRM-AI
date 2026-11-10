// 관리자 화면 공통 로딩 경계 — 서버 조회가 끝나기 전에도 메뉴 이동이 즉시 반응하도록 자리표시를 먼저 보여준다.
export default function AdminLoading() {
  return (
    <div aria-busy="true" aria-live="polite" className="flex flex-col gap-6" role="status">
      <span className="sr-only">화면을 불러오는 중입니다</span>
      <div className="h-36 animate-pulse rounded-3xl border border-[var(--border-default)] bg-[var(--surface-secondary)]" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <div className="h-28 animate-pulse rounded-2xl border border-[var(--border-default)] bg-[var(--surface-secondary)]" key={index} />
        ))}
      </div>
    </div>
  )
}
