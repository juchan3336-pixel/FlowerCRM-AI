// 루트(/)에 도착하는 Supabase 비밀번호 복구 링크를 reset-password 흐름으로 되돌리는 순수 헬퍼.
// (app/page.tsx에서 재-export — 기존 테스트·호출부 경로 호환)

export function buildRootRecoveryRedirect(hash: string): string | null {
  const hashParams = new URLSearchParams(hash.replace(/^#/, ""))
  if (hashParams.get("type") !== "recovery") {
    return null
  }

  const accessToken = hashParams.get("access_token")
  const refreshToken = hashParams.get("refresh_token")
  if (accessToken === null || accessToken.length === 0) {
    return null
  }
  if (refreshToken === null || refreshToken.length === 0) {
    return null
  }

  return `/reset-password${hash}`
}

export function buildRootCodeRecoveryRedirect(search: string): string | null {
  const searchParams = new URLSearchParams(search.replace(/^\?/, ""))
  const code = searchParams.get("code")
  if (code === null || code.length === 0) {
    return null
  }

  return `/auth/callback?code=${encodeURIComponent(code)}&next=/reset-password`
}

// 루트 도착 URL의 복구 리다이렉트 판정 — hash(recovery 토큰) 우선, 없으면 legacy code.
// 일반 방문(둘 다 해당 없음)은 null — 리다이렉트가 발생하지 않는다.
export function resolveRootRecoveryRedirect(hash: string, search: string): string | null {
  return buildRootRecoveryRedirect(hash) ?? buildRootCodeRecoveryRedirect(search)
}

// 루트 화면의 환경 배지 라벨 — Production에서는 배지를 노출하지 않는다 (null).
export function resolveRootEnvironmentLabel(vercelEnv: string | undefined): string | null {
  if (vercelEnv === "production") {
    return null
  }
  if (vercelEnv === "preview") {
    return "Preview 환경"
  }
  if (vercelEnv === "development") {
    return "Development 환경"
  }
  return "로컬 개발"
}
