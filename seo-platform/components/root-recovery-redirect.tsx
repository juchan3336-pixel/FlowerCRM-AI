"use client"

import { useEffect } from "react"

import { resolveRootRecoveryRedirect } from "@/lib/root-recovery"

// 루트(/)에 도착하는 Supabase 비밀번호 복구 링크를 기존 복구 흐름으로 되돌리는 공통 컴포넌트.
// 화면과 독립이라 어느 표면(관리자 진입·고객용 첫 화면)에서든 같은 처리를 보존한다.
// 판정은 기존 검증 헬퍼 그대로 — 일반 방문은 null이라 리다이렉트가 발생하지 않고, 목적지는 내부 경로뿐이다.
export function RootRecoveryRedirect() {
  useEffect(() => {
    const redirectPath = resolveRootRecoveryRedirect(window.location.hash, window.location.search)
    if (redirectPath !== null) {
      window.location.replace(redirectPath)
    }
  }, [])

  return null
}
