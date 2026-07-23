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
