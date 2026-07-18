export type PublishEnvironment = "production" | "preview" | "development" | "local"

export type PublishEnvironmentDecision = {
  readonly environment: PublishEnvironment
  readonly allowed: boolean
}

// 게시·보관·복원은 실행된 배포의 캐시만 revalidate할 수 있다 (Vercel ISR 캐시는 배포 간 유지되지만
// on-demand revalidation은 실행 배포 기준). Preview/Development 배포에서 실행하면 DB만 바뀌고
// 운영 공개 페이지 캐시가 갱신되지 않아 stale 404/200이 남으므로 Production 배포에서만 허용한다.
// 로컬 개발(VERCEL_ENV 미설정)은 개발 도구로 간주해 허용하되, 게시 후 공개 URL 검증이 실패를 드러낸다.
export function resolvePublishEnvironment(vercelEnv: string | undefined): PublishEnvironmentDecision {
  if (vercelEnv === "production") {
    return { environment: "production", allowed: true }
  }
  if (vercelEnv === "preview") {
    return { environment: "preview", allowed: false }
  }
  if (vercelEnv === "development") {
    return { environment: "development", allowed: false }
  }
  return { environment: "local", allowed: true }
}
